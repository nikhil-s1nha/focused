// animatronic.mjs — "the Attendant", an original derelict stage-prop automaton.
// Fully procedural low-poly geometry (3 materials, well under 5k triangles),
// no external assets. THREE is injected so the module imports cleanly in Node.
//
// Stage semantics (0..4):
//   0 dormant  — slumped, eyes dark, completely still.
//   1 aware    — sustained mid tension; head creeps toward the player (~8s).
//   2 active   — high tension / PEAK; upright, eyes bright, twitches, crank turns.
//   3 hunting  — trigger("advance"): snaps one step closer during a brief
//                opacity dip (never glides), always stopping >= safeRadius away.
//   4 lunge    — trigger("scare"): fast forward lean + eye flare < 0.8s,
//                then returns to stage 2. Entity motion only, no camera effects.
// WAIT / low quality / non-running phase decays the stage toward 0 (~2.5s per
// stage, so 4 -> 0 over ~10s). Auto logic only runs when `visuals` is passed.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (cur, target, dt, tau) =>
  cur + (target - cur) * (1 - Math.exp(-dt / tau));

export const STAGES = Object.freeze([
  "dormant",
  "aware",
  "active",
  "hunting",
  "lunge",
]);

// Posture keyframes per stage. lean = torso tilt (+ slump back, - lunge
// forward), headPitch = chin-down tilt, shoulder/elbow = arm hang, track =
// whether the head seeks the player, eye = emissive intensity target.
const POSES = Object.freeze([
  Object.freeze({ lean: 0.14, headPitch: 0.55, shoulder: 0.26, elbow: 0.38, track: 0, eye: 0 }),
  Object.freeze({ lean: 0.1, headPitch: 0.22, shoulder: 0.2, elbow: 0.3, track: 1, eye: 0.35 }),
  Object.freeze({ lean: 0.02, headPitch: 0.04, shoulder: 0.08, elbow: 0.12, track: 1, eye: 1.3 }),
  Object.freeze({ lean: 0, headPitch: 0, shoulder: 0.04, elbow: 0.05, track: 1, eye: 1.8 }),
  Object.freeze({ lean: -0.45, headPitch: -0.12, shoulder: -0.5, elbow: 0.05, track: 1, eye: 4 }),
]);

const FADE = 0.5; // seconds of opacity dip around an advance snap
const LUNGE = 0.7; // seconds a lunge holds before returning to stage 2

