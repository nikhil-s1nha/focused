// Canvas painters for the simple horror room: layered peeling paint, blood
// fields with long drips, cracked tile floor, stained ceiling and prop skins.
// Pure 2D canvas, deterministic through the supplied rnd(). No external art.

const rgba = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const TAU = Math.PI * 2;

export const BLOOD = { fresh: [77, 19, 16], mid: [57, 15, 12], dark: [29, 10, 8], dried: [49, 25, 15] };

// Closed smooth path through points (midpoint quadratic smoothing).
function smoothPath(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  const m0 = [(pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2];
  ctx.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  ctx.closePath();
}

function blobPts(rnd, cx, cy, rx, ry, n = 14, jit = 0.4) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = 1 - jit + rnd() * jit * 2 * 0.85;
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  return pts;
}

export function drip(ctx, rnd, x, y, len, wd, a = 1) {
  const g = ctx.createLinearGradient(x, y, x, y + len);
  g.addColorStop(0, rgba(BLOOD.dark, a));
  g.addColorStop(0.22, rgba(BLOOD.mid, a));
  g.addColorStop(0.8, rgba(BLOOD.fresh, a * 0.95));
  g.addColorStop(1, rgba(BLOOD.mid, a));
  ctx.fillStyle = g;
  const w0 = wd * (0.9 + rnd() * 0.5);
  const wob = (rnd() - 0.5) * wd * 1.4;
  ctx.beginPath();
  ctx.moveTo(x - w0, y);
  ctx.quadraticCurveTo(x - wd * 0.45 + wob, y + len * 0.5, x - wd * 0.5 + wob * 0.4, y + len);
  ctx.arc(x + wob * 0.3, y + len, wd * (0.55 + rnd() * 0.25), Math.PI, 0, true);
  ctx.quadraticCurveTo(x + wd * 0.45 + wob, y + len * 0.5, x + w0, y);
  ctx.closePath();
  ctx.fill();
  if (wd > 1.6) {
    ctx.fillStyle = `rgba(255,170,160,${(0.28 * a).toFixed(3)})`;
    ctx.fillRect(x - wd * 0.28, y + len * 0.12, Math.max(0.8, wd * 0.28), len * 0.78);
    ctx.beginPath();
    ctx.arc(x - wd * 0.15 + wob * 0.3, y + len + wd * 0.1, Math.max(0.8, wd * 0.22), 0, TAU);
    ctx.fill();
  }
}

export function splatterField(ctx, rnd, cx, cy, rx, ry, power = 1, maxDrip = 400) {
  // Soft wash so the field reads as one soaked area.
  const wash = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
  wash.addColorStop(0, "rgba(110,8,12,0.55)");
  wash.addColorStop(0.6, "rgba(96,8,12,0.3)");
  wash.addColorStop(1, "rgba(96,8,12,0)");
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = wash;
  ctx.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);
  ctx.restore();
  // Big clots / splashes.
  for (let i = 0; i < 9 * power; i++) {
    const a = rnd() * TAU;
    const d = Math.pow(rnd(), 0.8);
    const x = cx + Math.cos(a) * d * rx * 0.8;
    const y = cy + Math.sin(a) * d * ry * 0.8;
    const r = 10 + rnd() * 38;
    smoothPath(ctx, blobPts(rnd, x, y, r, r * (0.6 + rnd() * 0.6), 11, 0.5));
    ctx.fillStyle = rgba(rnd() > 0.4 ? BLOOD.mid : BLOOD.dark, 0.85);
    ctx.fill();
    // Satellite droplets and a wet highlight.
    for (let k = 0; k < 6; k++) {
      const aa = rnd() * TAU;
      const dd = r * (1.1 + rnd() * 1.6);
      ctx.beginPath();
      ctx.arc(x + Math.cos(aa) * dd, y + Math.sin(aa) * dd, 1 + rnd() * 4, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,150,140,0.22)";
    ctx.beginPath();
    ctx.ellipse(x - r * 0.25, y - r * 0.25, r * 0.22, r * 0.1, -0.5, 0, TAU);
    ctx.fill();
  }
  // Directional spray: thin streaks flung outward.
  for (let i = 0; i < 70 * power; i++) {
    const a = rnd() * TAU;
    const d0 = rnd() * 0.5;
    const d1 = d0 + 0.2 + rnd() * 0.8;
    ctx.strokeStyle = rgba(rnd() > 0.35 ? BLOOD.mid : BLOOD.dark, 0.35 + rnd() * 0.55);
    ctx.lineWidth = 0.7 + rnd() * rnd() * 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * rx * d0, cy + Math.sin(a) * ry * d0);
    ctx.quadraticCurveTo(
      cx + Math.cos(a + 0.2) * rx * (d0 + d1) * 0.5,
      cy + Math.sin(a + 0.2) * ry * (d0 + d1) * 0.5,
      cx + Math.cos(a) * rx * d1,
      cy + Math.sin(a) * ry * d1,
    );
    ctx.stroke();
  }
  // Droplet dust.
  for (let i = 0; i < 420 * power; i++) {
    const a = rnd() * TAU;
    const d = Math.pow(rnd(), 0.65);
    const s = 0.6 + rnd() * rnd() * 3.6;
    ctx.fillStyle = rgba(rnd() > 0.3 ? BLOOD.mid : BLOOD.dark, 0.55 + rnd() * 0.45);
    ctx.beginPath();
    ctx.ellipse(cx + Math.cos(a) * d * rx * 1.1, cy + Math.sin(a) * d * ry * 1.1, s * (1 + rnd() * 1.5), s, a, 0, TAU);
    ctx.fill();
  }
  // Many thin drips of varied length and opacity, some very long.
  for (let i = 0; i < 46 * power; i++) {
    const x = cx + (rnd() - 0.5) * rx * 1.9;
    const y = cy + (rnd() - 0.55) * ry * 1.2;
    const len = 30 + Math.pow(rnd(), 1.7) * maxDrip;
    drip(ctx, rnd, x, y, len, 1.2 + rnd() * rnd() * 4.2, 0.55 + rnd() * 0.45);
  }
}

