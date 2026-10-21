// fnaf-scene.mjs — THREE side of the FNAF modes. Builds each mode's world
// lazily (so the default room pays nothing until a FNAF mode is chosen), applies
// the engine snapshot to it every frame, routes world clicks back through
// applyPress, and renders scares. Entity motion, light and sound only: this
// module never moves the camera.

import { createOffice } from "./fnaf/world/office.mjs";
import { createRooms } from "./fnaf/world/rooms.mjs";
import { createCameraFeed } from "./fnaf/world/camera-feed.mjs";
import { createSpaceFnaf2 } from "./fnaf/world/space-fnaf2.mjs";
import { createSpaceFnaf3 } from "./fnaf/world/space-fnaf3.mjs";
import { createSpaceFnaf4 } from "./fnaf/world/space-fnaf4.mjs";
import { CHARACTER_IDS, createCharacter } from "./fnaf/world/characters.mjs";
import { createExtraCharacter } from "./fnaf/world/characters-extra.mjs";
import { FnafAudio } from "./fnaf/audio/fnaf-audio.mjs";
import { scareModelFor } from "./fnaf-session.mjs";

// Where the player's eye sits in each mode's space (the room rig is reset to
// the origin while a FNAF mode is active).
export const EYE = Object.freeze({
  fnaf1: { x: 0, y: 1.2, z: 0 },
  fnaf2: { x: 0, y: 1.2, z: 0 },
  fnaf3: { x: 0, y: 1.2, z: 0 },
  fnaf4: { x: 0, y: 1.1, z: 0.25 },
});

// Where a scare victim stands before its lunge (in front of the eye, facing it).
const SCARE_SPOT = Object.freeze({
  fnaf1: { x: 0, z: -2.6 },
  fnaf2: { x: 0, z: -2.6 },
  fnaf3: { x: 0, z: -2.6 },
  fnaf4: { x: 0, z: -1.6 },
});

const SIDE_OF = { bellwether: "left", lark: "right", maestro: "right", ratchet: "right" };

