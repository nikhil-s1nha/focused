// camera-feed.mjs — security-camera render-to-texture + floor-map overlay.
//
// One 256x192 scene render target (rendered ~12 fps, ONLY while update() says
// active) is passed through a single full-screen post pass (barrel/fisheye,
// scanlines, noise, vignette, rolling bar, static burst, power-out black) into
// the output target whose texture is api.texture. An OSD canvas (room title,
// CAM label, REC + clock, CAMERA DISABLED / AUDIO ONLY / SIGNAL LOST) is
// sampled by the same pass, so the whole look costs 2 tiny draws per frame.
//
// XR: the RT pass runs with renderer.xr.enabled temporarily false (the correct
// way to render a side target mid XR frame). Default fps keeps this cheap; set
// opts.xrSafe=false to freeze the feed while presenting instead.
//
// API:
//   createCameraFeed(THREE, renderer, scene, rooms, opts) => {
//     texture, getMapTexture(), pickCameraAt(uv {x,y}, v up) -> roomId|null,
//     select(roomId) -> bool, getSelected(), getState(), setPowerOut(bool),
//     triggerSignalLost(seconds), setClockText(str), getMapRects(),
//     update(dt, time, { active, interference 0..1, clockText }), renderNow(),
//     stats(), dispose() }
// opts: { width=256, height=192, fps=12, disabledRooms=['kitchen'],
//         audioOnlyRooms=['kitchen'], initialRoom='showstage', xrSafe=true }