export function createAnimatronic(THREE, scene, options = {}) {
  const opts = {
    x: -2.6,
    z: -4.8,
    offAxis: 0.42, // radians the body faces away from the player at rest
    playerX: 0,
    playerZ: 2,
    eyeHeight: 1.6,
    safeRadius: 1.2, // it never ends an advance closer than this
    bounds: { minX: -3.3, maxX: 3.3, minZ: -5.3, maxZ: 3.3 },
    awareTension: 0.35,
    awareDwell: 3, // sustained seconds of mid tension before 0 -> 1
    activeTension: 0.65,
    activeDwell: 0.5,
    decayPerStage: 2.5, // WAIT/low-quality seconds per stage of decay
    advanceStep: 0.35, // fraction of remaining distance per advance
    ...options,
  };

  // --- materials (exactly 3, shared everywhere) ---
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x4a4440,
    metalness: 0.55,
    roughness: 0.62,
    transparent: true,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x8a6b3d,
    metalness: 0.82,
    roughness: 0.35,
    transparent: true,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x1a0d08,
    emissive: 0xffab4d,
    emissiveIntensity: 0,
    roughness: 0.3,
    transparent: true,
  });
  const materials = [bodyMat, accentMat, eyeMat];

  // --- geometry (low segment counts; Quest-friendly) ---
  const group = new THREE.Group();
  group.name = "attendant";
  group.position.set(opts.x, 0, opts.z);

  const geoms = [];
  const geo = (g) => (geoms.push(g), g);
  const mesh = (g, m, name) => {
    const me = new THREE.Mesh(g, m);
    me.name = name;
    me.castShadow = true;
    return me;
  };

  const pedestal = mesh(
    geo(new THREE.CylinderGeometry(0.46, 0.5, 0.12, 14)),
    accentMat,
    "attendant-pedestal",
  );
  pedestal.position.y = 0.06;
  group.add(pedestal);

  // Body pivot so lean rotates around the hips.
  const body = new THREE.Group();
  body.name = "attendant-body";
  body.position.y = 0.15;
  group.add(body);

  const torso = mesh(
    geo(new THREE.CylinderGeometry(0.24, 0.3, 0.78, 12)),
    bodyMat,
    "attendant-torso",
  );
  torso.position.y = 0.62;
  body.add(torso);

  const seamGeo = geo(new THREE.TorusGeometry(0.285, 0.013, 6, 18));
  for (const [i, y] of [0.38, 0.86].entries()) {
    const seam = new THREE.Mesh(seamGeo, accentMat);
    seam.name = `attendant-seam-${i}`;
    seam.rotation.x = Math.PI / 2;
    seam.position.y = y;
    body.add(seam);
  }

  // Rivets: one instanced mesh, two rings of 12.
  const rivetGeo = geo(new THREE.BoxGeometry(0.022, 0.022, 0.022));
  const rivets = new THREE.InstancedMesh(rivetGeo, accentMat, 24);
  rivets.name = "attendant-rivets";
  {
    const m4 = new THREE.Matrix4();
    let i = 0;
    for (const y of [0.38, 0.86]) {
      const r = y < 0.6 ? 0.295 : 0.262;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        m4.makeRotationY(a);
        m4.setPosition(Math.sin(a) * r, y, Math.cos(a) * r);
        rivets.setMatrixAt(i++, m4);
      }
    }
  }
  body.add(rivets);

  // Wind-up crank in the back.
  const crank = new THREE.Group();
  crank.name = "attendant-crank";
  crank.position.set(0, 0.68, -0.31);
  const shaft = mesh(
    geo(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 8)),
    accentMat,
    "attendant-crank-shaft",
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.07;
  crank.add(shaft);
  const handle = mesh(
    geo(new THREE.BoxGeometry(0.2, 0.03, 0.03)),
    accentMat,
    "attendant-crank-handle",
  );
  handle.position.set(0.08, 0, -0.15);
  crank.add(handle);
  body.add(crank);

  // Arms: slightly too long for the frame — uncanny on purpose.
  const upperGeo = geo(new THREE.CylinderGeometry(0.045, 0.04, 0.44, 8));
  const foreGeo = geo(new THREE.CylinderGeometry(0.038, 0.032, 0.42, 8));
  const jointGeo = geo(new THREE.SphereGeometry(0.06, 8, 6));
  const handGeo = geo(new THREE.SphereGeometry(0.05, 8, 6));
  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.name = side < 0 ? "attendant-arm-l" : "attendant-arm-r";
    shoulder.position.set(side * 0.3, 0.96, 0);
    shoulder.add(new THREE.Mesh(jointGeo, accentMat));
    const upper = new THREE.Mesh(upperGeo, bodyMat);
    upper.position.y = -0.22;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.44;
    elbow.add(new THREE.Mesh(jointGeo, accentMat));
    const fore = new THREE.Mesh(foreGeo, bodyMat);
    fore.position.y = -0.21;
    elbow.add(fore);
    const hand = new THREE.Mesh(handGeo, accentMat);
    hand.position.y = -0.44;
    elbow.add(hand);
    shoulder.add(elbow);
    body.add(shoulder);
    arms.push({ shoulder, elbow });
  }

  const neck = mesh(
    geo(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8)),
    accentMat,
    "attendant-neck",
  );
  neck.position.y = 1.07;
  body.add(neck);

  // Head slightly oversized for the torso — more uncanny.
  const head = new THREE.Group();
  head.name = "attendant-head";
  head.position.y = 1.3;
  const skull = mesh(
    geo(new THREE.SphereGeometry(0.21, 12, 10)),
    bodyMat,
    "attendant-skull",
  );
  head.add(skull);
  const eyeGeo = geo(new THREE.SphereGeometry(0.034, 8, 6));
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.name = "attendant-eye-l";
  eyeL.position.set(-0.075, 0.03, 0.17);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.name = "attendant-eye-r";
  eyeR.position.set(0.075, 0.03, 0.17);
  head.add(eyeL, eyeR);
  const grille = mesh(
    geo(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 10)),
    accentMat,
    "attendant-grille",
  );
  grille.rotation.x = Math.PI / 2;
  grille.position.set(0, -0.08, 0.185);
  head.add(grille);
  body.add(head);

  const faceYaw = () =>
    Math.atan2(opts.playerX - group.position.x, opts.playerZ - group.position.z);
  group.rotation.y = faceYaw() + opts.offAxis;
  scene.add(group);

  // --- state ---
  const st = {
    stage: 0,
    tension: 0,
    time: 0,
    awareTimer: 0,
    activeTimer: 0,
    decayTimer: 0,
    lungeT: 0,
    fadeT: -1,
    snapDone: false,
    pending: 0,
    opacity: 1,
    nextTwitch: 3,
    twitchEnd: -1,
    // eased pose values
    lean: POSES[0].lean,
    headPitch: POSES[0].headPitch,
    headYaw: 0,
    shoulder: POSES[0].shoulder,
    elbow: POSES[0].elbow,
    eye: 0,
    disposed: false,
  };

  // Deterministic LCG for twitch scheduling (no Math.random in the loop).
  let seed = (options.seed ?? 0x5eed) >>> 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  function setOpacity(k) {
    if (k === st.opacity) return;
    st.opacity = k;
    for (const m of materials) m.opacity = k;
  }

  function commit(n) {
    n = clamp(Math.round(n), 0, 4);
    if (!Number.isFinite(n) || n === st.stage) return;
    st.stage = n;
    st.awareTimer = 0;
    st.activeTimer = 0;
    st.decayTimer = 0;
    if (n === 4) st.lungeT = 0;
  }

  function snap() {
    const dx = opts.playerX - group.position.x;
    const dz = opts.playerZ - group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= opts.safeRadius + 1e-6) return;
    const step = Math.min(opts.advanceStep * dist, dist - opts.safeRadius);
    const b = opts.bounds;
    group.position.x = clamp(group.position.x + (dx / dist) * step, b.minX, b.maxX);
    group.position.z = clamp(group.position.z + (dz / dist) * step, b.minZ, b.maxZ);
    group.rotation.y = faceYaw() + 0.12; // nearly facing the player now
  }

  function trigger(kind) {
    if (st.disposed) return false;
    if (kind === "advance") {
      commit(3);
      st.pending += 1;
      if (st.fadeT < 0) {
        st.fadeT = 0;
        st.snapDone = false;
      }
      return true;
    }
    if (kind === "scare") {
      if (st.stage === 4) return false;
      commit(4);
      return true;
    }
    return false;
  }

  // Allocation-free: scalar math only, no temp objects created per frame.
  function update(dt, time, visuals) {
    if (st.disposed) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    st.time += dt;
    const v = visuals || null;
    st.tension = clamp01(v?.tension ?? st.tension);

    // Lunge timing: short, then back to active.
    if (st.stage === 4) {
      st.lungeT += dt;
      if (st.lungeT >= LUNGE) commit(2);
    }

    // Auto stage logic only when the caller supplies visuals.
    if (v && st.stage !== 4) {
      const quality = clamp01(v.quality ?? 1);
      const decayActive =
        v.state === "WAIT" || quality < 0.5 || (v.phase && v.phase !== "running");
      if (decayActive) {
        st.awareTimer = 0;
        st.activeTimer = 0;
        if (st.stage > 0) {
          st.decayTimer += dt;
          if (st.decayTimer >= opts.decayPerStage) {
            st.decayTimer = 0;
            st.stage -= 1;
          }
        }
      } else {
        st.decayTimer = 0;
        if (st.stage === 0) {
          st.awareTimer =
            st.tension >= opts.awareTension ? st.awareTimer + dt : 0;
          if (st.awareTimer >= opts.awareDwell) commit(1);
        } else if (st.stage === 1) {
          const hot = st.tension >= opts.activeTension || v.state === "PEAK";
          st.activeTimer = hot ? st.activeTimer + dt : 0;
          if (st.activeTimer >= opts.activeDwell) commit(2);
        }
        // Stages 3 and 4 are reached only via trigger().
      }
    }

    // Advance opacity dip + between-the-frames position snap.
    if (st.fadeT >= 0) {
      st.fadeT += dt;
      if (!st.snapDone && st.fadeT >= FADE / 2) {
        snap();
        st.snapDone = true;
        st.pending = Math.max(0, st.pending - 1);
      }
      if (st.fadeT >= FADE) {
        if (st.pending > 0) {
          st.fadeT = 0;
          st.snapDone = false;
        } else {
          st.fadeT = -1;
        }
      }
      setOpacity(
        st.fadeT >= 0
          ? 1 - 0.8 * Math.sin(Math.PI * clamp01(st.fadeT / FADE))
          : 1,
      );
    } else if (st.opacity !== 1) {
      setOpacity(1);
    }

    // Pose easing toward the current stage keyframe.
    const pose = POSES[st.stage];
    const tau = st.stage === 4 ? 0.07 : 0.9;
    st.lean = ease(st.lean, pose.lean, dt, tau);
    st.headPitch = ease(st.headPitch, pose.headPitch, dt, tau);
    st.shoulder = ease(st.shoulder, pose.shoulder, dt, tau);
    st.elbow = ease(st.elbow, pose.elbow, dt, tau);
    st.eye = ease(st.eye, pose.eye, dt, st.stage === 4 ? 0.05 : 0.8);

    // Head seeks the player's eye line — imperceptibly slow at stage 1
    // (time constant ~2.6s => ~8s to settle), a little quicker when active.
    const dx = opts.playerX - group.position.x;
    const dz = opts.playerZ - group.position.z;
    const targetYaw = pose.track
      ? wrap(Math.atan2(dx, dz) - group.rotation.y)
      : 0;
    const yawTau = st.stage <= 1 ? 2.6 : st.stage === 4 ? 0.07 : 1.2;
    st.headYaw = ease(st.headYaw, targetYaw, dt, yawTau);
    const lookUp = pose.track
      ? Math.atan2(opts.eyeHeight - 1.45, Math.hypot(dx, dz))
      : 0;

    // Twitch loops with long pauses, only while active/hunting.
    let jitter = 0;
    if (st.stage >= 2 && st.stage < 4) {
      if (st.time >= st.nextTwitch) {
        st.twitchEnd = st.time + 0.1 + rnd() * 0.12;
        st.nextTwitch = st.time + 2.5 + rnd() * 4.5;
      }
      if (st.time < st.twitchEnd) jitter = 0.02 * Math.sin(st.time * 61);
    }

    body.rotation.x = st.lean;
    body.rotation.z = jitter * 0.4;
    head.rotation.x = st.headPitch - lookUp;
    head.rotation.y = st.headYaw;
    head.rotation.z = jitter;
    arms[0].shoulder.rotation.x = st.shoulder + jitter * 2;
    arms[1].shoulder.rotation.x = st.shoulder - jitter * 2;
    arms[0].elbow.rotation.x = st.elbow;
    arms[1].elbow.rotation.x = st.elbow;
    eyeMat.emissiveIntensity = st.eye;
    if (st.stage >= 2) crank.rotation.z += dt * (0.5 + st.tension);
    void time; // internal clock drives animation; param kept for API parity
  }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    scene.remove(group);
    rivets.dispose?.();
    for (const g of geoms) g.dispose?.();
    for (const m of materials) m.dispose?.();
  }

  return {
    group,
    update,
    setStage: (n) => commit(n),
    get stage() {
      return st.stage;
    },
    trigger,
    dispose,
  };
}
