// characters-extra.mjs — ORIGINAL extras for the later FNAF-style modes.
// Same API shape as characters.mjs (they share the same rig and materials):
//   {id, group, update(dt,time,state), setPose, setLookTarget, jumpscare,
//    setBlackout, setVisible, dispose, getState, stats}
//
//   marionette         tall thin masked puppet rising from a music box
//                      (poses add: boxed, rise; the lid and crank animate)
//   withered_hare      older, ruined bellwether (ear gone, forearm snapped)
//   withered_songbird  older, ruined lark (beak snapped off, tray gone)
//   withered_maestro   older, ruined maestro (hat gone, skull cracked open)
//   imp_0..imp_3       four tiny gremlins for closet scenes (~0.5 m)
//   phantom            translucent shadow figure (2 materials + void)
//   stalker            hulking horned figure for the bedroom doorway
//                      (extra poses: loom, bedside)

import {
  Part, makeKit, buildCharacter, bellwetherSpec, larkSpec, maestroSpec,
} from "./characters.mjs";

const SOCKET = 0x040303;
const BONE = 0xd8cfb4;
const WITHER = { dark: 0.72, sallow: 0.32 };

export const EXTRA_IDS = Object.freeze([
  "marionette", "withered_hare", "withered_songbird", "withered_maestro",
  "imp_0", "imp_1", "imp_2", "imp_3", "phantom", "stalker",
]);

function limb(K, { upper = 0.4, fore = 0.4, r = 0.03, mat = "body", c = 0x111111, hand = 5, handLen = 0.14 } = {}) {
  const u = new Part(K), f = new Part(K);
  u.sph("metal", [r * 1.3, 6, 5], { c: 0x555555 });
  u.cyl(mat, [r, r * 0.85, upper, 6], { p: [0, -upper / 2, 0], c });
  f.sph("metal", [r * 1.2, 6, 5], { c: 0x555555 });
  f.cyl(mat, [r * 0.8, r * 0.6, fore, 6], { p: [0, -fore / 2, 0], c });
  for (let i = 0; i < hand; i++) {
    const a = (i - (hand - 1) / 2) * 0.28;
    f.cyl(mat, [r * 0.3, r * 0.45, handLen, 4], { p: [Math.sin(a) * 0.035, -fore - handLen / 2, 0], r: [0.25, 0, -a], c });
  }
  return { u, f };
}

// --- marionette -----------------------------------------------------------

