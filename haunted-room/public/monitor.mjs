// monitor.mjs — a chunky CRT security console whose screen is a live render-
// target feed from virtual cameras covering the room's zones. Because the
// feeds cover the corridor where the apparition spawns, the entity shows up
// ON THE MONITOR before it reaches the room — the classic "it's on the camera
// before it's in the room" beat. The console is the surveillance half of the
// watch-vs-power resource loop (see public/power.mjs for the other half).
//
// Render-target pattern per the standard three.js WebGLRenderTarget approach;
// prop geometry, scanline/static overlay, OSD and scheduling are original.
// Procedural noise texture technique informed by bridge-mind/bridge-horror-house
// (MIT) grain tiles.
//
// Performance policy (Quest 3S):
//   * The RT (256x192) is re-rendered only every 4th update() call, and only
//     when visuals.lighting isn't disabled.
//   * setActive(false) ("putting the monitor down") stops ALL RT rendering;
//     the screen goes dark and update() does only trivial work.
//   * options.enabled === false makes update() a cheap early-return.
//   * setFeed(-1) disables RT rendering entirely — the screen draws animated
//     static only — so integration can turn the feed off if perf suffers.
//   * setSignalLost(true) also stops RT rendering: the channel is pure static.
//   * While renderer.xr.isPresenting is true the RT render is SKIPPED unless
//     options.xrSafe === true. Re-rendering a render target inside an XR
//     animation frame is allowed by three.js but costly on mobile GPUs (extra
//     framebuffer switches mid stereo frame), so the default is to freeze the
//     last frame and let the animated static sell the effect. Opt in with
//     { xrSafe: true } only after profiling on device.
//   * The monitor group hides itself during its own RT pass: the screen
//     samples rt.texture, and sampling a target while rendering into it is a
//     WebGL feedback loop.
//   * The OSD (camera label / REC dot / timestamp) is a small CanvasTexture
//     redrawn at most ~2x per second (second ticks and REC blinks), plus on
//     camera/state changes. In Node (no document) the OSD plane is skipped
//     but all OSD state remains queryable via getOsd().

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

