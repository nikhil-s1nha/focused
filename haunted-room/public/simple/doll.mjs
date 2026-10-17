// doll.mjs — an ORIGINAL uncanny porcelain mannequin for the doorway pool.
//
// Tall, thin, faded dress, very long neck, cracked china head with a stitched
// wide smile, one oversized glassy eye and one small one, long dark hair
// hanging over one side of the face (a gap lets the small eye peek through).
// Built with the shared character rig (same API as characters.mjs).

import { Part, makeKit, buildCharacter } from "../fnaf/world/characters.mjs";

export const DOLL_ID = "doll";

const CHINA = 0xd8d0c0, CHINA_DARK = 0xb9b09e, CRACK = 0x1c1612, SOCKET = 0x050404;
const DRESS = 0x7b8683, HEM = 0x59615f, HAIR = 0x0b0909, THREAD = 0x140c0a, SEAM = 0x3a1410;

// Head ellipsoid (head-pivot space): centre (0, 0.14, 0), radii 0.10 / 0.13 / 0.10.
const HC = 0.14, RX = 0.1, RY = 0.13, RZ = 0.1;
const surfaceZ = (x, y) => RZ * Math.sqrt(Math.max(0, 1 - (x / RX) ** 2 - ((y - HC) / RY) ** 2));

/** Thin dark segment lying on the head surface between two (x,y) points. */
function seg(P, a, b, { w = 0.004, c = CRACK, lift = 0.002 } = {}) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) * 1.12;
  const z = surfaceZ(mx, my) + lift;
  P.box("body", [len, w, 0.004], { p: [mx, my, z], r: [0, Math.atan2(mx, Math.max(z, 0.02)), Math.atan2(dy, dx)], c });
}