function marionetteSpec(K) {
  const black = 0x151518, white = 0xe2dccb, ribbon = 0x7a1c2c;
  const fixtures = new Part(K);
  fixtures.box("body", [0.7, 0.5, 0.7], { p: [0, 0.25, 0], c: 0x3b2447 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) fixtures.box("metal", [0.06, 0.52, 0.06], { p: [sx * 0.34, 0.26, sz * 0.34], c: 0x9a7a3a });
  fixtures.box("metal", [0.2, 0.2, 0.02], { p: [0, 0.25, 0.355], r: [0, 0, Math.PI / 4], c: 0x9a7a3a });
  fixtures.box("body", [0.14, 0.14, 0.02], { p: [0, 0.25, 0.362], r: [0, 0, Math.PI / 4], c: 0x1a0f22 });
  const lid = new Part(K);
  lid.box("body", [0.72, 0.05, 0.72], { p: [0, 0.025, 0.36], c: 0x3b2447 });
  lid.box("metal", [0.74, 0.02, 0.06], { p: [0, 0.055, 0.7], c: 0x9a7a3a });
  const crank = new Part(K);
  crank.cyl("metal", [0.015, 0.015, 0.14, 6], { p: [0.07, 0, 0], r: [0, 0, Math.PI / 2], c: 0x9a7a3a });
  crank.box("metal", [0.02, 0.2, 0.02], { p: [0.14, -0.1, 0], c: 0x9a7a3a });
  crank.sph("metal", [0.03, 6, 5], { p: [0.14, -0.2, 0], c: 0xc2a04a });

  const body = new Part(K);
  body.cone("body", [0.07, 0.95, 8], { p: [0, -0.4, 0], r: [Math.PI, 0, 0], c: black }); // tapered tail to the floor
  body.cyl("body", [0.045, 0.07, 0.8, 8], { p: [0, 0.4, 0], c: black });
  for (const y of [0.15, 0.4, 0.65]) body.tor("body", [0.06 - (y - 0.15) * 0.02, 0.012, 4, 10], { p: [0, y, 0], r: [Math.PI / 2, 0, 0], c: white });
  for (let i = 0; i < 3; i++) body.sph("body", [0.014, 5, 4], { p: [0, 0.2 + i * 0.16, 0.065], c: ribbon });
  body.box("body", [0.34, 0.04, 0.05], { p: [0, 0.8, 0], c: black });
  for (const s of [-1, 1]) body.box("body", [0.025, 0.55, 0.01], { p: [s * 0.05, 0.1, -0.07], r: [0.15, 0, s * 0.12], c: ribbon }); // loose ribbons
  body.cyl("body", [0.03, 0.04, 0.14, 6], { p: [0, 0.88, 0], c: black });

  const head = new Part(K);
  head.sph("body", [0.14, 11, 8], { p: [0, 0.14, 0], s: [0.78, 1.2, 0.8], c: white }); // mask
  head.sph("body", [0.15, 8, 6], { p: [0, 0.22, -0.07], s: [0.8, 1.05, 0.7], c: black }); // hair/hood
  for (const s of [-1, 1]) {
    head.sph("body", [0.045, 8, 6], { p: [s * 0.06, 0.2, 0.082], s: [1, 1.3, 0.6], c: SOCKET });
    head.sph("eye", [0.018, 6, 5], { p: [s * 0.06, 0.2, 0.096] });
    head.box("body", [0.012, 0.16, 0.01], { p: [s * 0.065, 0.08, 0.098], r: [0, 0, s * 0.06], c: 0x1a1a22 }); // tear streak
    head.sph("body", [0.026, 6, 4], { p: [s * 0.09, 0.07, 0.07], s: [1, 1, 0.3], c: 0x8a2a3a }); // painted cheek
  }
  head.tor("body", [0.055, 0.007, 4, 10, Math.PI], { p: [0, 0.05, 0.095], r: [0, 0, Math.PI], c: 0x2a0d12 });
  head.teeth(8, { x0: -0.05, x1: 0.05, y: 0.045, z: 0.1, w: 0.012, h: 0.025, pointed: true, c: BONE });
  const jaw = new Part(K);
  jaw.box("body", [0.09, 0.05, 0.08], { p: [0, -0.02, 0.04], c: white });
  jaw.teeth(7, { x0: -0.04, x1: 0.04, y: 0, z: 0.08, w: 0.011, h: 0.024, dir: 1, pointed: true, c: BONE });

  const aL = limb(K, { upper: 0.5, fore: 0.55, r: 0.02, c: black }), aR = limb(K, { upper: 0.5, fore: 0.55, r: 0.02, c: black });
  return {
    id: "marionette", headScale: 1.25, hipY: 0.9, headTop: 2.0, jawMax: 0.55,
    eye: { color: 0xffffff, base: 0.15, glow: 1.9 },
    fixtures, legs: null, body,
    head: { pos: [0, 0.9, 0.0], part: head }, jaw: { pos: [0, 0.0, 0.0], part: jaw },
    arms: { L: { pos: [-0.17, 0.78, 0], upper: aL.u, elbow: [0, -0.5, 0], fore: aL.f }, R: { pos: [0.17, 0.78, 0], upper: aR.u, elbow: [0, -0.5, 0], fore: aR.f } },
    extras: [
      { name: "lid", parent: "root", pos: [0, 0.5, -0.36], part: lid, anim: (o, t, c) => { o.rotation.x = -c.lid * 1.9; } },
      { name: "crank", parent: "root", pos: [0.35, 0.3, 0], part: crank, anim: (o, t, c) => { o.rotation.x = c.lid > 0.5 ? t * 2 : 0; } },
    ],
    base: { rise: 0, lid: 1 },
    poses: {
      boxed: { rise: -1.7, lid: 0, eye: 0.1, look: 0, hp: 0.3, jaw: 0, aL: [0.2, 0.1, 0.5], aR: [0.2, 0.1, 0.5] },
      rise: { rise: 0, lid: 1, eye: 1.1, look: 1, aL: [0.1, 0.5, 0.1], aR: [0.1, 0.5, 0.1], hp: -0.05 },
      idle: { rise: -0.6, lid: 1, eye: 0.4, hp: 0.12 },
      stare: { rise: 0, lid: 1, eye: 1.2, look: 1, aL: [0.1, 0.4, 0.15], aR: [0.1, 0.4, 0.15] },
      peek: { rise: -1.0, lid: 1, rx: 0, ry: 0, sway: 0.15, twist: 0, hr: -0.35, aL: [0.3, 0.8, 0.4], aR: [0.3, 0.8, 0.4] },
      lean: { rise: 0, lid: 1, lean: 0.7, hp: -0.35, aL: [1.3, 0.3, 0.1], aR: [1.3, 0.3, 0.1] },
      jumpscare: { rise: 0, lid: 1, lean: 0.55, aL: [1.7, 0.7, 0.1], aR: [1.7, 0.7, 0.1], eye: 4, jaw: 1 },
    },
  };
}

// --- imps -------------------------------------------------------------------

function impSpec(K, n) {
  const skin = [0x5d6a52, 0x5a3f5c, 0x7a4a30, 0x777066][n];
  const dark = 0x1a1612;
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("body", [0.025, 0.02, 0.12, 5], { p: [0, -0.06, 0], c: skin });
    sh.cyl("body", [0.02, 0.014, 0.12, 5], { p: [0, -0.06, 0], c: skin });
    sh.box("body", [0.05, 0.02, 0.09], { p: [0, -0.12, 0.025], c: dark });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.04, 0.24, 0], thigh: th, knee: [0, -0.12, 0], shin: sh };
  }
  const body = new Part(K);
  body.sph("body", [0.1, 9, 7], { p: [0, 0.12, 0], s: [0.9, 1.1, 0.8], c: skin });
  body.tor("metal", [0.09, 0.008, 4, 8], { p: [0, 0.02, 0], r: [Math.PI / 2, 0, 0], c: 0x6a5a3a });
  const longArms = n === 3 ? 1.5 : 1;
  const head = new Part(K);
  head.sph("body", [0.14, 10, 8], { p: [0, 0.12, 0], s: [1, 0.95, 0.95], c: skin });
  const eyeR = n === 1 ? 0.05 : 0.04;
  if (n === 1) { // cyclops
    head.sph("body", [0.07, 8, 6], { p: [0, 0.15, 0.1], s: [1, 1, 0.6], c: SOCKET });
    head.sph("eye", [eyeR, 7, 5], { p: [0, 0.15, 0.115] });
  } else {
    for (const s of [-1, 1]) {
      head.sph("body", [0.05, 8, 6], { p: [s * 0.065, 0.15, 0.1], s: [1, 1.1, 0.6], c: SOCKET });
      head.sph("eye", [eyeR * (s < 0 && n === 2 ? 0.6 : 1), 6, 5], { p: [s * 0.065, 0.15, 0.115] });
    }
  }
  head.teeth(n === 3 ? 11 : 9, { x0: -0.08, x1: 0.08, y: 0.03, z: 0.125, w: 0.014, h: 0.03, pointed: true, curve: 1.5, c: BONE });
  if (n === 0) for (const s of [-1, 1]) head.cone("body", [0.025, 0.14, 5], { p: [s * 0.09, 0.27, 0], r: [0, 0, -s * 0.35], c: 0x2a2620 });
  if (n === 2) for (const s of [-1, 1]) head.sph("body", [0.04, 6, 5], { p: [s * 0.07, 0.4, -0.02], s: [0.7, 4, 0.3], r: [0, 0, -s * 0.15], c: skin });
  if (n !== 2) for (const s of [-1, 1]) head.cone("body", [0.04, 0.1, 4], { p: [s * 0.14, 0.14, 0], r: [0, 0, -s * 1.2], c: skin });
  const jaw = new Part(K);
  jaw.box("body", [0.14, 0.03, n === 3 ? 0.14 : 0.1], { p: [0, -0.015, 0.06], c: skin });
  jaw.teeth(8, { x0: -0.06, x1: 0.06, y: 0, z: 0.11, w: 0.013, h: 0.026, dir: 1, pointed: true, c: BONE });
  const aL = limb(K, { upper: 0.12 * longArms, fore: 0.12 * longArms, r: 0.018, c: skin, hand: 3, handLen: 0.06 });
  const aR = limb(K, { upper: 0.12 * longArms, fore: 0.12 * longArms, r: 0.018, c: skin, hand: 3, handLen: 0.06 });
  return {
    id: "imp_" + n, hipY: 0.24, headTop: 0.4, jawMax: n === 3 ? 1.0 : 0.8, tau: 0.22,
    eye: { color: [0xb4ff8a, 0xe08aff, 0xffa05a, 0xffffff][n], base: 0.5, glow: 1.9 },
    legs, body,
    head: { pos: [0, 0.3, 0.0], part: head }, jaw: { pos: [0, 0.02, 0.02], part: jaw },
    arms: { L: { pos: [-0.1, 0.2, 0], upper: aL.u, elbow: [0, -0.12 * longArms, 0], fore: aL.f }, R: { pos: [0.1, 0.2, 0], upper: aR.u, elbow: [0, -0.12 * longArms, 0], fore: aR.f } },
    extras: [],
    base: { eye: 0.8 },
    poses: {
      idle: { crouch: 0.15, hp: 0.1, eye: 0.7, aL: [0.2, 0.3, 0.5], aR: [0.2, 0.3, 0.5] },
      stare: { crouch: 0.1, look: 1, eye: 1.3 },
      peek: { rx: 0.2, sway: 0.4, hr: -0.4, aR: [0.5, 1.2, 0.5] },
      lean: { lean: 0.5, crouch: 0.2, aL: [1.2, 0.4, 0.4], aR: [1.2, 0.4, 0.4] },
    },
  };
}