import { ROOM_IDS, ROOM_META, canvasOf } from "./rooms.mjs";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Floor plan, normalized (x right, y DOWN). Pickable rect per camera + office marker.
const MAP_RECTS = {
  backstage: [0.04, 0.06, 0.22, 0.14],
  showstage: [0.32, 0.04, 0.36, 0.15],
  cove: [0.74, 0.06, 0.22, 0.14],
  dining: [0.28, 0.25, 0.44, 0.18],
  supply: [0.04, 0.38, 0.18, 0.14],
  restrooms: [0.78, 0.3, 0.18, 0.14],
  kitchen: [0.78, 0.5, 0.18, 0.14],
  "hall-west": [0.22, 0.52, 0.12, 0.22],
  "hall-east": [0.66, 0.52, 0.12, 0.22],
  "hall-west-corner": [0.12, 0.78, 0.22, 0.1],
  "hall-east-corner": [0.66, 0.78, 0.22, 0.1],
};
const OFFICE_RECT = [0.38, 0.76, 0.24, 0.16];

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform sampler2D tScene; uniform sampler2D tOsd;
uniform float uTime, uStatic, uPower, uInterf, uSceneOn, uOsdOn; uniform vec2 uRes;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  vec2 d = c * (1.0 + 0.16 * r2);            // barrel / slight fisheye
  vec2 uv = d * 0.5 + 0.5;
  float inside = step(abs(d.x), 1.0) * step(abs(d.y), 1.0);
  // horizontal jitter band + interference tearing
  float band = smoothstep(0.02, 0.0, abs(fract(uv.y * 0.9 - uTime * 0.12) - 0.5) - 0.48);
  float tear = (hash(vec2(floor(uv.y * 40.0), floor(uTime * 12.0))) - 0.5) * 0.06 * uInterf;
  uv.x += tear + band * 0.01;
  vec3 col = texture2D(tScene, uv).rgb * uSceneOn;
  col *= 1.9;                                                 // security cams run hot
  float l = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(vec3(l), col, 0.25) * vec3(0.75, 1.0, 0.82);     // mostly mono, green tint
  col = (col - 0.5) * 1.15 + 0.5 + 0.02;
  float scan = 0.82 + 0.18 * sin(uv.y * uRes.y * 3.14159);
  col *= scan;
  float n = hash(uv * uRes + fract(uTime) * 91.7);
  col += (n - 0.5) * (0.10 + 0.25 * uInterf);
  col *= 0.85 + 0.15 * sin(uTime * 55.0);                     // mains flicker
  col += band * 0.06;
  col *= 1.0 - 0.55 * r2;                                     // vignette
  float st = hash(uv * uRes * 0.7 + floor(uTime * 24.0));
  col = mix(col, vec3(st * 0.9), clamp(uStatic, 0.0, 1.0));
  col *= inside;
  vec4 o = texture2D(tOsd, vUv);
  col = mix(col, o.rgb, o.a * uOsdOn);
  col *= uPower;
  gl_FragColor = vec4(col, 1.0);
}`;

export function createCameraFeed(THREE, renderer, scene, rooms, opts = {}) {
  const o = {
    width: 256, height: 192, fps: 12, disabledRooms: ["kitchen"], audioOnlyRooms: ["kitchen"],
    initialRoom: "showstage", xrSafe: true, ...opts,
  };
  const geos = [], mats = [], texs = [];
  const mk = { rts: [] };

  const rtOpts = { depthBuffer: true, stencilBuffer: false };
  const rtScene = new THREE.WebGLRenderTarget(o.width, o.height, rtOpts);
  const rtOut = new THREE.WebGLRenderTarget(o.width, o.height, { depthBuffer: false });
  mk.rts.push(rtScene, rtOut);
  const cam = new THREE.PerspectiveCamera(62, o.width / o.height, 0.05, 40);
  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // OSD
  const osdCanvas = canvasOf(o.width, o.height);
  const osdCtx = osdCanvas?.getContext("2d") ?? null;
  const osdTex = osdCanvas ? new THREE.CanvasTexture(osdCanvas) : null;
  if (osdTex) { osdTex.colorSpace = THREE.SRGBColorSpace; texs.push(osdTex); }
  const blankTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); blankTex.needsUpdate = true; texs.push(blankTex);

  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rtScene.texture }, tOsd: { value: osdTex ?? blankTex },
      uTime: { value: 0 }, uStatic: { value: 0 }, uPower: { value: 1 }, uInterf: { value: 0 },
      uSceneOn: { value: 1 }, uOsdOn: { value: 1 }, uRes: { value: new THREE.Vector2(o.width, o.height) },
    },
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
  });
  mats.push(postMat);
  const quadGeo = new THREE.PlaneGeometry(2, 2); geos.push(quadGeo);
  const quad = new THREE.Mesh(quadGeo, postMat); quad.frustumCulled = false; postScene.add(quad);

  // map texture
  const mapCanvas = canvasOf(256, 320);
  const mapCtx = mapCanvas?.getContext("2d") ?? null;
  const mapTex = mapCanvas ? new THREE.CanvasTexture(mapCanvas) : null;
  if (mapTex) { mapTex.colorSpace = THREE.SRGBColorSpace; texs.push(mapTex); }

  const S = {
    room: ROOM_IDS.includes(o.initialRoom) ? o.initialRoom : ROOM_IDS[0],
    burst: 0, lost: 0, power: false, clock: "12:00 AM", interf: 0,
    acc: 1, frames: 0, osdDirty: true, mapDirty: true, powerShown: false, mapBlink: -1,
    timeSecond: -1,
  };
  const stat = { framesRendered: 0, sceneRenders: 0, skippedInactive: 0 };

  const isDisabled = (id) => o.disabledRooms.includes(id);

  function drawOsd(time) {
    if (!osdCtx) return;
    const w = o.width, h = o.height, ctx = osdCtx;
    ctx.clearRect(0, 0, w, h);
    const meta = ROOM_META[S.room];
    ctx.textBaseline = "top"; ctx.fillStyle = "#e8ffe8"; ctx.font = "bold 13px monospace"; ctx.textAlign = "left";
    ctx.fillText(meta.title, 10, 8);
    ctx.textAlign = "right"; ctx.fillText(meta.label, w - 10, 8);
    ctx.textAlign = "left"; ctx.font = "12px monospace";
    const blink = Math.floor(time * 1.5) % 2 === 0;
    if (blink) { ctx.fillStyle = "#ff3030"; ctx.beginPath(); ctx.arc(16, h - 17, 4, 0, 6.3); ctx.fill(); }
    ctx.fillStyle = "#e8ffe8"; ctx.fillText("REC  " + S.clock, 26, h - 24);
    if (S.lost > 0) { ctx.textAlign = "center"; ctx.font = "bold 18px monospace"; ctx.fillStyle = "#e8ffe8"; ctx.fillText("SIGNAL LOST", w / 2, h / 2 - 9); }
    else if (isDisabled(S.room)) {
      ctx.textAlign = "center"; ctx.font = "bold 18px monospace"; ctx.fillStyle = "#e8ffe8";
      ctx.fillText("CAMERA DISABLED", w / 2, h / 2 - 20);
      if (o.audioOnlyRooms.includes(S.room)) { ctx.font = "bold 14px monospace"; ctx.fillText("AUDIO ONLY", w / 2, h / 2 + 4); }
    }
    osdTex.needsUpdate = true;
  }

  function drawMap(time) {
    if (!mapCtx) return;
    const W = 256, Hh = 320, ctx = mapCtx;
    ctx.fillStyle = "#06100a"; ctx.fillRect(0, 0, W, Hh);
    ctx.strokeStyle = "#1c3a24"; ctx.lineWidth = 1;
    for (let i = 0; i < W; i += 16) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, Hh); ctx.stroke(); }
    for (let i = 0; i < Hh; i += 16) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke(); }
    // corridors
    ctx.strokeStyle = "#2c5a38"; ctx.lineWidth = 4;
    const mid = (id) => { const r = MAP_RECTS[id] ?? OFFICE_RECT; return [(r[0] + r[2] / 2) * W, (r[1] + r[3] / 2) * Hh]; };
    for (const [a, b] of [["showstage", "dining"], ["backstage", "showstage"], ["cove", "showstage"], ["dining", "hall-west"], ["dining", "hall-east"], ["hall-west", "hall-west-corner"], ["hall-east", "hall-east-corner"], ["supply", "hall-west"], ["restrooms", "hall-east"], ["kitchen", "hall-east"]]) {
      const [x1, y1] = mid(a), [x2, y2] = mid(b); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    const flash = Math.floor(time * 2) % 2 === 0;
    ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const id of ROOM_IDS) {
      const [rx, ry, rw, rh] = MAP_RECTS[id];
      const sel = id === S.room;
      ctx.fillStyle = S.power ? "#101810" : sel ? (flash ? "#3aff6a" : "#1f9a40") : "#1a3a24";
      ctx.fillRect(rx * W, ry * Hh, rw * W, rh * Hh);
      ctx.strokeStyle = sel ? "#d8ffe0" : "#4a8a5a"; ctx.lineWidth = sel ? 2 : 1; ctx.strokeRect(rx * W, ry * Hh, rw * W, rh * Hh);
      ctx.fillStyle = sel ? "#031006" : "#bfe8c8";
      ctx.fillText(ROOM_META[id].label.replace("CAM ", ""), (rx + rw / 2) * W, (ry + rh / 2) * Hh);
    }
    const [ox, oy, ow, oh] = OFFICE_RECT;
    ctx.fillStyle = "#3a3a12"; ctx.fillRect(ox * W, oy * Hh, ow * W, oh * Hh);
    ctx.strokeStyle = "#e8d84a"; ctx.lineWidth = 1; ctx.strokeRect(ox * W, oy * Hh, ow * W, oh * Hh);
    ctx.fillStyle = "#f4ec90"; ctx.fillText("YOU", (ox + ow / 2) * W, (oy + oh / 2) * Hh);
    mapTex.needsUpdate = true;
  }

  function placeCamera(time) {
    const pose = rooms.getCameraPose(S.room); if (!pose) return false;
    cam.position.copy(pose.position);
    const dir = pose.lookAt.clone().sub(pose.position);
    const a = Math.sin(time * 0.35) * 0.2, ca = Math.cos(a), sa = Math.sin(a);
    const x = dir.x * ca + dir.z * sa, z = -dir.x * sa + dir.z * ca; dir.x = x; dir.z = z;
    cam.lookAt(pose.position.clone().add(dir));
    return true;
  }

  function renderFrame(time) {
    const U = postMat.uniforms;
    U.uTime.value = time; U.uInterf.value = S.interf;
    const sceneNeeded = !S.power && S.lost <= 0 && S.burst <= 0 && !isDisabled(S.room);
    U.uSceneOn.value = sceneNeeded ? 1 : 0;
    const staticAmt = S.power ? 0 : S.lost > 0 ? 1 : S.burst > 0 ? clamp(0.35 + S.burst * 2, 0, 1) : isDisabled(S.room) ? 0.85 : clamp(S.interf * 0.5, 0, 0.5);
    U.uStatic.value = staticAmt;
    U.uPower.value = S.power ? 0 : 1;
    U.uOsdOn.value = S.power ? 0 : 1;

    const prevTarget = renderer.getRenderTarget?.() ?? null;
    const xrWas = renderer.xr?.enabled;
    const bg = scene.background, fog = scene.fog;
    const prevRoom = rooms.getVisibleRoom?.() ?? null;
    if (renderer.xr) renderer.xr.enabled = false;
    try {
      if (sceneNeeded && placeCamera(time)) {
        scene.background = new THREE.Color(0x010302); scene.fog = null;
        rooms.setVisibleRoom(S.room);
        renderer.setRenderTarget(rtScene);
        renderer.clear?.();
        renderer.render(scene, cam);
        stat.sceneRenders++;
      }
      renderer.setRenderTarget(rtOut);
      renderer.render(postScene, postCam);
    } finally {
      scene.background = bg; scene.fog = fog;
      rooms.setVisibleRoom(prevRoom);
      renderer.setRenderTarget(prevTarget);
      if (renderer.xr) renderer.xr.enabled = xrWas;
    }
    stat.framesRendered++;
  }

  const api = {
    texture: rtOut.texture,
    getMapTexture() { return mapTex; },
    getMapRects() { return Object.fromEntries(Object.entries(MAP_RECTS).map(([k, v]) => [k, v.slice()])); },
    pickCameraAt(uv) {
      if (!uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) return null;
      const x = uv.x, y = 1 - uv.y;
      for (const id of ROOM_IDS) {
        const [rx, ry, rw, rh] = MAP_RECTS[id];
        if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return id;
      }
      return null;
    },
    select(roomId) {
      if (!ROOM_IDS.includes(roomId)) return false;
      if (roomId !== S.room) { S.room = roomId; S.burst = 0.35; S.osdDirty = S.mapDirty = true; }
      return true;
    },
    getSelected() { return S.room; },
    getState() {
      return { room: S.room, label: ROOM_META[S.room].label, staticBurst: S.burst > 0, signalLost: S.lost > 0, disabled: isDisabled(S.room), audioOnly: o.audioOnlyRooms.includes(S.room), powerOut: S.power };
    },
    setPowerOut(b) { b = !!b; if (S.power !== b) { S.power = b; S.osdDirty = S.mapDirty = true; S.acc = 1; } },
    triggerSignalLost(sec = 1.2) { S.lost = Math.max(S.lost, clamp(Number(sec) || 0, 0, 30)); S.osdDirty = true; },
    setClockText(t) { if (typeof t === "string" && t !== S.clock) { S.clock = t; S.osdDirty = true; } },
    update(dt, time, st = {}) {
      dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.5);
      if (st.clockText) api.setClockText(st.clockText);
      S.interf = clamp(Number(st.interference) || 0, 0, 1);
      if (S.burst > 0) S.burst = Math.max(0, S.burst - dt);
      if (S.lost > 0) { S.lost = Math.max(0, S.lost - dt); if (S.lost === 0) S.osdDirty = true; }
      if (!st.active) { stat.skippedInactive++; return false; }
      if (o.xrSafe === false && renderer.xr?.isPresenting) return false;
      S.acc += dt;
      const step = 1 / o.fps;
      const sec = Math.floor(time * 2);
      if (sec !== S.mapBlink) { S.mapBlink = sec; S.mapDirty = true; S.osdDirty = true; }
      if (S.acc < step) return false;
      S.acc = S.acc % step;
      if (S.osdDirty) { drawOsd(time); S.osdDirty = false; }
      if (S.mapDirty) { drawMap(time); S.mapDirty = false; }
      renderFrame(time);
      return true;
    },
    renderNow(time = 0) { drawOsd(time); drawMap(time); S.osdDirty = S.mapDirty = false; renderFrame(time); },
    stats() { return { ...stat }; },
    dispose() {
      mk.rts.forEach((r) => r.dispose()); geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose());
    },
  };
  return api;
}
