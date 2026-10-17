// ghost.mjs — the PEAK-state apparition: a gaunt shrouded figure that forms in
// the corridor, stalks toward the doorway, and is banished by relief.
//
// Adapted from bridge-mind/bridge-horror-house (MIT) — Ghost.js build/animation
// and Textures.js ghostFaceTexture — reworked for this project: THREE is
// injected (headless-importable in Node), all randomness comes from a seeded
// PRNG (deterministic, no Math.random), and the state machine is driven by the
// Director's visuals {tension, state, quality, phase} instead of game events.
//
// States:
//   hidden     — default; fully transparent, eye light off, group invisible.
//   apparition — fades in when visuals.state === "PEAK" and tension > 0.6;
//                holds position, breathing scale +-3%.
//   stalk      — after sustained PEAK (opts.stalkDelay seconds) it drifts very
//                slowly toward the player with a lurching gait
//                (1 + sin(t * 8.5) * 0.55) plus brief corrupted-frame
//                visibility flickers (1-2 update frames, seeded intervals,
//                never sustained faster than ~2 Hz).
//   banished   — on RELIEF / WAIT / poor quality / non-running phase it fades
//                out, then returns to hidden.
//
// Safety constraints (VR comfort — entity motion only, no camera effects):
//   * never crosses z >= opts.maxZ (default 0.5; the room side of the door)
//   * never comes within opts.minPlayerDistance (default 1.5 m) of the player
//   * it NEVER touches the player.

export const GHOST_STATES = Object.freeze([
  "hidden",
  "apparition",
  "stalk",
  "banished",
]);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

/* ------------------------------------------------------------------------ */
/* Face textures (adapted from bridge-horror-house Textures.js, MIT).        */
/* Canvas-drawn in the browser; a tiny dark DataTexture headless so the      */
/* module constructs cleanly under node --test.                              */
/* ------------------------------------------------------------------------ */