// --- phantom ----------------------------------------------------------------

function phantomSpec(K) {
  const body = new Part(K);
  body.cone("body", [0.3, 1.5, 9], { p: [0, 0.1, 0], r: [Math.PI, 0, 0], c: 0xffffff });
  body.cyl("body", [0.14, 0.3, 0.7, 9], { p: [0, 0.7, 0], c: 0xffffff });
  for (let i = 0; i < 6; i++) { // ragged cloak strips
    const a = (i / 6) * Math.PI * 2;
    body.cone("body", [0.06, 0.5 + (i % 3) * 0.12, 4], { p: [Math.sin(a) * 0.28, -0.35, Math.cos(a) * 0.28], r: [Math.PI, 0, 0], c: 0xffffff });
  }
  const head = new Part(K);
  head.sph("body", [0.12, 9, 7], { p: [0, 0.14, 0], s: [0.8, 1.5, 0.9], c: 0xffffff });
  for (const s of [-1, 1]) head.sph("eye", [0.022, 6, 5], { p: [s * 0.045, 0.19, 0.08], s: [1, 1.8, 0.6] });
  const mk = () => limb(K, { upper: 0.55, fore: 0.6, r: 0.03, c: 0xffffff, hand: 4, handLen: 0.2 });
  const aL = mk(), aR = mk();
  return {
    id: "phantom", hipY: 1.0, headTop: 1.9, jawMax: 0.4,
    eye: { color: 0xcfe8ff, base: 0.8, glow: 1.8 },
    phantom: true,
    legs: null, body,
    head: { pos: [0, 1.0, 0], part: head }, jaw: { pos: [0, 0, 0], part: new Part(K) },
    arms: { L: { pos: [-0.2, 0.9, 0], upper: aL.u, elbow: [0, -0.55, 0], fore: aL.f }, R: { pos: [0.2, 0.9, 0], upper: aR.u, elbow: [0, -0.55, 0], fore: aR.f } },
    extras: [],
    poses: {
      idle: { eye: 0.8, hp: 0.2, aL: [0.05, 0.12, 0.05], aR: [0.05, 0.12, 0.05] },
      stare: { eye: 1.3, look: 1, aL: [0.1, 0.1, 0.05], aR: [0.1, 0.1, 0.05] },
      lean: { lean: 0.6, aL: [1.4, 0.2, 0.1], aR: [1.4, 0.2, 0.1] },
    },
  };
}

