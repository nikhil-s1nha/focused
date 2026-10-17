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
//
// FNAF-style additions (all optional; legacy behavior is unchanged):
//   * options.waypoints: ordered [{x,z}, ...] path. When present, each
//     "advance" snaps to the NEXT waypoint instead of a fractional step,
//     still clamped to bounds and >= safeRadius from the player.
//   * api.setObserved(bool): while observed it cannot move — queued advances
//     hold, a snap about to land is aborted, the head tracks the player
//     faster and the eyes brighten. It only ever moves unobserved.
//   * trigger("jumpscare"): a fast ~0.6s lunge INTO the player's face —
//     the body accelerates to ~0.42m in front of the player at eye height,
//     jaw gaping, eyes at maximum flare. Entity motion only; the camera is
//     never touched. It stays latched at the face until setStage() leaves
//     stage 4, which also returns it to its pre-jump spot.
//   * api.setBlackout(bool): body fades near-invisible but both eyes stay
//     bright emissive points in the dark.

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
  Object.freeze({ lean: 0.14, headPitch: 0.55, shoulder: 0.26, elbow: 0.38, track: 0, eye: 0, jaw: 0.34 }),
  Object.freeze({ lean: 0.1, headPitch: 0.22, shoulder: 0.2, elbow: 0.3, track: 1, eye: 0.35, jaw: 0.3 }),
  Object.freeze({ lean: 0.02, headPitch: 0.04, shoulder: 0.08, elbow: 0.12, track: 1, eye: 1.3, jaw: 0.22 }),
  Object.freeze({ lean: 0, headPitch: 0, shoulder: 0.04, elbow: 0.05, track: 1, eye: 1.8, jaw: 0.18 }),
  Object.freeze({ lean: -0.45, headPitch: -0.12, shoulder: -0.5, elbow: 0.05, track: 1, eye: 4, jaw: 0.8 }),
]);