export function handprint(ctx, rnd, x, y, s, rot, a = 0.9) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = rgba(BLOOD.mid, a);
  ctx.beginPath();
  ctx.ellipse(0, 0, 22 * s, 26 * s, 0, 0, TAU);
  ctx.fill();
  for (let f = 0; f < 4; f++) {
    ctx.beginPath();
    ctx.ellipse((f - 1.5) * 12 * s, -(40 + (f === 1 || f === 2 ? 8 : 0)) * s, 5.4 * s, 19 * s, (f - 1.5) * 0.1, 0, TAU);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(-25 * s, -4 * s, 6 * s, 16 * s, -0.9, 0, TAU);
  ctx.fill();
  const g = ctx.createLinearGradient(0, 10 * s, 0, 120 * s);
  g.addColorStop(0, rgba(BLOOD.mid, a * 0.9));
  g.addColorStop(1, rgba(BLOOD.mid, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-18 * s, 10 * s, 36 * s, 110 * s);
  for (let d = 0; d < 5; d++) drip(ctx, rnd, (d - 2) * 11 * s, 14 * s, (30 + rnd() * 90) * s, 1.6 * s, a);
  ctx.restore();
}

export function dragMark(ctx, rnd, x0, y0, x1, y1, wd) {
  // Four finger tracks dragged from (x0,y0) to (x1,y1), fading as the hand lifts.
  for (let t = 0; t < 5; t++) {
    const o = (t - 2) * wd * 0.55;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, rgba(BLOOD.mid, 0.92));
    g.addColorStop(0.6, rgba(BLOOD.dark, 0.7));
    g.addColorStop(1, rgba(BLOOD.dark, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = wd * (0.3 + rnd() * 0.25);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0 + o, y0);
    ctx.bezierCurveTo(x0 + o + (rnd() - 0.5) * 20, y0 + (y1 - y0) * 0.3, x1 + o - (rnd() - 0.5) * 20, y0 + (y1 - y0) * 0.7, x1 + o, y1 - rnd() * (y1 - y0) * 0.25);
    ctx.stroke();
  }
}

export function clawGouges(ctx, rnd, x, y, len, count, plaster) {
  for (let c = 0; c < count; c++) {
    const ox = c * 14;
    ctx.strokeStyle = "rgba(14,10,8,0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + ox, y);
    ctx.bezierCurveTo(x + ox + 10, y + len * 0.3, x + ox - 7, y + len * 0.7, x + ox + 5, y + len);
    ctx.stroke();
    ctx.strokeStyle = rgba(plaster, 0.55); // exposed plaster edge
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x + ox + 3.5, y);
    ctx.bezierCurveTo(x + ox + 13.5, y + len * 0.3, x + ox - 3.5, y + len * 0.7, x + ox + 8.5, y + len);
    ctx.stroke();
  }
}