// --- stalker ----------------------------------------------------------------

function stalkerSpec(K) {
  const hide = 0x2a2420, horn = 0xb8a98a, claw = 0xc9c0a4;
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("body", [0.1, 0.07, 0.46, 7], { p: [0, -0.23, 0], c: hide });
    sh.sph("body", [0.075, 6, 5], { c: hide });
    sh.cyl("body", [0.07, 0.05, 0.42, 7], { p: [0, -0.21, 0], c: hide });
    sh.box("body", [0.12, 0.05, 0.28], { p: [0, -0.43, 0.07], c: 0x0f0c0a });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.15, 0.9, 0], thigh: th, knee: [0, -0.46, 0], shin: sh };
  }
  const body = new Part(K);
  body.sph("body", [0.34, 11, 8], { p: [0, 0.4, 0], s: [1.05, 1.2, 0.8], c: hide });
  body.sph("body", [0.2, 8, 6], { p: [-0.28, 0.65, -0.05], s: [1, 0.8, 1], c: 0x211c18 });
  body.sph("body", [0.2, 8, 6], { p: [0.28, 0.65, -0.05], s: [1, 0.8, 1], c: 0x211c18 });
  for (let i = 0; i < 5; i++) body.cone("body", [0.03, 0.2, 4], { p: [0, 0.65 - i * 0.12, -0.3], r: [-2.2, 0, 0], c: 0x3a302a }); // spine ridges
  body.box("body", [0.14, 0.25, 0.05], { p: [0.12, 0.4, 0.26], r: [0, -0.3, 0], c: SOCKET }); // gouge
  for (let i = 0; i < 3; i++) body.cyl("metal", [0.01, 0.01, 0.18, 4], { p: [0.12, 0.32 + i * 0.07, 0.28], r: [0, 0, Math.PI / 2], c: 0x8a8070 });
  const head = new Part(K);
  head.sph("body", [0.17, 10, 8], { p: [0, 0.08, 0.05], s: [1.1, 0.9, 1], c: 0x302a26 });
  for (const s of [-1, 1]) {
    head.sph("body", [0.06, 8, 6], { p: [s * 0.08, 0.1, 0.19], s: [1, 0.8, 0.6], c: SOCKET });
    head.sph("eye", [0.024, 6, 5], { p: [s * 0.08, 0.1, 0.21], s: [1.2, 0.8, 1] });
    head.tor("body", [0.14, 0.03, 5, 10, Math.PI * 1.1], { p: [s * 0.12, 0.2, 0.0], r: [0, Math.PI / 2, s > 0 ? 0.3 : 3.4], c: horn });
  }
  head.teeth(10, { x0: -0.1, x1: 0.1, y: -0.02, z: 0.2, w: 0.02, h: 0.06, pointed: true, curve: 1.2, c: BONE });
  head.teeth(6, { x0: -0.07, x1: 0.07, y: -0.03, z: 0.17, w: 0.016, h: 0.045, pointed: true, curve: 1.2, c: scaleCol(BONE, 0.8) });
  const jaw = new Part(K);
  jaw.box("body", [0.22, 0.04, 0.22], { p: [0, -0.02, 0.1], c: 0x302a26 });
  jaw.teeth(9, { x0: -0.09, x1: 0.09, y: 0, z: 0.2, w: 0.018, h: 0.05, dir: 1, pointed: true, curve: 1.2, c: BONE });
  const mk = () => {
    const a = limb(K, { upper: 0.6, fore: 0.62, r: 0.06, c: hide, hand: 4, handLen: 0.0 });
    for (let i = 0; i < 4; i++) a.f.cone("metal", [0.02, 0.2, 4], { p: [(i - 1.5) * 0.035, -0.72, 0.02], r: [0.2, 0, (i - 1.5) * 0.12], c: claw });
    return a;
  };
  const aL = mk(), aR = mk();
  return {
    id: "stalker", hipY: 0.9, headTop: 1.9, jawMax: 0.85, tau: 0.4,
    eye: { color: 0xff3a2a, base: 0.3, glow: 1.9 },
    legs, body,
    head: { pos: [0, 0.78, 0.1], part: head }, jaw: { pos: [0, -0.03, 0.04], part: jaw },
    arms: { L: { pos: [-0.42, 0.68, 0], upper: aL.u, elbow: [0, -0.6, 0], fore: aL.f }, R: { pos: [0.42, 0.68, 0], upper: aR.u, elbow: [0, -0.6, 0], fore: aR.f } },
    extras: [],
    base: { lean: 0.3, hp: 0.1 },
    poses: {
      idle: { lean: 0.35, hp: 0.2, eye: 0.4, aL: [0.0, 0.2, 0.1], aR: [0.0, 0.2, 0.1] },
      stare: { lean: 0.3, hp: 0.0, eye: 1.2 },
      peek: { lean: 0.3, aR: [0.1, 1.45, 0.15] },
      lean: { lean: 0.7, hp: -0.3 },
      loom: { lean: 0.45, hp: -0.05, look: 1, eye: 1.4, jaw: 0.3, aL: [0.2, 1.4, 0.2], aR: [0.2, 1.4, 0.2] },
      bedside: { lean: 0.95, hp: -0.55, look: 1, eye: 1.6, jaw: 0.6, crouch: 0.1, aL: [1.0, 0.3, 0.2], aR: [1.0, 0.3, 0.2] },
      jumpscare: { lean: 0.7, hp: -0.3, aL: [1.7, 0.7, 0.1], aR: [1.7, 0.7, 0.1] },
    },
  };
}
function scaleCol(hex, k) {
  return ((Math.round(((hex >> 16) & 255) * k) << 16) | (Math.round(((hex >> 8) & 255) * k) << 8) | Math.round((hex & 255) * k));
}