export function dollSpec(K) {
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("body", [0.03, 0.025, 0.5, 6], { p: [0, -0.25, 0], c: CHINA });
    sh.sph("body", [0.034, 6, 5], { c: CHINA_DARK });
    sh.cyl("body", [0.024, 0.019, 0.5, 6], { p: [0, -0.25, 0], c: CHINA });
    sh.box("body", [0.05, 0.03, 0.16], { p: [0, -0.52, 0.05], c: CHINA_DARK });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.07, 1.0, 0], thigh: th, knee: [0, -0.5, 0], shin: sh };
  }

  // body pivot sits at the hip (y = 1.0)
  const body = new Part(K);
  body.cyl("body", [0.075, 0.06, 0.5, 8], { p: [0, 0.3, 0], c: DRESS });                 // bodice
  body.cyl("body", [0.085, 0.36, 1.0, 12], { p: [0, -0.2, 0], c: DRESS });               // long skirt, hem at y 0.3
  body.cyl("body", [0.362, 0.372, 0.07, 12], { p: [0, -0.665, 0], c: HEM });             // dark hem band
  for (let i = 0; i < 6; i++) {                                                          // torn hem strips
    const a = (i / 6) * Math.PI * 2 + 0.3;
    body.box("body", [0.05, 0.16 + (i % 3) * 0.04, 0.006], {
      p: [Math.sin(a) * 0.36, -0.78, Math.cos(a) * 0.36], r: [0.12, a, 0.05 * (i % 2 ? 1 : -1)], c: HEM,
    });
  }
  for (const s of [-1, 1]) body.sph("body", [0.032, 6, 5], { p: [s * 0.1, 0.52, 0], c: CHINA_DARK }); // shoulder joints
  body.tor("body", [0.05, 0.01, 4, 10], { p: [0, 0.55, 0], r: [Math.PI / 2, 0, 0], c: CHINA_DARK }); // collar
  body.box("body", [0.07, 0.1, 0.012], { p: [0.02, 0.35, 0.065], r: [-0.1, 0, 0.1], c: 0x5d6664 });  // stain
  // elongated neck: segmented, slight S-curve
  for (let i = 0; i < 4; i++) {
    body.cyl("body", [0.021, 0.025, 0.14, 7], { p: [0, 0.62 + i * 0.12, 0.012 * Math.sin(i * 1.4)], r: [0.03 * Math.sin(i * 1.4), 0, 0], c: i % 2 ? CHINA_DARK : CHINA });
  }

  // head pivot (origin at the neck top)
  const head = new Part(K);
  head.sph("body", [RX, 14, 10], { p: [0, HC, 0], s: [1, RY / RX, RZ / RX], c: CHINA });
  // oversized glassy eye (right) and small eye (left, half hidden by hair)
  head.sph("body", [0.055, 8, 6], { p: [0.045, 0.15, 0.072], s: [1, 1.1, 0.55], c: SOCKET });
  head.sph("eye", [0.037, 9, 7], { p: [0.045, 0.15, 0.093] });
  head.sph("body", [0.03, 7, 5], { p: [-0.047, 0.125, 0.081], s: [1, 1.1, 0.55], c: SOCKET });
  head.sph("eye", [0.016, 6, 5], { p: [-0.047, 0.125, 0.093] });
  head.sph("body", [0.012, 6, 4], { p: [0, 0.095, 0.095], s: [0.8, 1.4, 1], c: CHINA_DARK });          // nose
  // stitched wide smile: a seam on a parabola, with cross stitches
  const mouthY = (x) => 0.052 + 2.7 * x * x;
  const N = 16;
  for (let i = 0; i < N; i++) {
    const x0 = -0.084 + (i / N) * 0.168, x1 = -0.084 + ((i + 1) / N) * 0.168;
    seg(head, [x0, mouthY(x0)], [x1, mouthY(x1)], { w: 0.005, c: SEAM, lift: 0.003 });
  }
  for (let i = 0; i <= N; i++) {
    const x = -0.084 + (i / N) * 0.168;
    const y = mouthY(x), z = surfaceZ(x, y) + 0.004;
    head.box("body", [0.003, 0.03, 0.004], { p: [x, y, z], r: [0, Math.atan2(x, Math.max(z, 0.02)), 0.18 * (i % 2 ? 1 : -1)], c: THREAD });
  }
  // cracks: from the big eye up, down the cheek, across the brow
  seg(head, [0.06, 0.19], [0.072, 0.225]);
  seg(head, [0.072, 0.225], [0.056, 0.255]);
  seg(head, [0.056, 0.255], [0.066, 0.268], { w: 0.003 });
  seg(head, [0.078, 0.12], [0.066, 0.09]);
  seg(head, [0.066, 0.09], [0.074, 0.07], { w: 0.003 });
  seg(head, [0.01, 0.255], [0.032, 0.235]);
  seg(head, [-0.03, 0.1], [-0.03, 0.075], { w: 0.003 });

  const jaw = new Part(K);
  jaw.sph("body", [0.05, 8, 6], { p: [0, 0.01, 0.05], s: [0.95, 0.5, 0.8], c: CHINA_DARK });

  // hair: back mass, scalp, fringe and a curtain over the left side of the face
  const hair = new Part(K);
  hair.sph("body", [0.108, 12, 8], { p: [0, HC + 0.005, -0.03], s: [1, 1.3, 1], c: HAIR });
  for (let k = 0; k < 7; k++) { // long strands behind the head, down past the shoulders
    const len = 0.85 - (k % 3) * 0.1;
    hair.cyl("body", [0.011, 0.004, len, 5], { p: [-0.07 + k * 0.0233, 0.19 - len / 2, -0.08 - (k % 2) * 0.015], c: HAIR });
  }
  for (const sx of [-1, 1]) hair.cyl("body", [0.009, 0.003, 0.6, 5], { p: [sx * 0.104, 0.1, -0.015], c: HAIR });
  const front = new Part(K); // face curtain; hidden while the close-up face is shown
  for (let i = 0; i < 5; i++) {
    const x = -0.075 + i * 0.015;
    front.box("body", [0.022, 0.09, 0.006], { p: [x, 0.245, surfaceZ(x, 0.245) + 0.006], r: [-0.4, 0, 0.05 * (i - 2)], c: HAIR });
  }
  for (let k = 0; k < 15; k++) {
    const x = -0.1 + k * 0.0072;
    if (x > -0.058 && x < -0.036) continue; // parting: the small eye peeks through
    const len = 0.9 - (k % 3) * 0.12;
    front.cyl("body", [0.0038, 0.0014, len, 4], {
      p: [x, 0.27 - len / 2, Math.max(surfaceZ(x, HC), 0.04) + 0.012], r: [0, 0, 0.03 * ((k % 3) - 1)], c: HAIR,
    });
  }

  const arm = (side) => {
    const upper = new Part(K), fore = new Part(K);
    upper.sph("body", [0.03, 6, 5], { c: CHINA_DARK });
    upper.cyl("body", [0.022, 0.019, 0.5, 6], { p: [0, -0.25, 0], c: CHINA });
    upper.cyl("body", [0.036, 0.032, 0.13, 8], { p: [0, -0.07, 0], c: DRESS }); // short faded sleeve
    fore.sph("body", [0.025, 6, 5], { c: CHINA_DARK });
    fore.cyl("body", [0.018, 0.014, 0.5, 6], { p: [0, -0.25, 0], c: CHINA });
    fore.box("body", [0.05, 0.07, 0.012], { p: [0, -0.54, 0], c: CHINA });
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.28;
      fore.cyl("body", [0.004, 0.007, 0.13, 4], { p: [Math.sin(a) * 0.027, -0.62, 0], r: [0.25, 0, -a], c: CHINA });
    }
    return { upper, fore };
  };
  const aL = arm(-1), aR = arm(1);

  return {
    id: DOLL_ID, headScale: 1, hipY: 1.0, headTop: 2.25, jawMax: 0.5, tau: 0.45,
    eye: { color: 0xd8ecff, base: 0.3, glow: 1.8 },
    legs, body,
    head: { pos: [0, 1.08, 0.03], part: head }, jaw: { pos: [0, 0.02, 0.03], part: jaw },
    arms: {
      L: { pos: [-0.1, 0.5, 0], upper: aL.upper, elbow: [0, -0.5, 0], fore: aL.fore },
      R: { pos: [0.1, 0.5, 0], upper: aR.upper, elbow: [0, -0.5, 0], fore: aR.fore },
    },
    extras: [
      { name: "hair", parent: "head", pos: [0, 0, 0], part: hair, anim: (o, t, c, b) => { o.rotation.x = b.x + Math.sin(t * 0.6 + 1) * 0.012; } },
      { name: "hairfront", parent: "head", pos: [0, 0, 0], part: front, anim: (o, t, c, b) => { o.rotation.x = b.x + Math.sin(t * 0.6 + 1) * 0.012; } },
    ],
    poses: {
      idle: { lean: 0.03, hp: 0.1, hr: 0.2, look: 0.7, eye: 0.4, jaw: 0.02, aL: [0.02, 0.09, 0.15], aR: [0.02, 0.09, 0.15] },
      stare: { hr: 0.12, hp: 0.04, eye: 0.9, aL: [0.04, 0.1, 0.1], aR: [0.04, 0.1, 0.1] },
      peek: { hr: -0.35, hp: 0.05 },
      jumpscare: { hr: 0.12 },
    },
  };
}

export function createDoll(THREE, options = {}) {
  return buildCharacter(THREE, dollSpec(makeKit(THREE)), options);
}
