// Original procedural uncanny face + sculpted-looking lunge head.
// Canvas painting is browser-only; Node gets a tiny DataTexture fallback so
// budgets and disposal can be tested.

const HEAD = { rx: 0.82, rtop: 1.02, rbot: 1.1 };
// Feature coordinates live in head space (x,y), mapped planar-from-front to the texture.
const FX = (x, S) => (x / (HEAD.rx * 1.04) * 0.5 + 0.5) * S;
const FY = (y, S) => (0.5 - y / (HEAD.rbot * 1.0) * 0.5) * S;
// Eye and mouth layout, shared by painter and geometry sculpting.
// Mismatched on purpose: key -1 (viewer's left) is huge, +1 is small and sits lower.
const EYES = { [-1]: { x: 0.36, y: 0.14, rx: 0.23, ry: 0.21 }, 1: { x: 0.37, y: 0.03, rx: 0.12, ry: 0.105 } };
const mouthTop = (x) => -0.44 + 0.3 * Math.pow(Math.min(1, Math.abs(x) / 0.62), 2.2);
const mouthOpen = (x) => 0.19 * Math.max(0, 1 - Math.pow(x / 0.64, 2));

function rngFrom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultCanvas(w, h) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  return null;
}

function paintFace(ctx, S, rnd) {
  const px = (x) => FX(x, S), py = (y) => FY(y, S);
  const R = (a, b) => a + (b - a) * rnd();
  const blot = (x, y, r, color, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color.replace("A", alpha));
    g.addColorStop(1, color.replace("A", 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const sx = (w) => (w / (HEAD.rx * 1.04)) * 0.5 * S;   // head-space width -> px
  const sy = (h) => (h / HEAD.rbot) * 0.5 * S;
  const E = EYES;

  // 1. aged porcelain: ivory glaze, yellowed, with dirty undertone toward the edges
  const base = ctx.createRadialGradient(S * 0.5, S * 0.42, S * 0.05, S * 0.5, S * 0.5, S * 0.62);
  base.addColorStop(0, "#ece3d0");
  base.addColorStop(0.55, "#cfc2a6");
  base.addColorStop(1, "#4a4236");
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 120; i++) {
    const c = ["rgba(150,120,70,A)", "rgba(110,120,100,A)", "rgba(90,70,60,A)"][i % 3];
    blot(R(0.12, 0.88) * S, R(0.05, 0.95) * S, R(0.03, 0.1) * S, c, R(0.04, 0.12).toFixed(3));
  }

  // 2. painted-on doll blush, faded and uneven (one cheek nearly gone)
  blot(px(-0.5), py(-0.2), sx(0.22), "rgba(190,80,80,A)", 0.5);
  blot(px(0.5), py(-0.2), sx(0.2), "rgba(190,80,80,A)", 0.16);
  // shading
  const shade = (x, y, r, a) => blot(px(x), py(y), r * S, "rgba(20,10,8,A)", a);
  shade(-0.66, 0.1, 0.15, 0.5); shade(0.66, 0.1, 0.15, 0.55);
  shade(0, 0.3, 0.09, 0.3); shade(0, -0.8, 0.18, 0.4);

  // 3. craquelure: fine glaze web radiating from impact points
  ctx.lineCap = "round";
  const crack = (x, y, ang, len, w, d = 2) => {
    const pts = [[x, y]]; let cx = x, cy = y, a = ang;
    for (let i = 0; i < 16; i++) {
      a += R(-0.8, 0.8) * (i > 0 ? 1 : 0.2);
      cx += Math.cos(a) * len / 16; cy += Math.sin(a) * len / 16; pts.push([cx, cy]);
      if (d > 0 && rnd() < 0.16) crack(cx, cy, a + R(-1.4, 1.4), len * 0.45, w * 0.7, d - 1);
    }
    for (const [col, lw, dx] of [["rgba(255,250,235,0.4)", w * 2, 1.4], ["rgba(25,14,10,0.85)", w, 0]]) {
      ctx.beginPath(); ctx.moveTo(pts[0][0] + dx, pts[0][1] + dx);
      for (const p of pts) ctx.lineTo(p[0] + dx, p[1] + dx);
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
    }
  };
  const impacts = [[-0.1, 0.62], [0.12, -0.55], [-0.6, -0.5], [0.3, 0.38]];
  for (const [ix, iy] of impacts) for (let i = 0; i < 7; i++) crack(px(ix), py(iy), (i / 7) * 6.28 + R(-0.3, 0.3), S * R(0.06, 0.2), S * R(0.0015, 0.003));
  // one deep fracture splitting forehead down toward the big eye
  crack(px(-0.22), py(0.85), 1.95, S * 0.3, S * 0.0055, 3);
  // chipped glaze on the cheek: dark void showing through
  ctx.save(); ctx.beginPath();
  const cx0 = px(0.46), cy0 = py(-0.42);
  for (let i = 0; i < 12; i++) { const a = (i / 12) * 6.28, r = S * R(0.025, 0.055); ctx[i ? "lineTo" : "moveTo"](cx0 + Math.cos(a) * r * 1.3, cy0 + Math.sin(a) * r); }
  ctx.closePath(); ctx.fillStyle = "#17100c"; ctx.fill();
  ctx.strokeStyle = "rgba(255,248,230,0.55)"; ctx.lineWidth = S * 0.003; ctx.stroke(); ctx.restore();

  // 4. nose: small painted button nose, two dots
  blot(px(0), py(-0.1), sx(0.1), "rgba(70,40,30,A)", 0.28);
  for (const s of [-1, 1]) { ctx.fillStyle = "rgba(25,10,8,0.85)"; ctx.beginPath(); ctx.ellipse(px(s * 0.045), py(-0.2), S * 0.007, S * 0.01, 0, 0, 7); ctx.fill(); }

  // 5. mismatched eyes
  const bigEye = (ex, ey, erx, ery) => {
    blot(ex, ey, erx * 2.2, "rgba(40,18,20,A)", 0.75);
    ctx.fillStyle = "#3a1012"; ctx.beginPath(); ctx.ellipse(ex, ey, erx * 1.1, ery * 1.12, 0, 0, 7); ctx.fill();
    const g = ctx.createRadialGradient(ex - erx * 0.25, ey - ery * 0.3, erx * 0.05, ex, ey, erx);
    g.addColorStop(0, "#201c24"); g.addColorStop(0.6, "#08060a"); g.addColorStop(1, "#000");
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(ex, ey, erx, ery, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(210,225,240,0.5)"; ctx.lineWidth = S * 0.004;
    ctx.beginPath(); ctx.ellipse(ex, ey, erx * 0.95, ery * 0.95, 0, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.beginPath(); ctx.ellipse(ex - erx * 0.36, ey - ery * 0.4, erx * 0.19, ery * 0.13, -0.4, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(200,220,255,0.4)"; ctx.beginPath(); ctx.ellipse(ex + erx * 0.35, ey + ery * 0.38, erx * 0.1, ery * 0.07, 0.4, 0, 7); ctx.fill();
    // glass crack across the eye
    ctx.strokeStyle = "rgba(230,230,240,0.55)"; ctx.lineWidth = S * 0.0022;
    ctx.beginPath(); ctx.moveTo(ex + erx * 0.2, ey - ery); ctx.lineTo(ex + erx * 0.05, ey - ery * 0.3); ctx.lineTo(ex + erx * 0.3, ey + ery * 0.2); ctx.lineTo(ex + erx * 0.1, ey + ery); ctx.stroke();
  };
  const smallEye = (ex, ey, erx, ery) => {
    blot(ex, ey, erx * 2.4, "rgba(30,20,20,A)", 0.6);
    ctx.fillStyle = "#2a1210"; ctx.beginPath(); ctx.ellipse(ex, ey, erx * 1.15, ery * 1.15, 0, 0, 7); ctx.fill();
    ctx.fillStyle = "#c8cfc6"; ctx.beginPath(); ctx.ellipse(ex, ey, erx, ery, 0, 0, 7); ctx.fill();   // clouded white
    const ig = ctx.createRadialGradient(ex + erx * 0.2, ey, 0, ex + erx * 0.2, ey, erx * 0.7);
    ig.addColorStop(0, "#9bb2b8"); ig.addColorStop(0.7, "#5f7a82"); ig.addColorStop(1, "#2c3c42");
    ctx.fillStyle = ig; ctx.beginPath(); ctx.arc(ex + erx * 0.2, ey, erx * 0.62, 0, 7); ctx.fill();   // pale glass iris, off-axis
    ctx.fillStyle = "#050505"; ctx.beginPath(); ctx.arc(ex + erx * 0.28, ey, erx * 0.12, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ctx.arc(ex - erx * 0.1, ey - ery * 0.3, erx * 0.13, 0, 7); ctx.fill();
    // red hairline vein
    ctx.strokeStyle = "rgba(150,40,40,0.55)"; ctx.lineWidth = S * 0.0015;
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(ex - erx, ey + R(-ery, ery) * 0.5); ctx.lineTo(ex - erx * 0.4, ey + R(-ery, ery) * 0.3); ctx.stroke(); }
  };
  const lashes = (ex, ey, erx, ery, n, up) => {
    ctx.strokeStyle = "rgba(10,6,6,0.9)"; ctx.lineWidth = S * 0.0025;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (1.05 + (i / (n - 1)) * 0.9);
      const x0 = ex + Math.cos(a) * erx * 1.12, y0 = ey + Math.sin(a) * ery * 1.12;
      ctx.beginPath(); ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a) * S * up * R(0.8, 1.2), y0 + Math.sin(a) * S * up * R(0.8, 1.2) - S * 0.004); ctx.stroke();
    }
  };
  bigEye(px(E[-1].x * -1), py(E[-1].y), sx(E[-1].rx), sy(E[-1].ry));
  lashes(px(-E[-1].x), py(E[-1].y), sx(E[-1].rx), sy(E[-1].ry), 9, 0.035);
  smallEye(px(E[1].x), py(E[1].y), sx(E[1].rx), sy(E[1].ry));
  lashes(px(E[1].x), py(E[1].y), sx(E[1].rx), sy(E[1].ry), 5, 0.022);
  // black weeping from the big eye only
  for (let k = 0; k < 4; k++) {
    const ex = px(-E[-1].x), ey = py(E[-1].y);
    const tx = ex + R(-0.7, 0.7) * sx(E[-1].rx), ty0 = ey + sy(E[-1].ry), len = S * R(0.1, 0.3);
    const tg = ctx.createLinearGradient(0, ty0, 0, ty0 + len);
    tg.addColorStop(0, "rgba(8,4,4,0.8)"); tg.addColorStop(1, "rgba(8,4,4,0)");
    ctx.strokeStyle = tg; ctx.lineWidth = S * R(0.003, 0.008);
    ctx.beginPath(); ctx.moveTo(tx, ty0); ctx.bezierCurveTo(tx + R(-6, 6), ty0 + len * 0.3, tx + R(-12, 12), ty0 + len * 0.7, tx + R(-16, 16), ty0 + len); ctx.stroke();
  }
  // painted eyebrows: arched high on one side, flat and half-erased on the other
  ctx.lineWidth = S * 0.007; ctx.strokeStyle = "rgba(30,18,14,0.85)";
  ctx.beginPath(); ctx.moveTo(px(-0.62), py(0.46)); ctx.quadraticCurveTo(px(-0.36), py(0.66), px(-0.1), py(0.5)); ctx.stroke();
  ctx.strokeStyle = "rgba(30,18,14,0.4)"; ctx.lineWidth = S * 0.005;
  ctx.beginPath(); ctx.moveTo(px(0.14), py(0.26)); ctx.lineTo(px(0.55), py(0.2)); ctx.stroke();

  // 6. hinged jaw: seam from the pin at each cheek down to the mouth corner, rivets
  for (const s of [-1, 1]) {
    const x0 = px(s * 0.7), y0 = py(0.04), x1 = px(s * 0.6), y1 = py(mouthTop(0.62) - 0.02);
    ctx.strokeStyle = "rgba(10,6,4,0.95)"; ctx.lineWidth = S * 0.006;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + s * -6, (y0 + y1) / 2, x1, y1); ctx.stroke();
    ctx.strokeStyle = "rgba(255,248,230,0.3)"; ctx.lineWidth = S * 0.002;
    ctx.beginPath(); ctx.moveTo(x0 + 3, y0); ctx.quadraticCurveTo(x0 - s * 3, (y0 + y1) / 2, x1 + 3, y1); ctx.stroke();
    const pin = ctx.createRadialGradient(x0 - 2, y0 - 2, 1, x0, y0, S * 0.018);
    pin.addColorStop(0, "#c9b58a"); pin.addColorStop(0.6, "#6b5a38"); pin.addColorStop(1, "#1a140c");
    ctx.fillStyle = pin; ctx.beginPath(); ctx.arc(x0, y0, S * 0.016, 0, 7); ctx.fill();
    // rust bleed under the pin
    const rg = ctx.createLinearGradient(0, y0, 0, y0 + S * 0.12);
    rg.addColorStop(0, "rgba(110,50,20,0.6)"); rg.addColorStop(1, "rgba(110,50,20,0)");
    ctx.strokeStyle = rg; ctx.lineWidth = S * 0.006; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + R(-4, 4), y0 + S * 0.12); ctx.stroke();
    // small rivets along the seam
    for (let i = 1; i < 4; i++) { const t = i / 4; ctx.fillStyle = "rgba(60,48,30,0.9)"; ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, S * 0.005, 0, 7); ctx.fill(); }
  }
  // chin seam line
  ctx.strokeStyle = "rgba(20,10,8,0.5)"; ctx.lineWidth = S * 0.003;
  ctx.beginPath(); ctx.moveTo(px(-0.55), py(-0.78)); ctx.quadraticCurveTo(px(0), py(-0.9), px(0.55), py(-0.78)); ctx.stroke();

  // 7. mouth: wide stretched painted smile opening to a dark cavity, small uneven teeth
  const N = 60, XM = 0.66;
  const topPts = [], botPts = [];
  for (let i = 0; i <= N; i++) {
    const x = -XM + (2 * XM * i) / N;
    topPts.push([px(x), py(mouthTop(x))]);
    botPts.push([px(x), py(mouthTop(x) - mouthOpen(x))]);
  }
  ctx.beginPath();
  topPts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  for (let i = N; i >= 0; i--) ctx.lineTo(botPts[i][0], botPts[i][1]);
  ctx.closePath();
  const cav = ctx.createLinearGradient(0, py(-0.35), 0, py(-0.75));
  cav.addColorStop(0, "#2a0509"); cav.addColorStop(0.5, "#050102"); cav.addColorStop(1, "#14070a");
  ctx.fillStyle = cav; ctx.fill();
  const teethRow = (pts, dir, seed) => {
    let x = -XM * 0.9; const rr = rngFrom(seed);
    while (x < XM * 0.9) {
      const w = 0.03 + rr() * 0.05;
      if (rr() < 0.12) { x += w; continue; }
      const cx = x + w / 2;
      const idx = Math.max(0, Math.min(N, Math.round(((cx + XM) / (2 * XM)) * N)));
      const [bx, by] = pts[idx];
      const h = S * (0.03 + rr() * 0.05) * (0.5 + 0.5 * Math.max(0, 1 - Math.pow(cx / 0.66, 2)));
      const tw = sx(w);
      ctx.fillStyle = "#4a0c14"; ctx.beginPath(); ctx.ellipse(bx, by, tw * 0.6, S * 0.006, 0, 0, 7); ctx.fill();
      const tg = ctx.createLinearGradient(bx, by, bx, by + dir * h);
      tg.addColorStop(0, "#b0a070"); tg.addColorStop(0.4, "#f2ead2"); tg.addColorStop(1, "#cfc08a");
      ctx.fillStyle = tg;
      const lean = (rr() - 0.5) * tw * 0.5;
      ctx.beginPath(); ctx.moveTo(bx - tw / 2, by); ctx.lineTo(bx + tw / 2, by);
      ctx.lineTo(bx + lean + tw * 0.3, by + dir * h); ctx.lineTo(bx + lean - tw * 0.3, by + dir * h * (0.8 + rr() * 0.2)); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(20,8,6,0.9)"; ctx.lineWidth = S * 0.0018; ctx.stroke();
      x += w + rr() * 0.008;
    }
  };
  teethRow(topPts, 1, 1337); teethRow(botPts, -1, 7331);
  // dark worn painted lips
  for (const pts of [topPts, botPts]) {
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.strokeStyle = "rgba(110,28,36,0.9)"; ctx.lineWidth = S * 0.01; ctx.stroke();
  }
  // vertical lip cracks
  ctx.strokeStyle = "rgba(20,6,6,0.8)"; ctx.lineWidth = S * 0.0022;
  for (let i = 0; i < 14; i++) {
    const idx = (3 + rnd() * (N - 6)) | 0, p = i % 2 ? topPts[idx] : botPts[idx];
    ctx.beginPath(); ctx.moveTo(p[0], p[1] - S * 0.012); ctx.lineTo(p[0] + R(-2, 2), p[1] + S * 0.012); ctx.stroke();
  }

  // 8. grime
  for (let i = 0; i < 1800; i++) {
    const a = R(0.04, 0.18);
    ctx.fillStyle = `rgba(30,20,14,${a.toFixed(2)})`;
    const r = R(0.5, 2.2) * S / 1024; ctx.fillRect(R(0, S), R(0, S), r, r);
  }
  for (let i = 0; i < 30; i++) blot(R(0.1, 0.9) * S, R(0.1, 0.95) * S, R(0.02, 0.06) * S, "rgba(30,20,12,A)", R(0.1, 0.25).toFixed(2));

  // 9. long black hair: a curtain parted off-centre, sweeping over the small-eye side,
  // plus a few wet strands falling over the other side
  const strand = (x0, y0, tx, ty, w, a) => {
    ctx.strokeStyle = `rgba(${(8 + rnd() * 10) | 0},${(6 + rnd() * 8) | 0},${(6 + rnd() * 8) | 0},${a})`;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + R(-12, 12), y0 + (ty - y0) * 0.3, tx + R(-30, 30), y0 + (ty - y0) * 0.7, tx + R(-14, 14), ty);
    ctx.stroke();
  };
  // solid mass first
  ctx.fillStyle = "#070505";
  ctx.beginPath();
  ctx.moveTo(px(-0.15), py(1.05));
  ctx.lineTo(px(0.2), py(1.05));
  ctx.lineTo(px(0.95), py(1.05)); ctx.lineTo(px(0.95), py(-1.0));
  ctx.lineTo(px(0.62), py(-0.95));
  ctx.bezierCurveTo(px(0.5), py(-0.4), px(0.58), py(0.0), px(0.5), py(0.22));   // inner edge, passes over the small eye
  ctx.bezierCurveTo(px(0.42), py(0.42), px(0.12), py(0.6), px(-0.15), py(0.9));
  ctx.closePath(); ctx.fill();
  for (let i = 0; i < 420; i++) {
    const x0 = px(R(-0.2, 0.95)), y0 = py(R(0.95, 1.05));
    const t = R(0, 1);
    const tx = px(0.3 + 0.5 * t + R(-0.05, 0.1)), ty = py(R(-1.0, 0.2) - t * 0.2);
    strand(x0, y0, tx, ty, S * R(0.0012, 0.004), R(0.35, 0.95).toFixed(2));
  }
  // sheen on hair
  ctx.strokeStyle = "rgba(120,125,150,0.14)"; ctx.lineWidth = S * 0.002;
  for (let i = 0; i < 40; i++) { const x0 = px(R(0.0, 0.6)), y0 = py(R(0.5, 1.0)); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + R(10, 40), y0 + S * 0.2, x0 + R(40, 90), y0 + S * 0.45); ctx.stroke(); }
  // loose strands over the visible side, wet and clinging
  for (let i = 0; i < 16; i++) strand(px(R(-0.55, -0.1)), py(R(0.95, 1.02)), px(R(-0.7, -0.05)), py(R(0.15, 0.6)), S * R(0.0015, 0.0035), 0.85);
  // stray strands across the small eye
  for (let i = 0; i < 6; i++) strand(px(R(0.3, 0.5)), py(R(0.25, 0.35)), px(R(0.45, 0.55)), py(R(-0.25, -0.05)), S * 0.002, 0.7);

  const vg = ctx.createRadialGradient(S * 0.5, S * 0.5, S * 0.36, S * 0.5, S * 0.5, S * 0.58);
  vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.95)");
  ctx.fillStyle = vg; ctx.fillRect(0, 0, S, S);
}