function mould(ctx, rnd, x, y, r, tint = [14, 22, 14]) {
  for (let i = 0; i < 90; i++) {
    const a = rnd() * TAU;
    const d = Math.pow(rnd(), 0.7) * r;
    ctx.fillStyle = rgba(tint, 0.1 + rnd() * 0.3);
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, 1.5 + rnd() * 7, 0, TAU);
    ctx.fill();
  }
}

function crack(ctx, rnd, x, y, len, branchy = true, lw = 2.2) {
  let px = x;
  let py = y;
  const segs = Math.round(len / 14);
  const pts = [[px, py]];
  for (let k = 0; k < segs; k++) {
    px += (rnd() - 0.45) * 22;
    py += 6 + rnd() * 14;
    pts.push([px, py]);
    if (branchy && rnd() > 0.82) crack(ctx, rnd, px, py, len * 0.35, false, lw * 0.6);
  }
  for (const [col, off, w] of [
    ["rgba(18,14,10,0.9)", 0, lw],
    ["rgba(220,210,170,0.3)", 2, lw * 0.5],
  ]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0] + off, p[1]) : ctx.moveTo(p[0] + off, p[1])));
    ctx.stroke();
  }
}

// Layered peel: paint over yellowed plaster over brick, irregular edges, curled flakes.
function peelPatch(ctx, rnd, cx, cy, rx, ry, pal, deep) {
  const pts = blobPts(rnd, cx, cy, rx, ry, 15, 0.45);
  smoothPath(ctx, pts);
  const g = ctx.createLinearGradient(cx, cy - ry, cx, cy + ry);
  g.addColorStop(0, rgba(mix(pal.plaster, [0, 0, 0], 0.4), 1));
  g.addColorStop(0.5, rgba(pal.plaster, 1));
  g.addColorStop(1, rgba(mix(pal.plaster, [255, 240, 200], 0.15), 1));
  ctx.fillStyle = g;
  ctx.fill();
  // Plaster grain.
  ctx.save();
  smoothPath(ctx, pts);
  ctx.clip();
  for (let i = 0; i < 28; i++) {
    ctx.fillStyle = `rgba(60,44,24,${(0.06 + rnd() * 0.12).toFixed(3)})`;
    ctx.fillRect(cx + (rnd() - 0.5) * rx * 2, cy + (rnd() - 0.5) * ry * 2, 2 + rnd() * 12, 1 + rnd() * 3);
  }
  if (deep) {
    // Brick showing through the plaster.
    const ip = blobPts(rnd, cx + (rnd() - 0.5) * rx * 0.3, cy + (rnd() - 0.2) * ry * 0.3, rx * 0.55, ry * 0.5, 12, 0.4);
    smoothPath(ctx, ip);
    ctx.fillStyle = rgba(pal.brick, 1);
    ctx.fill();
    ctx.save();
    smoothPath(ctx, ip);
    ctx.clip();
    ctx.strokeStyle = "rgba(30,22,18,0.7)";
    ctx.lineWidth = 2.5;
    for (let r = -6; r < 7; r++) {
      const yy = cy + r * 18;
      ctx.beginPath();
      ctx.moveTo(cx - rx, yy);
      ctx.lineTo(cx + rx, yy);
      ctx.stroke();
      for (let c = -8; c < 9; c++) {
        const xx = cx + c * 44 + (r % 2 ? 22 : 0);
        ctx.beginPath();
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx, yy + 18);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Shadow cast into the hole by the paint lip (upper-left).
  smoothPath(ctx, pts);
  ctx.lineWidth = 14;
  ctx.strokeStyle = "rgba(0,0,0,0.38)";
  ctx.stroke();
  ctx.restore();
  // Paint lip: bright raised edge on one side, dark on the other.
  smoothPath(ctx, pts);
  ctx.lineWidth = 3;
  ctx.strokeStyle = rgba(mix(pal.paint, [255, 255, 235], 0.4), 0.75);
  ctx.save();
  ctx.translate(-1.5, -1.5);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = rgba(mix(pal.paint, [0, 0, 0], 0.55), 0.8);
  ctx.save();
  ctx.translate(2, 2);
  ctx.stroke();
  ctx.restore();
  // Curled flake hanging off the lower rim.
  if (rnd() > 0.35) {
    const fx = cx + (rnd() - 0.5) * rx;
    const fy = cy + ry * 0.85;
    const fl = 16 + rnd() * 32;
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate((rnd() - 0.5) * 0.7);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.ellipse(4, fl * 0.55, fl * 0.34, fl * 0.7, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(pal.paint, 1);
    ctx.beginPath();
    ctx.moveTo(-fl * 0.3, 0);
    ctx.quadraticCurveTo(-fl * 0.5, fl * 0.7, 0, fl);
    ctx.quadraticCurveTo(fl * 0.5, fl * 0.6, fl * 0.3, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = rgba(mix(pal.plaster, [255, 240, 200], 0.2), 0.9); // curled-under side
    ctx.beginPath();
    ctx.moveTo(-fl * 0.15, fl * 0.35);
    ctx.quadraticCurveTo(0, fl * 0.55, fl * 0.2, fl * 0.3);
    ctx.quadraticCurveTo(0, fl * 0.2, -fl * 0.15, fl * 0.35);
    ctx.fill();
    ctx.restore();
  }
}

function frame(ctx, x, y, w, h, wood, bevel = 14) {
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x + 8, y + 10, w, h);
  ctx.fillStyle = rgba(wood, 1);
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = rgba(mix(wood, [255, 230, 170], 0.3), 1);
  ctx.fillRect(x, y, w, bevel * 0.4);
  ctx.fillRect(x, y, bevel * 0.4, h);
  ctx.fillStyle = rgba(mix(wood, [0, 0, 0], 0.5), 1);
  ctx.fillRect(x, y + h - bevel * 0.4, w, bevel * 0.4);
  ctx.fillRect(x + w - bevel * 0.4, y, bevel * 0.4, h);
}

const PAL = {
  teal: {
    paint: [80, 122, 108],
    paintDark: [46, 82, 74],
    plaster: [138, 124, 90],
    brick: [118, 58, 44],
    dado: [58, 82, 72],
  },
  red: {
    paint: [132, 40, 36],
    paintDark: [84, 22, 22],
    plaster: [128, 102, 78],
    brick: [96, 42, 36],
    dado: [92, 48, 40],
  },
};

/**
 * One wall, 2560x1024 (7 m x 2.8 m; ~366 px/m, uniform scale, never stretched).
 * Door opening occupies x 1079..1481, y 256..1024 and is not rendered.
 * variant: "teal" (sick green) or "red" (blood-washed).
 */
export function paintWall(ctx, w, h, rnd, variant = "teal") {
  // Institutional plaster over old ceramic tile. The palette deliberately keeps
  // blood local: darkness comes from damp, age and occlusion, not red paint.
  const pal = { paint: [132, 129, 113], plaster: [101, 96, 79], brick: [79, 65, 51] };
  const tileY = h * 0.57;
  ctx.fillStyle = variant === "teal" ? "#838579" : "#858174";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 180; i++) {
    const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * 220;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() > .55 ? "rgba(36,35,25,.19)" : "rgba(219,215,185,.10)");
    g.addColorStop(1, "rgba(38,35,25,0)");
    ctx.fillStyle = g; ctx.fillRect(x-r,y-r,r*2,r*2);
  }
  const tw = w / 28, th = h / 12;
  ctx.fillStyle = "#33392f"; ctx.fillRect(0,tileY,w,h-tileY);
  for(let row=0; row<6; row++) for(let col=0; col<28; col++) {
    const x=col*tw, y=tileY+row*th, tone=(rnd()-.5)*18;
    ctx.fillStyle=rgba([78+tone,85+tone,73+tone]);
    ctx.fillRect(x+2,y+2,tw-4,th-4);
    ctx.fillStyle="rgba(181,184,156,.11)"; ctx.fillRect(x+3,y+3,tw-6,2);
    ctx.fillStyle="rgba(0,0,0,.23)"; ctx.fillRect(x+3,y+th-5,tw-5,3);
    if(rnd()>.91) crack(ctx,rnd,x+tw*.5,y+8,th*.6,false,.8);
  }
  // Narrow faded service stripe, uneven paint, no wallpaper or bright red wall.
  ctx.fillStyle="#5d6154";ctx.fillRect(0,tileY-15,w,12);
  ctx.fillStyle="rgba(0,0,0,.25)";ctx.fillRect(0,tileY-3,w,5);
  for(let i=0;i<24;i++) {
    const x=rnd()*w, len=80+rnd()*450, wd=6+rnd()*32;
    const g=ctx.createLinearGradient(x,0,x,len);
    g.addColorStop(0,"rgba(43,37,23,.42)");g.addColorStop(1,"rgba(43,37,23,0)");
    ctx.fillStyle=g;ctx.fillRect(x,0,wd,len);
    ctx.strokeStyle="rgba(45,39,26,.22)";ctx.lineWidth=.8;
    ctx.beginPath();ctx.moveTo(x+wd*.5,0);ctx.lineTo(x+wd*.3,len);ctx.stroke();
  }
  for(let i=0;i<45;i++) {
    const x=rnd()*w, y=rnd()*.8*tileY;
    peelPatch(ctx,rnd,x,y,8+rnd()*25,12+rnd()*48,pal,false);
  }
  crack(ctx,rnd,w*.14,0,400); crack(ctx,rnd,w*.82,40,330);
  mould(ctx,rnd,25,80,110);mould(ctx,rnd,w-40,80,130);
  // Human-sized hand streaks and a single impact area. Other surfaces stay quiet.
  const bloodX=variant==="teal"?w*.73:w*.24;
  splatterField(ctx,rnd,bloodX,h*.44,100,90,.38,110);
  handprint(ctx,rnd,bloodX+100,h*.51,.78,-.16,.72);
  dragMark(ctx,rnd,bloodX+85,h*.54,bloodX+140,h*.77,11);
  for(let i=0;i<14;i++) drip(ctx,rnd,bloodX+(rnd()-.5)*150,h*.44+rnd()*70,30+rnd()*140,.5+rnd(),.55);
  // Unlit maintenance placard, screws and a faded inventory stencil.
  ctx.fillStyle="#32362f";ctx.fillRect(w*.36,h*.23,225,100);
  ctx.strokeStyle="#686c5d";ctx.lineWidth=3;ctx.strokeRect(w*.36+3,h*.23+3,219,94);
  ctx.fillStyle="#a4a28d";ctx.font="18px monospace";ctx.fillText("SERVICE / 04",w*.36+20,h*.23+37);
  ctx.font="12px monospace";ctx.fillText("KEEP DOORS CLOSED",w*.36+20,h*.23+64);
  for(const dx of [8,216])for(const dy of [8,91]) {ctx.fillStyle="#888877";ctx.fillRect(w*.36+dx,h*.23+dy,3,3);}
  // Fine aggregate and deeply dirty perimeter sell scale without extra geometry.
  for(let i=0;i<38000;i++) {
    ctx.fillStyle=rnd()>.5?"rgba(0,0,0,.10)":"rgba(223,219,196,.07)";
    ctx.fillRect(rnd()*w,rnd()*h,.5+rnd()*1.7,.5+rnd()*1.7);
  }
  const shade=(x0,y0,x1,y1,alpha)=>{const g=ctx.createLinearGradient(x0,y0,x1,y1);g.addColorStop(0,`rgba(5,7,4,${alpha})`);g.addColorStop(1,"rgba(5,7,4,0)");ctx.fillStyle=g;ctx.fillRect(0,0,w,h);};
  shade(0,0,0,h*.24,.7);shade(0,h,0,h*.77,.7);
  shade(0,0,w*.12,0,.58);shade(w,0,w*.88,0,.58);
}

// Linear height data, independent of albedo: no painted blood/text becomes raised.
export function paintRelief(ctx,w,h,rnd,kind="wall") {
  ctx.fillStyle="#8c8c8c";ctx.fillRect(0,0,w,h);
  for(let i=0;i<26000;i++) {
    const v=110+Math.floor(rnd()*65);ctx.fillStyle=`rgb(${v},${v},${v})`;
    ctx.fillRect(rnd()*w,rnd()*h,1+rnd()*2,1+rnd()*2);
  }
  const n=kind==="floor"?14:28;
  const sy=kind==="floor"?0:h*.57;
  const dy=kind==="floor"?h/14:h/12;
  ctx.fillStyle="#484848";
  for(let x=0;x<=w;x+=w/n)ctx.fillRect(x,sy,1.8,h-sy);
  for(let y=sy;y<=h;y+=dy)ctx.fillRect(0,y,w,1.8);
}

export function paintCeiling(ctx, w, h, rnd) {
  ctx.fillStyle = "rgb(112,106,84)";
  ctx.fillRect(0, 0, w, h);
  const k = w / 1024;
  for (let i = 0; i < 14; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = (60 + rnd() * 160) * k;
    const g = ctx.createRadialGradient(x, y, r * 0.4, x, y, r);
    g.addColorStop(0, "rgba(90,66,30,0)");
    g.addColorStop(0.8, "rgba(60,44,20,0.35)");
    g.addColorStop(1, "rgba(60,44,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.save();
  ctx.scale(k, k);
  for (let i = 0; i < 6; i++) crack(ctx, rnd, rnd() * 1024, rnd() * 700, 320);
  for (let i = 0; i < 16; i++) peelPatch(ctx, rnd, rnd() * 1024, rnd() * 1024, 24 + rnd() * 60, 24 + rnd() * 60, { paint: [150, 140, 108], plaster: [96, 80, 56], brick: [80, 60, 44] }, false);
  mould(ctx, rnd, 60, 60, 150);
  mould(ctx, rnd, 960, 80, 160);
  mould(ctx, rnd, 80, 960, 160);
  mould(ctx, rnd, 950, 950, 150);
  // Blood seeping through above the drip point (world -1.2, -1.8).
  const dx = 0.329 * 1024;
  const dy = 0.757 * 1024;
  const g = ctx.createRadialGradient(dx, dy, 0, dx, dy, 150);
  g.addColorStop(0, "rgba(110,10,12,0.85)");
  g.addColorStop(0.5, "rgba(100,14,12,0.5)");
  g.addColorStop(1, "rgba(100,14,12,0)");
  ctx.fillStyle = g;
  ctx.fillRect(dx - 150, dy - 150, 300, 300);
  ctx.restore();
  const v = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

function bloodDry(ctx, rnd, x, y, r, a = 1) {
  for (let i = 0; i < 11; i++) {
    const an = rnd() * TAU;
    const d = rnd() * r * 0.5;
    smoothPath(ctx, blobPts(rnd, x + Math.cos(an) * d, y + Math.sin(an) * d, r * (0.45 + rnd() * 0.5), r * (0.35 + rnd() * 0.45), 12, 0.35));
    ctx.fillStyle = rgba(i < 2 ? BLOOD.dark : mix(BLOOD.mid, BLOOD.dried, rnd() * 0.6), 0.8 * a);
    ctx.fill();
  }
  ctx.strokeStyle = rgba(BLOOD.dark, 0.7 * a); // cracked crust
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    const a0 = rnd() * TAU;
    ctx.moveTo(x + Math.cos(a0) * r * 0.1, y + Math.sin(a0) * r * 0.1);
    ctx.lineTo(x + Math.cos(a0) * r * (0.4 + rnd() * 0.5), y + Math.sin(a0) * r * (0.4 + rnd() * 0.4));
    ctx.stroke();
  }
}

/** Floor 1024x1024 for 7x7 m (146 px/m). Canvas y grows toward +z (back wall); the front door is at the bottom edge... see room.mjs UVs. */
export function paintFloor(ctx, w, h, rnd) {
  const n = 14;
  const t = w / n;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const dark = (r + c) % 2 === 0;
      const v = (rnd() - 0.5) * 20;
      const base = dark ? [66 + v, 74 + v, 66 + v] : [102 + v, 108 + v, 94 + v];
      ctx.fillStyle = rgba(base);
      ctx.fillRect(c * t, r * t, t, t);
      if (rnd() > 0.93) {
        // missing tile: bare concrete underneath
        ctx.fillStyle = "rgb(58,54,48)";
        ctx.fillRect(c * t + 3, r * t + 3, t - 6, t - 6);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(c * t + 3, r * t + 3, t - 6, 6);
      }
    }
  ctx.strokeStyle = "rgba(24,22,16,0.9)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath();
    ctx.moveTo(i * t, 0);
    ctx.lineTo(i * t, h);
    ctx.moveTo(0, i * t);
    ctx.lineTo(w, i * t);
    ctx.stroke();
  }
  // Grime blotches and scuffs.
  for (let i = 0; i < 160; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 24 + rnd() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(20,16,8,${(0.25 + rnd() * 0.3).toFixed(2)})`);
    g.addColorStop(1, "rgba(30,24,14,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Cracks across tiles.
  for (let i = 0; i < 16; i++) {
    let x = rnd() * w;
    let y = rnd() * h;
    const dir = rnd() * TAU;
    ctx.strokeStyle = "rgba(10,10,6,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      x += Math.cos(dir + (rnd() - 0.5) * 1.2) * 24;
      y += Math.sin(dir + (rnd() - 0.5) * 1.2) * 24;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Debris: plaster/tile chunks, teal paint flakes fallen from the walls, scattered paper.
  for (let i = 0; i < 160; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const wall = Math.min(x, y, w - x, h - y) < 140;
    const flake = wall && rnd() > 0.35;
    smoothPath(ctx, blobPts(rnd, x, y, 3 + rnd() * 9, 2 + rnd() * 6, 6, 0.4));
    ctx.fillStyle = flake ? rgba([96, 142, 128], 0.9) : rgba([200 - rnd() * 80, 196 - rnd() * 80, 170 - rnd() * 80], 0.85);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x + 2, y + 3, 5, 2);
  }
  for (let i = 0; i < 14; i++) {
    ctx.save();
    ctx.translate(rnd() * w, rnd() * h);
    ctx.rotate(rnd() * TAU);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(2, 3, 34, 44);
    ctx.fillStyle = `rgb(${200 + rnd() * 40},${190 + rnd() * 40},${150 + rnd() * 30})`;
    ctx.fillRect(0, 0, 34, 44);
    ctx.fillStyle = "rgba(40,30,20,0.55)";
    for (let l = 0; l < 6; l++) ctx.fillRect(4, 6 + l * 6, 12 + rnd() * 18, 1.6);
    if (rnd() > 0.5) bloodDry(ctx, rnd, 20, 24, 14, 0.9);
    ctx.restore();
  }
  // Hanging-wire tangles lying on the floor.
  ctx.strokeStyle = "rgba(10,10,10,0.9)";
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    let x = rnd() * w;
    let y = rnd() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 9; k++) ctx.quadraticCurveTo(x + (rnd() - 0.5) * 90, y + (rnd() - 0.5) * 90, (x += (rnd() - 0.5) * 70), (y += (rnd() - 0.5) * 70));
    ctx.stroke();
  }
  // Blood: dried pools with a long dragged trail leading to the front door (bottom edge).
  bloodDry(ctx, rnd, 250, 330, 100);
  splatterField(ctx, rnd, 250, 330, 120, 100, 0.9, 40);
  bloodDry(ctx, rnd, 820, 210, 70);
  bloodDry(ctx, rnd, 480, 880, 58);
  let tx = 280;
  let ty = 390;
  const pts = [];
  for (let i = 0; i < 24; i++) {
    tx += (512 - 280) / 24 + (rnd() - 0.5) * 10;
    ty += (h - 390) / 24 + (rnd() - 0.5) * 4;
    pts.push([tx, ty]);
  }
  for (const off of [-12, -4, 4, 12]) {
    ctx.strokeStyle = rgba(BLOOD.mid, 0.82);
    ctx.lineWidth = 7 + rnd() * 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0] + off, p[1]) : ctx.moveTo(p[0] + off, p[1])));
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,150,140,0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0] - 5, p[1]) : ctx.moveTo(p[0] - 5, p[1])));
  ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const fx = 300 + i * 18 + (i % 2 ? 22 : -22);
    const fy = 460 + i * 44;
    ctx.fillStyle = rgba(BLOOD.mid, 0.8);
    ctx.beginPath();
    ctx.ellipse(fx, fy, 9, 20, 0.2, 0, TAU);
    ctx.fill();
    for (let q = 0; q < 5; q++) {
      ctx.beginPath();
      ctx.arc(fx - 8 + q * 4, fy + 24 + (q === 0 || q === 4 ? 0 : 2), 2.4, 0, TAU);
      ctx.fill();
    }
  }
  // Mild vignette toward the room edges.
  const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.28, w / 2, h / 2, w * 0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 30000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "rgba(0,0,0,0.12)" : "rgba(200,200,170,0.05)";
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

/** Wet blood decal with alpha (glossy mesh). */
export function paintWetPool(ctx, w, h, rnd) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  for (let i = 0; i < 12; i++) {
    const a = rnd() * TAU;
    const d = rnd() * w * 0.16;
    smoothPath(ctx, blobPts(rnd, cx + Math.cos(a) * d, cy + Math.sin(a) * d, w * (0.14 + rnd() * 0.2), w * (0.12 + rnd() * 0.2), 14, 0.35));
    ctx.fillStyle = rgba(mix(BLOOD.mid, BLOOD.fresh, rnd()), 0.95);
    ctx.fill();
  }
  // Fingers of blood creeping outward.
  for (let i = 0; i < 9; i++) {
    const a = rnd() * TAU;
    ctx.strokeStyle = rgba(BLOOD.mid, 0.9);
    ctx.lineWidth = 6 + rnd() * 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * w * 0.2, cy + Math.sin(a) * w * 0.2);
    ctx.lineTo(cx + Math.cos(a) * w * (0.34 + rnd() * 0.12), cy + Math.sin(a) * w * (0.34 + rnd() * 0.12));
    ctx.stroke();
  }
  // Wet highlights (fake gloss).
  ctx.fillStyle = "rgba(159,143,123,0.08)";
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.ellipse(cx + (rnd() - 0.5) * w * 0.3, cy + (rnd() - 0.5) * w * 0.3, w * (0.05 + rnd() * 0.06), w * 0.012, rnd() * 2, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(20,0,0,0.6)"; // darker clotted rim
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, w * 0.2, w * 0.17, 0.3, 0, TAU);
  ctx.stroke();
}

/** Stained wood (cabinets, bed frame): grain, scratches, dark blood-brown stains. */
export function paintWood(ctx, w, h, rnd) {
  ctx.fillStyle = "rgb(78,56,40)";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    ctx.strokeStyle = `rgba(30,18,8,${(0.2 + rnd() * 0.35).toFixed(2)})`;
    ctx.lineWidth = 0.6 + rnd() * 2;
    const x = rnd() * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + rnd() * 14, h * 0.3, x - rnd() * 14, h * 0.7, x + rnd() * 6, h);
    ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(170,150,110,${(0.05 + rnd() * 0.1).toFixed(2)})`;
    ctx.fillRect(rnd() * w, rnd() * h, 20 + rnd() * 50, 1.5);
  }
  for (let i = 0; i < 5; i++) bloodDry(ctx, rnd, rnd() * w, rnd() * h, 24 + rnd() * 40, 0.7);
  for (let i = 0; i < 10; i++) drip(ctx, rnd, rnd() * w, rnd() * h * 0.5, 30 + rnd() * h * 0.5, 1.5 + rnd() * 2.5, 0.8);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.4)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Mattress / sheet: stained linen, blood-soaked centre, dried brown tide lines. */
export function paintSheet(ctx, w, h, rnd) {
  ctx.fillStyle = "rgb(138,120,92)";
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 18) {
    ctx.fillStyle = "rgba(90,70,40,0.1)";
    ctx.fillRect(0, y, w, 2);
  }
  for (let i = 0; i < 18; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 30 + rnd() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(110,80,40,0.28)");
    g.addColorStop(1, "rgba(110,80,40,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const g = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.42);
  g.addColorStop(0, "rgba(104,6,10,0.97)");
  g.addColorStop(0.65, "rgba(110,8,12,0.85)");
  g.addColorStop(1, "rgba(110,8,12,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  bloodDry(ctx, rnd, w * 0.5, h * 0.5, w * 0.22);
  splatterField(ctx, rnd, w * 0.5, h * 0.5, w * 0.4, h * 0.4, 0.6, 100);
  ctx.fillStyle = "rgba(150,132,111,0.05)";
  ctx.beginPath();
  ctx.ellipse(w * 0.45, h * 0.45, w * 0.1, w * 0.025, -0.3, 0, TAU);
  ctx.fill();
}

/** Light-shaft gradient: bright at v=1 (window end), fading toward v=0; soft edges in u. */
export function paintBeam(ctx, w, h) {
  const g = ctx.createLinearGradient(0, h, 0, 0);
  g.addColorStop(0, "rgba(220,235,255,0.9)");
  g.addColorStop(0.5, "rgba(190,215,240,0.35)");
  g.addColorStop(1, "rgba(180,205,235,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const s = ctx.createLinearGradient(0, 0, w, 0);
  s.addColorStop(0, "rgba(0,0,0,1)");
  s.addColorStop(0.3, "rgba(0,0,0,0)");
  s.addColorStop(0.7, "rgba(0,0,0,0)");
  s.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
}

/** Tattered cobweb on transparent ground (texture is a corner-hanging quad; dense toward v=1 top). */
export function paintWeb(ctx, w, h, rnd) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(235,235,225,0.75)";
  const ax = w * 0.5;
  const ay = h * 0.02;
  const spokes = 9;
  for (let s = 0; s < spokes; s++) {
    const a = Math.PI * (0.1 + 0.8 * (s / (spokes - 1)));
    const r = h * (0.7 + rnd() * 0.3);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + Math.cos(a) * r * 1.2, ay + Math.sin(a) * r);
    ctx.stroke();
  }
  for (let ring = 1; ring < 9; ring++) {
    const r = ring * h * 0.1;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let s = 0; s < spokes; s++) {
      const a = Math.PI * (0.1 + 0.8 * (s / (spokes - 1)));
      const rr = r * (0.85 + rnd() * 0.3);
      const x = ax + Math.cos(a) * rr * 1.2;
      const y = ay + Math.sin(a) * rr;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.quadraticCurveTo(ax + Math.cos(a - 0.2) * rr * 0.9 * 1.2, ay + Math.sin(a - 0.2) * rr * 0.9, x, y);
    }
    ctx.stroke();
  }
  // Dangling strands and holes.
  for (let i = 0; i < 6; i++) {
    const x = rnd() * w;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.3);
    ctx.quadraticCurveTo(x + (rnd() - 0.5) * 30, h * 0.6, x + (rnd() - 0.5) * 20, h * (0.7 + rnd() * 0.3));
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * w, h * (0.4 + rnd() * 0.5), 14 + rnd() * 22, 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}