function drawFace(ctx, size, rand, variant = 0) {
  const cx = size / 2;
  const cy = size / 2;
  const mouthScale = variant === 1 ? 2.1 : 1;
  const eyeScale = variant === 2 ? 1.7 : 1;
  const showPupils = variant !== 2;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  // Elongated pale oval head.
  let grad = ctx.createRadialGradient(
    cx,
    cy * 0.92,
    size * 0.05,
    cx,
    cy,
    size * 0.42,
  );
  grad.addColorStop(0, "rgba(168,164,158,1)");
  grad.addColorStop(0.72, "rgba(110,104,100,1)");
  grad.addColorStop(1, "rgba(10,10,10,0)");
  ctx.fillStyle = grad;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(0.72, 1.0);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Sunken eye sockets.
  for (const sx of [-1, 1]) {
    const ex = cx + sx * size * 0.115;
    const ey = cy - size * 0.07;
    grad = ctx.createRadialGradient(ex, ey, 1, ex, ey, size * 0.085 * eyeScale);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(0.65, "rgba(5,4,4,0.95)");
    grad.addColorStop(1, "rgba(5,4,4,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(
      ex,
      ey,
      size * 0.075 * eyeScale,
      size * 0.095 * eyeScale,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    if (showPupils) {
      ctx.fillStyle = "rgba(220,228,235,0.95)";
      ctx.beginPath();
      ctx.arc(ex, ey + size * 0.012, size * 0.011, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Nose shadow.
  grad = ctx.createLinearGradient(cx, cy - size * 0.02, cx, cy + size * 0.12);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(cx - size * 0.022, cy - size * 0.02, size * 0.044, size * 0.14);
  // Gaping vertical mouth (torn wide for variant 1).
  grad = ctx.createRadialGradient(
    cx,
    cy + size * 0.21,
    2,
    cx,
    cy + size * 0.21,
    size * 0.11 * mouthScale,
  );
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.8, "rgba(8,4,4,0.92)");
  grad.addColorStop(1, "rgba(8,4,4,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(
    cx,
    cy + size * 0.21,
    size * 0.052 * mouthScale,
    size * 0.105 * mouthScale,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  if (variant === 1) {
    ctx.strokeStyle = "rgba(20,12,10,0.7)";
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.28;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(a) * size * 0.06,
        cy + size * 0.21 + Math.sin(a) * size * 0.1,
      );
      ctx.lineTo(
        cx + Math.cos(a) * size * 0.13,
        cy + size * 0.21 + Math.sin(a) * size * 0.22,
      );
      ctx.stroke();
    }
  }
  // Grime streaks down the face.
  ctx.strokeStyle = "rgba(30,26,24,0.35)";
  for (let i = 0; i < 24; i++) {
    const x = cx + (rand() - 0.5) * size * 0.52;
    ctx.lineWidth = 0.5 + rand() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, cy - size * 0.3);
    ctx.lineTo(
      x + (rand() - 0.5) * 16,
      cy + size * (0.1 + rand() * 0.24),
    );
    ctx.stroke();
  }
}

function makeFaceTextures(THREE, rand) {
  if (typeof document === "undefined") {
    // Headless: three tiny dark textures so Node imports/tests run clean.
    return [0, 1, 2].map(() => {
      const t = new THREE.DataTexture(
        new Uint8Array([18, 20, 24, 255]),
        1,
        1,
      );
      t.needsUpdate = true;
      return t;
    });
  }
  return [0, 1, 2].map((variant) => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    drawFace(c.getContext("2d"), 256, rand, variant);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

/* ------------------------------------------------------------------------ */

export function createGhost(THREE, scene, options = {}) {
  const opts = {
    position: { x: 0, y: 0, z: -7 }, // corridor depth, beyond the doorway
    player: { x: 0, z: 2 }, // the rig does not locomote in this experience
    minPlayerDistance: 1.5,
    maxZ: 0.5, // never crosses into z >= 0.5
    bounds: { minX: -3.3, maxX: 3.3, minZ: -12 },
    appearTension: 0.6,
    stalkDelay: 5, // sustained hot seconds (apparition -> stalk)
    fadeIn: 1.8, // seconds to full presence
    fadeOut: 1.4, // seconds to banish
    stalkSpeed: 0.32, // m/s before lurch modulation — very slow drift
    seed: 0x9057,
    ...options,
  };

  // Deterministic LCG — no Math.random anywhere in this module.
  let seed = (opts.seed >>> 0) || 1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const geoms = [];
  const geo = (g) => (geoms.push(g), g);
  const mats = [];

  // Shroud materials share a base opacity scaled by the master fade.
  const shroudParts = [];
  const shroud = (baseOpacity) => {
    const m = new THREE.MeshStandardMaterial({
      color: 0x04040a,
      roughness: 1,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    mats.push(m);
    shroudParts.push({ material: m, base: baseOpacity });
    return m;
  };

  const group = new THREE.Group();
  group.name = "ghost";
  group.position.set(opts.position.x, opts.position.y ?? 0, opts.position.z);

  // Gaunt core — ~1.9 m silhouette under the hover bob.
  const body = new THREE.Mesh(
    geo(new THREE.CylinderGeometry(0.05, 0.5, 1.9, 10, 5)),
    shroud(0.94),
  );
  body.name = "ghost-body";
  body.position.y = 0.95;
  group.add(body);
  const shoulders = new THREE.Mesh(
    geo(new THREE.SphereGeometry(0.28, 10, 8)),
    shroud(0.94),
  );
  shoulders.name = "ghost-shoulders";
  shoulders.position.y = 1.62;
  shoulders.scale.set(1.3, 0.6, 0.8);
  group.add(shoulders);

  // Tattered cloth strips that flutter (thin planes, per-frame sin offsets).
  const strips = [];
  for (let i = 0; i < 7; i++) {
    const w = 0.1 + rand() * 0.12;
    const h = 0.7 + rand() * 0.8;
    const strip = new THREE.Mesh(
      geo(new THREE.PlaneGeometry(w, h, 1, 3)),
      shroud(0.5 + rand() * 0.3),
    );
    strip.material.side = THREE.DoubleSide;
    const a = (i / 7) * Math.PI * 2;
    strip.position.set(Math.cos(a) * 0.26, 0.75 - rand() * 0.25, Math.sin(a) * 0.26);
    strip.rotation.y = -a;
    strip.userData.phase = rand() * 10;
    group.add(strip);
    strips.push(strip);
  }

  // Thin arms ending in claw fingers; they extend/reach as tension rises.
  const fingerMat = new THREE.MeshStandardMaterial({
    color: 0x787068,
    roughness: 0.9,
    transparent: true,
    opacity: 0,
  });
  mats.push(fingerMat);
  shroudParts.push({ material: fingerMat, base: 0.92 });
  const armGeo = geo(new THREE.CylinderGeometry(0.028, 0.05, 1.25, 6));
  const fingerGeo = geo(new THREE.CylinderGeometry(0.006, 0.012, 0.22, 4));
  const arms = [];
  for (const side of [-1, 1]) {
    const armGroup = new THREE.Group();
    const arm = new THREE.Mesh(armGeo, shroud(0.92));
    arm.position.y = -0.6;
    armGroup.add(arm);
    const hand = new THREE.Group();
    hand.position.y = -1.22;
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(fingerGeo, fingerMat);
      finger.position.set((f - 1.5) * 0.032, -0.09, 0.02);
      finger.rotation.x = 0.5 + f * 0.07;
      hand.add(finger);
    }
    armGroup.add(hand);
    armGroup.position.set(side * 0.32, 1.58, 0.04);
    armGroup.rotation.z = side * 0.2;
    armGroup.userData.side = side;
    group.add(armGroup);
    arms.push(armGroup);
  }

  // Gaunt canvas-drawn face; 3 variants swapped on seeded non-rhythmic timers.
  const faces = makeFaceTextures(THREE, rand);
  const faceMat = new THREE.MeshBasicMaterial({
    map: faces[0],
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  mats.push(faceMat);
  shroudParts.push({ material: faceMat, base: 0.96 });
  const face = new THREE.Mesh(geo(new THREE.PlaneGeometry(0.4, 0.5)), faceMat);
  face.name = "ghost-face";
  face.position.y = 1.78;
  group.add(face);

  // Faint cold eye light — capped at intensity 2, always.
  const eyeLight = new THREE.PointLight(0x96b4cc, 0, 5, 2);
  eyeLight.name = "ghost-eye-light";
  eyeLight.position.y = 1.76;
  group.add(eyeLight);

  // Dark vapor churning around the base (~50 points).
  const VAPOR = 50;
  const vaporPos = new Float32Array(VAPOR * 3);
  for (let i = 0; i < VAPOR; i++) {
    vaporPos[i * 3] = (rand() - 0.5) * 0.7;
    vaporPos[i * 3 + 1] = rand() * 1.9;
    vaporPos[i * 3 + 2] = (rand() - 0.5) * 0.7;
  }
  const vaporGeo = geo(new THREE.BufferGeometry());
  vaporGeo.setAttribute("position", new THREE.BufferAttribute(vaporPos, 3));
  const vaporMat = new THREE.PointsMaterial({
    color: 0x1a1a26,
    size: 0.09,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  mats.push(vaporMat);
  shroudParts.push({ material: vaporMat, base: 0.5 });
  const vapor = new THREE.Points(vaporGeo, vaporMat);
  vapor.name = "ghost-vapor";
  group.add(vapor);

  group.visible = false;
  scene.add(group);

  /* ---------------- state ---------------- */

  const st = {
    state: "hidden",
    fade: 0,
    time: 0,
    bob: rand() * 10,
    hotTimer: 0,
    faceClock: 0.6 + rand() * 1.2,
    // Corrupted-frame flicker (stalk only): hide for 1-2 update frames at
    // seeded intervals >= 0.7 s apart — never a sustained strobe above ~2 Hz.
    flickerIn: 0.9 + rand() * 1.8,
    flickerHold: 0,
    disposed: false,
  };

  function applyFade() {
    for (const p of shroudParts) p.material.opacity = p.base * st.fade;
    eyeLight.intensity = Math.min(2, st.fade * 1.7);
  }

  function enter(next) {
    if (!GHOST_STATES.includes(next) || next === st.state) return;
    st.state = next;
    st.hotTimer = 0;
    if (next === "hidden") {
      st.fade = 0;
      applyFade();
      group.visible = false;
    } else if (next === "apparition" || next === "stalk") {
      if (st.fade <= 0) {
        // Re-manifest at the spawn point when rising from nothing.
        group.position.set(opts.position.x, opts.position.y ?? 0, opts.position.z);
      }
      st.flickerIn = 0.9 + rand() * 1.8;
      st.flickerHold = 0;
    }
  }

  function moveStalk(dt) {
    const px = opts.player.x;
    const pz = opts.player.z;
    let x = group.position.x;
    let z = group.position.z;
    let dx = px - x;
    let dz = pz - z;
    let dist = Math.hypot(dx, dz);
    if (dist > 1e-9) {
      // Lurching gait: surges and hesitations, never a smooth glide.
      const lurch = Math.max(0, 1 + Math.sin(st.time * 8.5) * 0.55);
      const step = Math.min(
        opts.stalkSpeed * lurch * dt,
        Math.max(0, dist - opts.minPlayerDistance),
      );
      x += (dx / dist) * step;
      z += (dz / dist) * step;
    }
    // Hard spatial limits: stays past the door line and off the player.
    z = Math.min(z, opts.maxZ);
    x = clamp(x, opts.bounds.minX, opts.bounds.maxX);
    z = Math.max(z, opts.bounds.minZ);
    dx = px - x;
    dz = pz - z;
    dist = Math.hypot(dx, dz);
    if (dist < opts.minPlayerDistance) {
      const s = opts.minPlayerDistance / Math.max(dist, 1e-6);
      x = px - dx * s;
      z = Math.min(pz - dz * s, opts.maxZ);
    }
    group.position.x = x;
    group.position.z = z;
  }

  function update(dt, time, visuals) {
    if (st.disposed) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    st.time += dt;
    st.bob += dt;

    // Auto transitions only when the caller supplies Director visuals.
    if (visuals) {
      const tension = clamp01(visuals.tension);
      const quality = visuals.quality == null ? 1 : clamp01(visuals.quality);
      const calm =
        visuals.state === "RELIEF" ||
        visuals.state === "WAIT" ||
        quality < 0.5 ||
        (visuals.phase && visuals.phase !== "running");
      const hot = visuals.state === "PEAK" && tension > opts.appearTension;
      if (st.state === "hidden") {
        if (hot) enter("apparition");
      } else if (st.state === "apparition") {
        if (calm) enter("banished");
        else {
          st.hotTimer = hot ? st.hotTimer + dt : 0;
          if (st.hotTimer >= opts.stalkDelay) enter("stalk");
        }
      } else if (st.state === "stalk") {
        if (calm) enter("banished");
      }
    }

    if (st.state === "hidden") {
      group.visible = false;
      return;
    }

    // Master fade.
    if (st.state === "banished") {
      st.fade = Math.max(0, st.fade - dt / opts.fadeOut);
      if (st.fade <= 0) {
        enter("hidden");
        return;
      }
    } else {
      st.fade = Math.min(1, st.fade + dt / opts.fadeIn);
    }
    applyFade();

    // Face the player.
    const dx = opts.player.x - group.position.x;
    const dz = opts.player.z - group.position.z;
    const dist = Math.hypot(dx, dz);
    group.rotation.y = Math.atan2(dx, dz);

    // Uneasy hover + breathing scale (+-3%).
    group.position.y =
      (opts.position.y ?? 0) + Math.sin(st.bob * 1.7) * 0.05;
    const breathe = 1 + Math.sin(st.bob * 2.3) * 0.03;
    group.scale.set(breathe, 1 / breathe, breathe);

    // Tatters flutter.
    for (const s of strips) {
      s.rotation.x = Math.sin(st.time * 2.1 + s.userData.phase) * 0.22;
      s.rotation.z = Math.sin(st.time * 1.4 + s.userData.phase * 2) * 0.14;
    }

    // Arms extend/reach as tension rises and as it closes in.
    const tension = clamp01(visuals?.tension ?? 0);
    const reach = Math.max(
      clamp01(1 - dist / 6),
      clamp01((tension - opts.appearTension) * 2),
    );
    for (const a of arms) {
      a.rotation.x =
        -0.25 - reach * 1.1 + Math.sin(st.time * 3 + a.userData.side) * 0.06;
      a.rotation.z = a.userData.side * (0.2 - reach * 0.15);
    }

    // Expression shifts on seeded, non-rhythmic timers.
    st.faceClock -= dt;
    if (st.faceClock <= 0) {
      faceMat.map = faces[Math.floor(rand() * faces.length) % faces.length];
      st.faceClock =
        st.state === "stalk" ? 0.3 + rand() * 0.9 : 0.6 + rand() * 1.4;
    }

    // Vapor churn.
    const p = vaporGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) + dt * 0.45;
      if (y > 2) y = 0.08;
      p.setY(i, y);
      p.setX(i, p.getX(i) + Math.sin(st.time * 3 + i) * dt * 0.05);
    }
    p.needsUpdate = true;

    // Stalk: slow drift + corrupted-frame flicker.
    let flickerHidden = false;
    if (st.state === "stalk") {
      moveStalk(dt);
      if (st.flickerHold > 0) {
        flickerHidden = true;
        st.flickerHold -= 1;
        if (st.flickerHold === 0) st.flickerIn = 0.7 + rand() * 1.8;
      } else {
        st.flickerIn -= dt;
        if (st.flickerIn <= 0) st.flickerHold = 1 + (rand() < 0.4 ? 1 : 0);
      }
    }

    group.visible = st.fade > 0.001 && !flickerHidden;
    void time; // internal clock drives animation; param kept for API parity
  }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    scene.remove(group);
    for (const g of geoms) g.dispose?.();
    for (const m of mats) m.dispose?.();
    for (const t of faces) t.dispose?.();
  }

  return {
    group,
    update,
    setState: (s) => {
      if (!st.disposed && GHOST_STATES.includes(s)) enter(s);
    },
    get state() {
      return st.state;
    },
    dispose,
  };
}