export function createFaceTexture(THREE, { seed = 1, createCanvas, size = 1024 } = {}) {
  const make = createCanvas || defaultCanvas;
  const canvas = make(size, size);
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  let tex;
  if (!ctx) {
    const data = new Uint8Array([150, 148, 136, 255, 60, 56, 52, 255, 60, 56, 52, 255, 150, 148, 136, 255]);
    tex = new THREE.DataTexture(data, 2, 2);
    tex.needsUpdate = true;
  } else {
    paintFace(ctx, size, rngFrom(seed));
    tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
  }
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData = { procedural: true, size: ctx ? size : 2 };
  return tex;
}

const gauss = (dx, dy) => Math.exp(-(dx * dx + dy * dy));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Sculpt a unit-ish skull: brow, sunken sockets, cheekbones, nose, gaunt jaw. */
export function sculptHeadGeometry(THREE, widthSeg = 64, heightSeg = 48) {
  const g = new THREE.SphereGeometry(1, widthSeg, heightSeg);
  // rotate so the front (+Z) faces camera: SphereGeometry's +Z is at u=0.25, which is fine as positions are used directly
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const front = smooth(-0.1, 0.5, z);
    // ellipsoid, narrowing jaw, lengthened chin
    x *= HEAD.rx; y = y >= 0 ? y * HEAD.rtop : y * HEAD.rbot; z *= 0.88;
    const jaw = smooth(-0.1, -0.95, y);
    x *= 1 - 0.3 * jaw;
    z *= 1 - 0.15 * jaw;
    // texture coordinates: planar projection from the front (back smears to the dark rim)
    uv.setXY(i, Math.min(1, Math.max(0, x / (HEAD.rx * 1.04) * 0.5 + 0.5)), Math.min(1, Math.max(0, 0.5 + y / HEAD.rbot * 0.5)));
    // features
    let dz = 0;
    dz += 0.1 * gauss((x) / 0.55, (y - 0.3) / 0.09);                         // brow ridge
    for (const s of [-1, 1]) {
      const e = EYES[s], ex = s * e.x;
      dz -= (s < 0 ? 0.2 : 0.12) * gauss((x - ex) / (e.rx * 1.05), (y - e.y) / (e.ry * 1.05)); // sunken socket
      dz += 0.05 * gauss((x - ex) / (e.rx * 1.5), (y - e.y - 0.05) / (e.ry * 0.55));            // lid
      dz += 0.1 * gauss((x - s * 0.52) / 0.15, (y + 0.12) / 0.11);                              // round cheek
      dz -= 0.06 * gauss((x - s * 0.7) / 0.1, (y - 0.2) / 0.22);                                // temple
    }
    dz += 0.07 * gauss(x / 0.07, (y + 0.05) / 0.18);                           // slim bridge
    dz += 0.07 * gauss(x / 0.09, (y + 0.17) / 0.06);                           // button nose
    dz += 0.03 * gauss(x / 0.5, (y - 0.4) / 0.1);                              // brow
    dz -= 0.07 * gauss(x / 0.5, (y - mouthTop(x) + 0.09) / 0.1);               // mouth recess
    dz += 0.03 * gauss(x / 0.1, (y + 0.8) / 0.1);                              // chin
    z += dz * front;
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Head mesh for the lunge close-up. One material, one texture, <8k triangles.
 * Faces +Z; default scale makes it roughly a real head (~0.3 m tall).
 */
export function createLungeFace(THREE, opts = {}) {
  const { seed = 1, scale = 0.14, createCanvas, size } = opts;
  const geometry = sculptHeadGeometry(THREE);
  const map = createFaceTexture(THREE, { seed, createCanvas, size });
  const material = new THREE.MeshStandardMaterial({
    map, bumpMap: map, bumpScale: 1.0, roughness: 0.45, metalness: 0, color: 0xffffff,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "lunge-face";
  mesh.scale.setScalar(scale);
  mesh.userData.dispose = () => { geometry.dispose(); material.dispose(); map.dispose(); };
  return mesh;
}