const FADE = 0.5; // seconds of opacity dip around an advance snap
const LUNGE = 0.7; // seconds a lunge holds before returning to stage 2
const JUMP = 0.6; // seconds a jumpscare takes to reach the player's face

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
    waypoints: null, // optional ordered [{x,z}] path for advances
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
  // The right eye is damaged: dimmer and unsteady — one dim + one bright.
  const eyeDimMat = new THREE.MeshStandardMaterial({
    color: 0x120a06,
    emissive: 0xd98f3a,
    emissiveIntensity: 0,
    roughness: 0.5,
    transparent: true,
  });
  const materials = [bodyMat, accentMat, eyeMat, eyeDimMat];

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

  // Asymmetric damage: a torn chest panel on the right exposing three
  // armature ribs, and a loose cable hanging off that shoulder.
  const ribGeo = geo(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6));
  for (let r = 0; r < 3; r++) {
    const rib = mesh(ribGeo, accentMat, `attendant-rib-${r}`);
    rib.rotation.z = Math.PI / 2;
    rib.rotation.y = 0.25;
    rib.position.set(0.13, 0.46 + r * 0.12, 0.23);
    body.add(rib);
  }
  const wire = mesh(
    geo(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 5)),
    bodyMat,
    "attendant-wire",
  );
  wire.position.set(0.33, 0.78, 0.09);
  wire.rotation.z = 0.42;
  wire.rotation.x = 0.18;
  body.add(wire);

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
  const eyeR = new THREE.Mesh(eyeGeo, eyeDimMat);
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
  // Caved-in plate over the dim eye — the damage reads at a glance.
  const dent = mesh(
    geo(new THREE.SphereGeometry(0.09, 8, 6)),
    accentMat,
    "attendant-dent",
  );
  dent.position.set(0.12, 0.1, 0.11);
  dent.scale.set(1, 0.65, 0.5);
  head.add(dent);
  // Slack jaw: hangs open at rest, gapes during a jumpscare.
  const jaw = new THREE.Group();
  jaw.name = "attendant-jaw";
  jaw.position.set(0, -0.1, 0.05);
  const jawPlate = mesh(
    geo(new THREE.BoxGeometry(0.13, 0.035, 0.13)),
    accentMat,
    "attendant-jaw-plate",
  );
  jawPlate.position.set(0, -0.02, 0.08);
  jaw.add(jawPlate);
  head.add(jaw);
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
    jaw: POSES[0].jaw,
    eye: 0,
    observed: false,
    blackout: false,
    wpIndex: -1,
    jumping: false,
    jumpT: 0,
    jumpFrom: null,
    jumpTo: null,
    disposed: false,
  };

  // Deterministic LCG for twitch scheduling (no Math.random in the loop).
  let seed = (options.seed ?? 0x5eed) >>> 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  function setOpacity(k, force) {
    if (!force && k === st.opacity) return;
    st.opacity = k;
    // Blackout: body near-invisible, eyes stay bright points in the dark.
    const bodyK = st.blackout ? Math.min(k, 0.05) : k;
    bodyMat.opacity = bodyK;
    accentMat.opacity = bodyK;
    const eyeK = st.blackout ? 1 : k;
    eyeMat.opacity = eyeK;
    eyeDimMat.opacity = eyeK;
  }

  function endJump() {
    if (!st.jumping) return;
    st.jumping = false;
    if (st.jumpFrom) {
      group.position.x = st.jumpFrom.x;
      group.position.z = st.jumpFrom.z;
    }
    group.position.y = 0;
    group.rotation.y = faceYaw() + 0.12;
  }

  function commit(n) {
    n = clamp(Math.round(n), 0, 4);
    if (!Number.isFinite(n) || n === st.stage) return;
    if (st.jumping && n !== 4) endJump();
    st.stage = n;
    st.awareTimer = 0;
    st.activeTimer = 0;
    st.decayTimer = 0;
    if (n === 4) st.lungeT = 0;
  }

  function snap() {
    const b = opts.bounds;
    const wps = opts.waypoints;
    if (Array.isArray(wps) && wps.length) {
      // Waypoint mode: advance one node along the authored path.
      if (st.wpIndex >= wps.length - 1) return;
      st.wpIndex += 1;
      const wp = wps[st.wpIndex];
      let x = clamp(wp.x, b.minX, b.maxX);
      let z = clamp(wp.z, b.minZ, b.maxZ);
      let dx = x - opts.playerX;
      let dz = z - opts.playerZ;
      let d = Math.hypot(dx, dz);
      if (d < 1e-6) {
        dx = group.position.x - opts.playerX;
        dz = group.position.z - opts.playerZ;
        d = Math.hypot(dx, dz) || 1;
      }
      if (d < opts.safeRadius) {
        const s = opts.safeRadius / d;
        x = opts.playerX + dx * s;
        z = clamp(opts.playerZ + dz * s, b.minZ, b.maxZ);
        x = clamp(x, b.minX, b.maxX);
      }
      group.position.x = x;
      group.position.z = z;
      group.rotation.y = faceYaw() + 0.12;
      return;
    }
    const dx = opts.playerX - group.position.x;
    const dz = opts.playerZ - group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= opts.safeRadius + 1e-6) return;
    const step = Math.min(opts.advanceStep * dist, dist - opts.safeRadius);
    group.position.x = clamp(group.position.x + (dx / dist) * step, b.minX, b.maxX);
    group.position.z = clamp(group.position.z + (dz / dist) * step, b.minZ, b.maxZ);
    group.rotation.y = faceYaw() + 0.12; // nearly facing the player now
  }

  function trigger(kind) {
    if (st.disposed) return false;
    if (kind === "advance") {
      if (st.jumping) return false;
      commit(3);
      st.pending += 1;
      return true;
    }
    if (kind === "scare") {
      if (st.stage === 4) return false;
      commit(4);
      return true;
    }
    if (kind === "jumpscare") {
      if (st.jumping) return false;
      // Lunge INTO the player's face: ~0.42m out, along the approach line.
      st.jumpFrom = { x: group.position.x, z: group.position.z };
      let dx = group.position.x - opts.playerX;
      let dz = group.position.z - opts.playerZ;
      let d = Math.hypot(dx, dz);
      if (d < 1e-6) {
        dx = 0;
        dz = 1;
        d = 1;
      }
      st.jumpTo = {
        x: opts.playerX + (dx / d) * 0.42,
        z: opts.playerZ + (dz / d) * 0.42,
      };
      st.jumpT = 0;
      st.fadeT = -1;
      st.snapDone = false;
      st.pending = 0;
      commit(4);
      st.jumping = true; // after commit so endJump isn't invoked
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

    // Lunge timing: short, then back to active. A jumpscare instead latches
    // at the player's face until setStage() pulls it out of stage 4.
    if (st.stage === 4 && !st.jumping) {
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

    // Queued advances start their fade only while UNOBSERVED — it never
    // moves while watched (the core FNAF rule).
    if (st.fadeT < 0 && st.pending > 0 && !st.observed && !st.jumping) {
      st.fadeT = 0;
      st.snapDone = false;
    }

    // Advance opacity dip + between-the-frames position snap.
    if (st.fadeT >= 0) {
      st.fadeT += dt;
      if (!st.snapDone && st.fadeT >= FADE / 2) {
        st.snapDone = true;
        if (!st.observed) {
          // The player looked away long enough: it moves between the frames.
          snap();
          st.pending = Math.max(0, st.pending - 1);
        }
        // Observed at the snap moment: abort the move, keep it queued.
      }
      if (st.fadeT >= FADE) {
        if (st.pending > 0 && !st.observed) {
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

    // Jumpscare travel: an accelerating ~0.6s lunge to the player's face.
    if (st.jumping) {
      st.jumpT += dt;
      const k = clamp01(st.jumpT / JUMP);
      const s = k * k; // ease-in — it explodes toward the face
      group.position.x = st.jumpFrom.x + (st.jumpTo.x - st.jumpFrom.x) * s;
      group.position.z = st.jumpFrom.z + (st.jumpTo.z - st.jumpFrom.z) * s;
      group.position.y = 0.18 * s; // raises the skull to the player's eye line
      group.rotation.y = faceYaw();
    }

    // Pose easing toward the current stage keyframe.
    const pose = POSES[st.stage];
    const tau = st.stage === 4 ? 0.07 : 0.9;
    st.lean = ease(st.lean, pose.lean, dt, tau);
    st.headPitch = ease(st.headPitch, pose.headPitch, dt, tau);
    st.shoulder = ease(st.shoulder, pose.shoulder, dt, tau);
    st.elbow = ease(st.elbow, pose.elbow, dt, tau);
    // Observed while roused: the eyes brighten — it knows you're looking.
    const eyeTarget = st.jumping
      ? 6
      : pose.eye + (st.observed && st.stage >= 1 ? 0.4 : 0);
    st.eye = ease(st.eye, eyeTarget, dt, st.stage === 4 ? 0.05 : 0.8);
    const jawTarget = st.jumping ? 1.15 : pose.jaw;
    st.jaw = ease(st.jaw, jawTarget, dt, st.stage === 4 ? 0.06 : 0.9);

    // Head seeks the player's eye line — imperceptibly slow at stage 1
    // (time constant ~2.6s => ~8s to settle), a little quicker when active.
    const dx = opts.playerX - group.position.x;
    const dz = opts.playerZ - group.position.z;
    const targetYaw = pose.track
      ? wrap(Math.atan2(dx, dz) - group.rotation.y)
      : 0;
    let yawTau = st.stage <= 1 ? 2.6 : st.stage === 4 ? 0.07 : 1.2;
    if (st.observed && st.stage >= 1) yawTau = Math.min(yawTau, 0.7);
    st.headYaw = ease(st.headYaw, targetYaw, dt, yawTau);
    const lookUp = pose.track
      ? Math.atan2(opts.eyeHeight - 1.45, Math.hypot(dx, dz))
      : 0;

    // Twitch loops with long pauses, only while active/hunting — plus a
    // subtle constant micro-twitch once roused (stage >= 2).
    let jitter = 0;
    if (st.stage >= 2 && st.stage < 4) {
      if (st.time >= st.nextTwitch) {
        st.twitchEnd = st.time + 0.1 + rnd() * 0.12;
        st.nextTwitch = st.time + 2.5 + rnd() * 4.5;
      }
      if (st.time < st.twitchEnd) jitter = 0.02 * Math.sin(st.time * 61);
      jitter += 0.004 * Math.sin(st.time * 23.7);
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
    jaw.rotation.x = st.jaw + jitter * 1.5;
    // Bright left eye; damaged right eye runs dim and unsteady. In blackout
    // both hold a glow floor — two points burning in the dark.
    const dim = st.eye * (0.28 + 0.07 * Math.sin(st.time * 9.3));
    eyeMat.emissiveIntensity = st.blackout ? Math.max(st.eye, 2.2) : st.eye;
    eyeDimMat.emissiveIntensity = st.blackout ? Math.max(dim, 1.3) : dim;
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

  function setObserved(on) {
    if (!st.disposed) st.observed = on === true;
  }

  function setBlackout(on) {
    if (st.disposed) return;
    st.blackout = on === true;
    setOpacity(st.opacity, true);
  }

  return {
    group,
    update,
    setStage: (n) => commit(n),
    get stage() {
      return st.stage;
    },
    get observed() {
      return st.observed;
    },
    get waypointIndex() {
      return st.wpIndex;
    },
    get jumping() {
      return st.jumping;
    },
    setObserved,
    setBlackout,
    trigger,
    dispose,
  };
}