function makeNoiseTexture(THREE, rand, size = 64) {
  if (typeof document === "undefined") {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.floor(rand() * 255);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    const t = new THREE.DataTexture(data, size, size);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rand() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Horizontal scanlines baked into the tile.
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  for (let y = 0; y < size; y += 3) ctx.fillRect(0, y, size, 1);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Default camera plan: four zones of the observation chamber.
// Room bounds x ±3.5, z -5.5..3.5; player at z=2, eye 1.6, looking -Z;
// the apparition spawns in the corridor at z ~ -7 (visible from CAM 02).
const DEFAULT_CAMERAS = [
  {
    id: "far-corner",
    label: "CAM 01 — FAR CORNER",
    zone: "far-corner",
    position: [-3.2, 2.5, -5.1],
    lookAt: [0.5, 1.1, 1.5],
  },
  {
    id: "doorway",
    label: "CAM 02 — DOORWAY",
    zone: "doorway",
    position: [0, 2.4, -4.9],
    lookAt: [0, 1.2, -8.5], // down the corridor, covers the ghost spawn
  },
  {
    id: "cabinet",
    label: "CAM 03 — CABINET",
    zone: "cabinet",
    position: [3.2, 2.5, -2.2],
    lookAt: [-2.6, 1.1, -3.6], // cabinet / window side
  },
  {
    id: "rear",
    label: "CAM 04 — REAR",
    zone: "rear",
    position: [0, 2.55, 3.3],
    lookAt: [0, 1.2, -2.0], // behind the player, looking over their shoulder
  },
];

export function createMonitor(THREE, renderer, scene, options = {}) {
  const opts = {
    position: { x: -2.55, y: 1.4, z: -3.7 }, // on the cabinet
    rotation: null, // [x, y, z] Euler override; default aims at the player
    lookAt: { x: 0, y: 1.5, z: 2 },
    enabled: true,
    active: true, // monitor "up" (being watched). Integration toggles this.
    xrSafe: false,
    interval: 4, // RT re-render every Nth update() call (~10-18 fps)
    rtWidth: 256,
    rtHeight: 192,
    staticSpike: 0.7, // tension above this => heavy static
    cameras: DEFAULT_CAMERAS,
    seed: 0xc47,
    ...options,
  };

  // Normalize cameras: legacy entries ({position, lookAt} only) get generated
  // ids/labels/zones so older option objects keep working.
  const cameras = (Array.isArray(opts.cameras) ? opts.cameras : []).map(
    (c, i) => ({
      id: typeof c.id === "string" ? c.id : `cam-${i}`,
      label:
        typeof c.label === "string"
          ? c.label
          : `CAM ${String(i + 1).padStart(2, "0")}`,
      zone: typeof c.zone === "string" ? c.zone : `cam-${i}`,
      position: c.position,
      lookAt: c.lookAt,
    }),
  );

  // Deterministic LCG — no Math.random.
  let seed = (opts.seed >>> 0) || 1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const geoms = [];
  const geo = (g) => (geoms.push(g), g);
  const mats = [];
  const mat = (m) => (mats.push(m), m);

  /* ---------------- render target + feed camera ---------------- */

  const rt = new THREE.WebGLRenderTarget(opts.rtWidth, opts.rtHeight, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const rtCamera = new THREE.PerspectiveCamera(
    58,
    opts.rtWidth / opts.rtHeight,
    0.05,
    40,
  );
  const rtBackground = new THREE.Color(0x01030a);

  /* ---------------- prop geometry ---------------- */

  const group = new THREE.Group();
  group.name = "security-monitor";
  group.position.set(opts.position.x, opts.position.y, opts.position.z);

  const shellMat = mat(
    new THREE.MeshStandardMaterial({
      color: 0x23231f,
      roughness: 0.85,
      metalness: 0.15,
    }),
  );
  const bezelMat = mat(
    new THREE.MeshStandardMaterial({
      color: 0x14110d,
      roughness: 0.6,
      metalness: 0.1,
    }),
  );

  // Chunky CRT shell, ~0.5 m wide, deep back.
  const shell = new THREE.Mesh(geo(new THREE.BoxGeometry(0.5, 0.4, 0.34)), shellMat);
  shell.name = "monitor-shell";
  shell.position.z = -0.08;
  group.add(shell);
  const bezel = new THREE.Mesh(geo(new THREE.BoxGeometry(0.46, 0.36, 0.04)), bezelMat);
  bezel.name = "monitor-bezel";
  bezel.position.z = 0.1;
  group.add(bezel);
  const foot = new THREE.Mesh(geo(new THREE.BoxGeometry(0.3, 0.05, 0.22)), bezelMat);
  foot.position.set(0, -0.22, -0.04);
  group.add(foot);

  // Slightly curved screen: plane with a bulge toward the viewer.
  const screenGeo = geo(new THREE.PlaneGeometry(0.4, 0.3, 10, 8));
  {
    const pos = screenGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const nx = pos.getX(i) / 0.2;
      const ny = pos.getY(i) / 0.15;
      pos.setZ(i, 0.02 * (1 - 0.5 * (nx * nx + ny * ny)));
    }
    screenGeo.computeVertexNormals();
  }
  const screenMat = mat(
    new THREE.MeshBasicMaterial({
      map: rt.texture,
      color: 0xa8c4b2, // CCTV green-grey tint; MeshBasicMaterial = emissive feel
    }),
  );
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.name = "monitor-screen";
  screen.position.z = 0.121;
  group.add(screen);

  // Additive scanline/static overlay, just proud of the screen glass.
  const noiseTex = makeNoiseTexture(THREE, rand);
  const staticMat = mat(
    new THREE.MeshBasicMaterial({
      map: noiseTex,
      color: 0x9ab5a4,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const staticPlane = new THREE.Mesh(screenGeo, staticMat);
  staticPlane.name = "monitor-static";
  staticPlane.position.z = 0.1255;
  group.add(staticPlane);

  // Small blinking LED on the bezel.
  const ledMat = mat(new THREE.MeshBasicMaterial({ color: 0x3a0505 }));
  const led = new THREE.Mesh(geo(new THREE.BoxGeometry(0.015, 0.015, 0.01)), ledMat);
  led.name = "monitor-led";
  led.position.set(0.19, -0.15, 0.121);
  group.add(led);

  /* ---------------- OSD (label / REC / timestamp) ---------------- */
  // Browser only: a transparent CanvasTexture plane over the screen glass.
  // All OSD *state* lives in st.osd so Node tests can verify the logic.

  let osdCanvas = null;
  let osdCtx = null;
  let osdTex = null;
  if (typeof document !== "undefined") {
    osdCanvas = document.createElement("canvas");
    osdCanvas.width = 256;
    osdCanvas.height = 192;
    osdCtx = osdCanvas.getContext("2d");
    osdTex = new THREE.CanvasTexture(osdCanvas);
    const osdMat = mat(
      new THREE.MeshBasicMaterial({
        map: osdTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    const osdPlane = new THREE.Mesh(screenGeo, osdMat);
    osdPlane.name = "monitor-osd";
    osdPlane.position.z = 0.126;
    group.add(osdPlane);
  }

  if (Array.isArray(opts.rotation)) {
    group.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
  } else {
    group.lookAt(opts.lookAt.x, opts.lookAt.y, opts.lookAt.z);
  }
  scene.add(group);

  /* ---------------- state ---------------- */

  const st = {
    enabled: opts.enabled !== false,
    active: opts.active !== false, // monitor pulled up / being watched
    signalLost: false,
    feed: -2, // force applyFeed(0) below to run
    frame: 0,
    time: 0,
    burstUntil: -1, // st.time horizon of the current static burst
    disposed: false,
    osd: {
      label: "",
      zone: null,
      rec: true,
      timestamp: "00:00:00",
      signalLost: false,
      active: true,
    },
    osdDirty: true,
  };

  function refreshScreenMode() {
    if (!st.active) {
      screenMat.map = null;
      screenMat.color.setHex(0x030404); // tube off
    } else if (st.signalLost || st.feed < 0) {
      // Dead channel / lost signal: no RT sampling, pure animated static.
      screenMat.map = null;
      screenMat.color.setHex(0x0a0f0c);
      staticMat.opacity = Math.max(staticMat.opacity, 0.55);
    } else {
      screenMat.map = rt.texture;
      screenMat.color.setHex(0xa8c4b2);
    }
    screenMat.needsUpdate = true;
    st.osdDirty = true;
  }

  function applyFeed(index) {
    const i = Number.isInteger(index) ? index : -1;
    const next = i >= 0 && i < cameras.length ? i : -1;
    if (next === st.feed) return;
    st.feed = next;
    if (next >= 0) {
      const cam = cameras[next];
      rtCamera.position.set(cam.position[0], cam.position[1], cam.position[2]);
      rtCamera.lookAt(cam.lookAt[0], cam.lookAt[1], cam.lookAt[2]);
      rtCamera.updateMatrixWorld(true);
    }
    refreshScreenMode();
  }
  applyFeed(0);

  function renderFeed() {
    // Save/restore renderer + scene state; hide ourselves to avoid sampling
    // rt.texture while rendering into it (WebGL feedback loop).
    const prevTarget =
      typeof renderer.getRenderTarget === "function"
        ? renderer.getRenderTarget()
        : null;
    const prevBackground = scene.background;
    const prevVisible = group.visible;
    if (prevBackground == null) scene.background = rtBackground;
    group.visible = false;
    renderer.setRenderTarget(rt);
    renderer.render(scene, rtCamera);
    renderer.setRenderTarget(prevTarget);
    scene.background = prevBackground;
    group.visible = prevVisible;
  }

  function drawOsd() {
    if (!osdCtx) return;
    const w = osdCanvas.width;
    const h = osdCanvas.height;
    osdCtx.clearRect(0, 0, w, h);
    if (!st.osd.active) {
      osdTex.needsUpdate = true;
      return;
    }
    osdCtx.font = "bold 16px monospace";
    osdCtx.textBaseline = "top";
    if (st.osd.signalLost) {
      osdCtx.fillStyle = "rgba(230,240,235,0.95)";
      osdCtx.textAlign = "center";
      osdCtx.fillText("SIGNAL LOST", w / 2, h / 2 - 8);
      osdCtx.textAlign = "left";
      osdTex.needsUpdate = true;
      return;
    }
    // Camera label, top-left.
    osdCtx.fillStyle = "rgba(220,235,226,0.9)";
    osdCtx.textAlign = "left";
    osdCtx.fillText(st.osd.label, 8, 8);
    // REC dot + text, top-right, blinking.
    if (st.osd.rec) {
      osdCtx.fillStyle = "rgba(235,70,60,0.95)";
      osdCtx.beginPath();
      osdCtx.arc(w - 52, 16, 5, 0, Math.PI * 2);
      osdCtx.fill();
      osdCtx.fillStyle = "rgba(220,235,226,0.9)";
      osdCtx.fillText("REC", w - 42, 8);
    }
    // Timestamp, bottom-left.
    osdCtx.fillStyle = "rgba(220,235,226,0.85)";
    osdCtx.fillText(st.osd.timestamp, 8, h - 24);
    osdTex.needsUpdate = true;
  }

  function updateOsdState(visuals) {
    const cam = st.feed >= 0 ? cameras[st.feed] : null;
    const label = st.feed >= 0 ? cam.label : "NO FEED";
    const zone = st.feed >= 0 ? cam.zone : null;
    const rec = Math.sin(st.time * Math.PI) >= 0; // 0.5 Hz blink, no strobe
    const elapsed = Number.isFinite(visuals?.elapsed) ? visuals.elapsed : st.time;
    const timestamp = formatTimestamp(elapsed);
    const o = st.osd;
    if (
      label !== o.label ||
      zone !== o.zone ||
      rec !== o.rec ||
      timestamp !== o.timestamp ||
      st.signalLost !== o.signalLost ||
      st.active !== o.active
    ) {
      o.label = label;
      o.zone = zone;
      o.rec = rec;
      o.timestamp = timestamp;
      o.signalLost = st.signalLost;
      o.active = st.active;
      st.osdDirty = true;
    }
    if (st.osdDirty) {
      drawOsd();
      st.osdDirty = false;
    }
  }

  function update(dt, time, visuals) {
    if (st.disposed || !st.enabled) return; // cheap early-return when disabled
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    st.time += dt;
    st.frame += 1;

    // LED heartbeat.
    ledMat.color.setHex(Math.sin(st.time * 4) > 0 ? 0xcc1a1a : 0x3a0505);

    // Static/scanline overlay: baseline hiss that rises with tension and
    // spikes to heavy interference while the entity is active (tension > 0.7)
    // — on screen it reads as the camera corrupting before the room does.
    const tension = clamp01(visuals?.tension ?? 0);
    let opacity = 0.1 + tension * 0.3;
    if (tension > opts.staticSpike) opacity = 0.85;
    if (st.feed < 0) opacity = Math.max(opacity, 0.55);
    if (st.time < st.burstUntil) opacity = Math.max(opacity, 0.92); // VHS burst
    if (st.signalLost) opacity = 0.97; // full-static channel
    if (!st.active) opacity = 0.04; // tube is off; faint glass sheen only
    staticMat.opacity = opacity;
    // Animated static: jitter the noise tile every update (cheap; no RT).
    noiseTex.offset.set(rand(), rand());

    updateOsdState(visuals);

    // RT feed refresh — every Nth update, monitor up, feed live and intact,
    // lighting not disabled, and not mid-XR-presentation unless explicitly
    // opted in (see header).
    if (!st.active) return;
    if (st.signalLost) return;
    if (st.feed < 0) return;
    if (visuals?.lighting === false) return;
    if (renderer?.xr?.isPresenting && opts.xrSafe !== true) return;
    if (st.frame % opts.interval !== 0) return;
    renderFeed();
    void time; // internal clock drives animation; param kept for API parity
  }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    scene.remove(group);
    rt.dispose();
    noiseTex.dispose();
    osdTex?.dispose();
    for (const g of geoms) g.dispose?.();
    for (const m of mats) m.dispose?.();
  }

  return {
    group,
    update,
    /** Switch feed camera; -1 kills the feed (animated static only). */
    setFeed: (camIndex) => {
      if (!st.disposed) applyFeed(camIndex);
    },
    /**
     * Select a camera by valid index only (surveillance console semantics);
     * out-of-range / non-integer input is ignored, never killing the feed.
     */
    selectCamera: (index) => {
      if (st.disposed) return;
      if (Number.isInteger(index) && index >= 0 && index < cameras.length) {
        applyFeed(index);
      }
    },
    /** Pull the monitor up (true) or put it down (false). Down = no RT cost. */
    setActive: (active) => {
      if (st.disposed) return;
      const next = active === true;
      if (next === st.active) return;
      st.active = next;
      refreshScreenMode();
    },
    isActive: () => st.active && !st.disposed,
    /** Full-static "SIGNAL LOST" mode (entity at this camera / power out). */
    setSignalLost: (lost) => {
      if (st.disposed) return;
      const next = lost === true;
      if (next === st.signalLost) return;
      st.signalLost = next;
      refreshScreenMode();
    },
    /** VHS-style interference burst ("it moved while you watched"). */
    staticBurst: (duration = 0.4) => {
      if (st.disposed) return;
      const d = clamp(Number.isFinite(duration) ? duration : 0.4, 0.05, 3);
      st.burstUntil = st.time + d;
    },
    /** Info about the selected camera (index -1 / nulls when feed is dead). */
    getCamera: () => {
      const cam = st.feed >= 0 ? cameras[st.feed] : null;
      return {
        index: st.feed,
        count: cameras.length,
        id: cam ? cam.id : null,
        label: cam ? cam.label : null,
        zone: cam ? cam.zone : null,
      };
    },
    /**
     * Zone id the player is currently observing, or null. Contract for entity
     * AI: non-null only while the monitor is up, the feed is live, and the
     * signal is intact — a lost signal means the player can't actually see.
     */
    getWatchedZone: () =>
      !st.disposed && st.active && !st.signalLost && st.feed >= 0
        ? cameras[st.feed].zone
        : null,
    /** OSD state (label/REC/timestamp/signal-lost), Node-testable. */
    getOsd: () => ({ ...st.osd }),
    getState: () => ({
      active: st.active,
      signalLost: st.signalLost,
      camera: st.feed,
      cameraCount: cameras.length,
      burstRemaining: Math.max(0, st.burstUntil - st.time),
      disposed: st.disposed,
    }),
    dispose,
  };
}