export function createFnafWorld(THREE, renderer, scene, { materials = {}, audioEngine = null, onPress = () => {} } = {}) {
  const worlds = {};
  let mode = null;
  let fa = null;
  let scare = null; // { model, mode }
  let cutLeft = 0; // seconds of light cut remaining
  let cutSaved = null; // Map(light -> intensity) while the cut is active
  let cutLights = []; // lights owned by the active world
  let lastLure = null;

  const audio = () => {
    if (!fa && audioEngine) fa = new FnafAudio(audioEngine);
    return fa;
  };

  function claimNew(build) {
    const before = new Set(scene.children);
    const api = build();
    const roots = scene.children.filter((o) => !before.has(o));
    const lights = [];
    for (const r of roots) r.traverse((o) => { if (o.isLight) lights.push(o); });
    return { api, roots, lights };
  }

  function buildFnaf1() {
    const built = claimNew(() => {
      const office = createOffice(THREE, scene, { materials });
      const rooms = createRooms(THREE, scene);
      const feed = createCameraFeed(THREE, renderer, scene, rooms, { audioOnlyRooms: ["kitchen"], disabledRooms: ["kitchen"] });
      office.setMonitorTextures(feed.texture, feed.getMapTexture());
      return { office, rooms, feed };
    });
    const { office, rooms, feed } = built.api;
    office.on("press", (ev) => {
      if (ev.id === "monitor-map") return; // handled through camera-pick
      onPress("fnaf1", ev.id, ev);
    });
    office.on("press-dead", (ev) => onPress("fnaf1", "dead", ev));
    office.on("camera-pick", (ev) => {
      const room = feed.pickCameraAt(ev.uv);
      if (room) onPress("fnaf1", "camera", { room });
    });
    return { kind: "fnaf1", ...built, office, rooms, feed, interactables: office.interactables };
  }

  function buildSpace(kind, factory) {
    const built = claimNew(() => factory(THREE, scene, { materials, onInteract: (id, info) => onPress(kind, id, info) }));
    return { kind, ...built, space: built.api, interactables: built.api.interactables };
  }

  function world(m) {
    if (!worlds[m]) {
      worlds[m] =
        m === "fnaf1" ? buildFnaf1()
          : m === "fnaf2" ? buildSpace("fnaf2", createSpaceFnaf2)
            : m === "fnaf3" ? buildSpace("fnaf3", createSpaceFnaf3)
              : buildSpace("fnaf4", createSpaceFnaf4);
    }
    return worlds[m];
  }

  function setRootsVisible(w, on) {
    for (const r of w.roots) r.visible = on;
  }

  /** Make `m` the active FNAF world. Returns the eye position for the rig. */
  function enter(m) {
    if (!EYE[m]) throw new Error(`unknown FNAF mode ${m}`);
    if (mode && mode !== m) setRootsVisible(worlds[mode], false);
    const w = world(m);
    setRootsVisible(w, true);
    mode = m;
    cutLights = w.lights;
    audio()?.setAmbience(m === "fnaf1" ? "office1" : m === "fnaf4" ? "bedroom4" : m === "fnaf2" ? "office2" : "office3");
    return { ...EYE[m] };
  }

  /** Hide the active FNAF world; disposes any scare and restores lights. */
  function exit() {
    clearScare();
    restoreLights();
    if (mode) setRootsVisible(worlds[mode], false);
    mode = null;
    cutLights = [];
  }

  function activeWorld() {
    return mode ? worlds[mode] : null;
  }

  function interactables() {
    return activeWorld()?.interactables ?? [];
  }

  /**
   * Apply the engine snapshot and session controls to the active world.
   * `ctl` is the session controls object; `camera` is the active camera.
   */
  const aim = new THREE.Vector3();
  function update(dt, time, session, camera, extra = {}) {
    const w = activeWorld();
    if (!w || !session) return;
    const snap = session.snapshot();
    const e = snap.engine ?? {};
    const ctl = session.controls;
    aim.set(0, 0, -1);
    if (camera?.getWorldDirection) camera.getWorldDirection(aim);
    const tension = Math.max(0, Math.min(1, extra.tension ?? 0));
    const powerOut = !!e.powerOut || e.state === "power-out";
    if (w.kind === "fnaf1") {
      const { office, rooms, feed } = w;
      office.setPowerOut(powerOut);
      office.setMonitorUp(!!e.monitorUp && !powerOut);
      office.setDoor("left", !!e.doors?.left);
      office.setDoor("right", !!e.doors?.right);
      office.setHallLight("left", !!ctl.lightL && !powerOut);
      office.setHallLight("right", !!ctl.lightR && !powerOut);
      const at = e.characters ?? {};
      if (at.bellwether?.room === "hall-west-corner") office.setDoorOccupant("left", "bellwether");
      if (at.lark?.room === "hall-east-corner") office.setDoorOccupant("right", "lark");
      else if (at.maestro?.room === "hall-east-corner") office.setDoorOccupant("right", "maestro");
      office.update(dt, time, { tension });
      feed.setPowerOut(powerOut);
      feed.select(e.cameraRoom ?? "showstage");
      feed.update(dt, time, {
        active: !!e.monitorUp && !powerOut,
        interference: 0,
        clockText: e.clock ?? undefined,
      });
      rooms.update(dt, time);
    } else if (w.kind === "fnaf2") {
      const s = w.space;
      s.setEyePosition(camera?.position ?? EYE.fnaf2);
      s.setMask(!!ctl.mask);
      s.setFlashlight(!!e.flashlight?.on, aim);
      s.setVentLight("left", ctl.ventLight === "left");
      s.setVentLight("right", ctl.ventLight === "right");
      s.setWindLevel(e.musicbox?.value ?? 1);
      s.setPowerOut(powerOut);
      s.update(dt, time, { tension, powerOut });
    } else if (w.kind === "fnaf3") {
      const s = w.space;
      ["A", "B", "C"].forEach((sec, i) => s.setVentSealed(i, !!(e.seals?.[sec]?.t > 0)));
      const lure = e.lure?.room ?? null;
      if (lure && lure !== lastLure) s.pulseLure(lure);
      lastLure = lure;
      for (const sys of ["audio", "camera", "vent"]) {
        const f = e.systems?.[sys];
        s.setSystemFault(sys, !!(f && (f.faulted || f.fault || f === true)));
      }
      s.setPowerOut(powerOut);
      s.update(dt, time, { tension, powerOut });
    } else if (w.kind === "fnaf4") {
      const s = w.space;
      s.setDoor("left", !!e.doors?.left?.closed);
      s.setDoor("right", !!e.doors?.right?.closed);
      s.setDoor("hall", !!e.doors?.hall?.closed);
      // Occupants: a character stands at its door once it reaches stage 2.
      const at = e.characters ?? {};
      for (const place of ["left", "right", "hall"]) s.setOccupant(place, null);
      for (const [id, c] of Object.entries(at)) {
        if (c.atDoor && (c.door === "left" || c.door === "right" || c.door === "hall")) s.setOccupant(c.door, id);
      }
      s.setFlashlight(!!e.flashlight?.on, aim);
      s.setNightlight(!!ctl.nightlight);
      s.setPowerOut(powerOut);
      s.update(dt, time, { tension, powerOut });
    }

    if (scare) scare.model.update(dt, time, { tension: 1, observed: false });

    if (cutLeft > 0) {
      cutLeft -= dt;
      if (cutLeft <= 0) restoreLights();
    }
    audio()?.update(
      { maskOn: !!ctl.mask, paused: false },
      camera,
    );
  }

  /** Sound + visuals for one canonical session event. */
  function handle(ev) {
    const a = audio();
    if (!ev || !ev.kind) return;
    switch (ev.kind) {
      case "move":
        a?.play("footsteps", { side: SIDE_OF[ev.who] ?? "center", intensity: 0.5 });
        break;
      case "cue":
        cueSound(ev);
        break;
      case "static":
        a?.play("cameraStatic", { duration: 1.2, intensity: 0.5 });
        break;
      case "door-knock":
        a?.play("doorBang", { side: ev.side ?? undefined, count: 2, intensity: 0.7 });
        break;
      case "power-warning":
        a?.play("hourChime", { intensity: 0.4 });
        break;
      case "power-out":
        a?.setAmbience("blackout");
        a?.play("powerOut");
        a?.play("powerOutJingle");
        break;
      case "hour":
        a?.play("hourChime");
        break;
      case "win":
        a?.play("sixAM");
        break;
      case "phone-start":
        a?.play("phoneRing");
        a?.play("callStart");
        break;
      case "phantom":
        if (ev.action === "appear") a?.play("radioCrackle", { intensity: 0.5 });
        break;
      case "jumpscare":
        a?.play("jumpscare", { intensity: 0.8 });
        break;
      default:
        break;
    }
  }

  function cueSound(ev) {
    const a = audio();
    if (!a) return;
    const side = ev.side ?? ev.door ?? "center";
    switch (ev.id) {
      case "breathing":
      case "door-presence":
        a.play("breathing", { variant: side === "center" ? "hall" : side, intensity: 0.5 });
        break;
      case "creak":
        a.play("doorSlam", { side, intensity: 0.3 });
        break;
      case "skitter":
        a.play("ventCrawl", { side, intensity: 0.4 });
        break;
      case "door-close":
        a.play("doorSlam", { side, intensity: 0.6 });
        break;
      case "door-open":
        a.play("doorSlam", { side, intensity: 0.3 });
        break;
      case "wasted-close":
        a.play("doorBang", { side, count: 1, intensity: 0.5 });
        break;
      case "agitated":
        a.play("murmur", { duration: 2 });
        break;
      case "musicbox":
        a.play("musicBoxTick", { wind: 0.5 });
        break;
      case "flashlight-dead":
        a.play("lightBuzz", { side: "center", intensity: 0.5 });
        break;
      case "kitchen-noise":
      case "pans":
        a.play("pans", { intensity: 0.4 });
        break;
      case "laugh":
        a.play("laugh", { intensity: 0.5 });
        break;
      case "run":
      case "office-entry":
        a.play("footsteps", { side, intensity: 0.7 });
        break;
      case "powerdown":
        a.play("powerOut");
        break;
      case "system-fault":
        a.play("radioCrackle", { intensity: 0.4 });
        break;
      case "system-ok":
        a.play("monitorUp", { intensity: 0.4 });
        break;
      case "trapped":
        a.play("doorBang", { count: 1, intensity: 0.4 });
        break;
      case "lure-failed":
      case "lure-cooldown":
        a.play("radioCrackle", { intensity: 0.3 });
        break;
      default:
        break;
    }
  }

  /** Light cut for the telegraph/blackout beat: every light in the active world goes dark. */
  function cutLightsFor(seconds = 1) {
    if (!cutSaved) {
      cutSaved = new Map();
      for (const l of cutLights) {
        cutSaved.set(l, l.intensity);
        l.intensity = 0;
      }
    }
    cutLeft = Math.max(cutLeft, Number.isFinite(seconds) ? seconds : 1);
  }
  function restoreLights() {
    if (!cutSaved) return;
    for (const [l, v] of cutSaved) l.intensity = v;
    cutSaved = null;
    cutLeft = 0;
  }

  /** Create the scare victim in front of the eye, ready to lunge. */
  function prepareScare(who, eyeMode = mode) {
    clearScare();
    const m = eyeMode ?? "fnaf1";
    const spot = SCARE_SPOT[m] ?? SCARE_SPOT.fnaf1;
    const id = scareModelFor(who);
    const make = CHARACTER_IDS.includes(id) ? createCharacter : createExtraCharacter;
    const c = make(THREE, id, { position: { x: spot.x, y: 0, z: spot.z }, rotationY: 0 });
    scene.add(c.group);
    scare = { model: c, id, mode: m };
    return id;
  }

  /** Lunge the prepared victim into the player's face. Entity motion only. */
  function lungeScare() {
    if (!scare) return false;
    const eye = EYE[scare.mode] ?? EYE.fnaf1;
    // characters.mjs jumpscare(target) takes one point, not an array. The
    // face stops FACE_DISTANCE short of the target, so aiming a metre in front
    // of the eye leaves the face about 1.4 m out and the body clear of the camera.
    scare.model.jumpscare({ x: eye.x, y: eye.y, z: eye.z - 1 });
    return true;
  }

  function clearScare() {
    if (!scare) return;
    scene.remove(scare.model.group);
    scare.model.dispose?.();
    scare = null;
  }

  function dispose() {
    clearScare();
    restoreLights();
    for (const w of Object.values(worlds)) {
      for (const r of w.roots) scene.remove(r);
      w.api?.dispose?.();
      w.office?.dispose?.();
      w.rooms?.dispose?.();
      w.feed?.dispose?.();
      w.space?.dispose?.();
    }
    fa?.dispose?.();
  }

  return {
    enter,
    exit,
    update,
    handle,
    interactables,
    cutLights: cutLightsFor,
    prepareScare,
    lungeScare,
    clearScare,
    hasScare: () => !!scare,
    activeMode: () => mode,
    isBuilt: (m) => !!worlds[m],
    dispose,
    _debug: () => ({
      worlds: Object.keys(worlds),
      mode,
      scare: scare?.id ?? null,
      cutLeft,
      scarePos: scare ? scare.model.group.position.toArray().map((v) => +v.toFixed(2)) : null,
      scareVisible: scare ? scare.model.group.visible : null,
      scareParent: scare ? !!scare.model.group.parent : null,
      scareBox: scare
        ? (() => {
            const b = new THREE.Box3().setFromObject(scare.model.group);
            return [b.min, b.max].map((v) => [v.x, v.y, v.z].map((n) => +n.toFixed(2)));
          })()
        : null,
    }),
  };
}