// --- factories --------------------------------------------------------------

export function createExtraCharacter(THREE, id, options = {}) {
  const K = makeKit(THREE);
  let spec;
  if (id === "marionette") spec = marionetteSpec(K);
  else if (id === "withered_hare") spec = bellwetherSpec(K, { id, wear: WITHER, noEarL: true, noForeL: true });
  else if (id === "withered_songbird") spec = larkSpec(K, { id, wear: WITHER, noJaw: true, noTray: true });
  else if (id === "withered_maestro") spec = maestroSpec(K, { id, wear: WITHER, noHat: true });
  else if (/^imp_[0-3]$/.test(id)) spec = impSpec(K, Number(id[4]));
  else if (id === "phantom") spec = phantomSpec(K);
  else if (id === "stalker") spec = stalkerSpec(K);
  else throw new Error(`unknown extra character id: ${id}`);

  if (id.startsWith("withered_")) {
    // sag the ruined variants: slack jaw, drooping posture, dimmer sputtering eyes.
    spec.eye = { ...spec.eye, base: 0.2 };
    spec.poses = { ...(spec.poses || {}), idle: { ...(spec.poses?.idle || {}), jaw: 0.4, hp: 0.25, lean: 0.12 } };
    spec.tau = 0.5;
  }
  return buildCharacter(THREE, spec, options);
}

