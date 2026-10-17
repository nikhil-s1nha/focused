// monitor.mjs — a chunky CRT security monitor whose screen is a live render-
// target feed from a camera mounted high in the corridor, looking back at the
// room. Because the feed camera covers the corridor where the apparition
// spawns, the entity shows up ON THE MONITOR before it reaches the room —
// the classic "it's on the camera before it's in the room" beat.
//
// Render-target pattern per the standard three.js WebGLRenderTarget approach;
// prop geometry, scanline/static overlay and scheduling are original.
// Procedural noise texture technique informed by bridge-mind/bridge-horror-house
// (MIT) grain tiles.
//
// Performance policy (Quest 3S):
//   * The RT (256x192) is re-rendered only every 4th update() call, and only
//     when visuals.lighting isn't disabled.
//   * options.enabled === false makes update() a cheap early-return.
//   * setFeed(-1) disables RT rendering entirely — the screen draws animated
//     static only — so integration can turn the feed off if perf suffers.
//   * While renderer.xr.isPresenting is true the RT render is SKIPPED unless
//     options.xrSafe === true. Re-rendering a render target inside an XR
//     animation frame is allowed by three.js but costly on mobile GPUs (extra
//     framebuffer switches mid stereo frame), so the default is to freeze the
//     last frame and let the animated static sell the effect. Opt in with
//     { xrSafe: true } only after profiling on device.
//   * The monitor group hides itself during its own RT pass: the screen
//     samples rt.texture, and sampling a target while rendering into it is a
//     WebGL feedback loop.

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

export function createMonitor(THREE, renderer, scene, options = {}) {
  const opts = {
    position: { x: -2.55, y: 1.4, z: -3.7 }, // on the cabinet
    rotation: null, // [x, y, z] Euler override; default aims at the player
    lookAt: { x: 0, y: 1.5, z: 2 },
    enabled: true,
    xrSafe: false,
    interval: 4, // RT re-render every Nth update() call
    rtWidth: 256,
    rtHeight: 192,
    staticSpike: 0.7, // tension above this => heavy static
    cameras: [
      // 0: high in the corridor, looking back through the doorway at the room
      //    (includes the ghost spawn at z ~ -7).
      { position: [0, 2.35, -8.6], lookAt: [0, 1.2, 1.5] },
      // 1: room corner cam.
      { position: [3.1, 2.4, 3.2], lookAt: [0, 1.0, -3.0] },
    ],
    seed: 0xc47,
    ...options,
  };

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

  if (Array.isArray(opts.rotation)) {
    group.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
  } else {
    group.lookAt(opts.lookAt.x, opts.lookAt.y, opts.lookAt.z);
  }
  scene.add(group);

  /* ---------------- state ---------------- */

  const st = {
    enabled: opts.enabled !== false,
    feed: -2, // force applyFeed(0) below to run
    frame: 0,
    time: 0,
    disposed: false,
  };

  function applyFeed(index) {
    const i = Number.isInteger(index) ? index : -1;
    const next = i >= 0 && i < opts.cameras.length ? i : -1;
    if (next === st.feed) return;
    st.feed = next;
    if (next < 0) {
      // Dead channel: no RT sampling, pure animated static.
      screenMat.map = null;
      screenMat.color.setHex(0x0a0f0c);
      staticMat.opacity = Math.max(staticMat.opacity, 0.55);
    } else {
      const cam = opts.cameras[next];
      rtCamera.position.set(cam.position[0], cam.position[1], cam.position[2]);
      rtCamera.lookAt(cam.lookAt[0], cam.lookAt[1], cam.lookAt[2]);
      rtCamera.updateMatrixWorld(true);
      screenMat.map = rt.texture;
      screenMat.color.setHex(0xa8c4b2);
    }
    screenMat.needsUpdate = true;
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
    staticMat.opacity = opacity;
    // Animated static: jitter the noise tile every update (cheap; no RT).
    noiseTex.offset.set(rand(), rand());

    // RT feed refresh — every Nth update, feed live, lighting not disabled,
    // and not mid-XR-presentation unless explicitly opted in (see header).
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
    dispose,
  };
}