const EXTRA_ROOMS = {
  marionette: { x: 0, z: -4.6 }, withered_hare: { x: -3, z: -3.6 }, withered_songbird: { x: -1, z: -3.6 },
  withered_maestro: { x: 1, z: -3.6 }, imp_0: { x: -3.2, z: -2.4 }, imp_1: { x: -2.6, z: -2.4 },
  imp_2: { x: 2.6, z: -2.4 }, imp_3: { x: 3.2, z: -2.4 }, phantom: { x: 3, z: -3.6 }, stalker: { x: 0, z: -3.2 },
};

export function createExtras(THREE, scene, rooms = {}, options = {}) {
  const characters = {};
  for (const id of EXTRA_IDS) {
    const r = { ...EXTRA_ROOMS[id], ...(rooms[id] || {}) };
    const c = createExtraCharacter(THREE, id, { ...options, position: { x: r.x, y: r.y ?? 0, z: r.z }, rotationY: r.yaw ?? 0 });
    if (scene) scene.add(c.group);
    characters[id] = c;
  }
  const list = Object.values(characters);
  return {
    characters, list,
    update(dt, time, state) { for (const c of list) c.update(dt, time, (state && state[c.id]) || state || {}); },
    setBlackout(b) { for (const c of list) c.setBlackout(b); },
    dispose() { for (const c of list) c.dispose(); },
  };
}
