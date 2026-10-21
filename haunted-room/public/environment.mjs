// environment.mjs — Victorian/industrial observation chamber for The Quiet Room.
// Replaces the inline room geometry in app.mjs. Architecture is fixed (x ±3.5,
// z -5.5..3.5, doorway in the back wall); nothing ever moves under the player.
// The doorway opens onto a corridor whose pre-built segments are revealed as
// tension rises. No geometry or materials are allocated per frame.
//
// API:
//   createEnvironment(THREE, scene, { materials } = {})
//     => { update(dt, time, visuals), interactables, dispose(), debug }
//
// visuals: { tension 0..1, state BUILD|PEAK|RELIEF|WAIT, elapsed, lighting,
//            fog, shadow (booleans), shadowPosition "back"|"left"|"right",
//            quality 0..1, phase (free-running number) }
//
// options.materials (optional, e.g. from textures.mjs createMaterialLibrary):
//   { wallPlaster, wainscot, woodDark, floorPlanks, ceiling, metalAged,
//     fabricWorn, corridorWall } — any provided key is used for that surface
//   role; missing keys fall back to plain MeshStandardMaterials built here.
//   Injected materials are never disposed by dispose(); clones made from them
//   (corridor fade segments) are owned and disposed.
//
// interactables: [{ id, label, mesh, onInteract() }] — mesh is the raycast
//   target (every node in it carries userData.interactableId).
//
// debug (diagnostic/test hook): { root, figure, corridorExtent,
//   corridorVisibleCount } — corridorVisibleCount is how many corridor
//   segments are currently revealed (1..6, driven by smoothed tension).

const SEGMENTS = 6;
const SEG_LEN = 2;
const MIN_EXTENT = 1.5; // calm corridor still reads as a short shadowy hall
const DOOR_REST = 0.5;
const DOOR_MAX = 1.45;

const MATERIAL_DEFAULTS = {
  wallPlaster: { color: 0x3d433c, roughness: 1 },
  wainscot: { color: 0x34281d, roughness: 0.85 },
  woodDark: { color: 0x251a12, roughness: 0.9 },
  floorPlanks: { color: 0x463d2f, roughness: 0.95 },
  ceiling: { color: 0x20251f, roughness: 1 },
  metalAged: { color: 0x565a4b, roughness: 0.7, metalness: 0.3 },
  fabricWorn: { color: 0x3b2d27, roughness: 1 },
  corridorWall: { color: 0x1a1e1b, roughness: 1 },
  wallDamaged: { color: 0x37392f, roughness: 1 },
  scratchedPlaster: { color: 0x3a403a, roughness: 1 },
  paperDrawing: { color: 0xcfc8b4, roughness: 1 },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const ease = (dt, k) => 1 - Math.exp(-k * dt);

export function createEnvironment(THREE, scene, options = {}) {
  const injected = options.materials ?? {};
  const ownedMaterials = [],
    ownedGeometries = [];
  const own = (m) => (ownedMaterials.push(m), m);
  const geo = (g) => (ownedGeometries.push(g), g);
  const mats = {};
  for (const [role, def] of Object.entries(MATERIAL_DEFAULTS))
    mats[role] = injected[role] ?? own(new THREE.MeshStandardMaterial(def));
  const basic = (params) => own(new THREE.MeshBasicMaterial(params));
  const unit = geo(new THREE.BoxGeometry(1, 1, 1)); // shared by every box mesh
  const root = new THREE.Group();
  root.name = "environment";

  function box(parent, material, x, y, z, w, h, d, ry = 0) {
    const m = new THREE.Mesh(unit, material);
    m.position.set(x, y, z);
    m.scale.set(w, h, d);
    if (ry) m.rotation.y = ry;
    parent.add(m);
    return m;
  }

  // --- Floor, rug ---------------------------------------------------------
  box(root, mats.floorPlanks, 0, -0.08, -1, 7, 0.16, 9);
  for (let i = 0; i < 8; i++)
    box(root, mats.woodDark, -3.06 + i * 0.875, 0.004, -1, 0.014, 0.012, 8.8);
  box(root, mats.fabricWorn, 0.7, 0.012, -2.1, 2.4, 0.024, 1.8, 0.08);

  // --- Walls: plaster above, wainscot panels below, trim ------------------
  for (const sx of [-1, 1]) {
    box(root, mats.wallPlaster, sx * 3.5, 1.8, -1, 0.15, 3.6, 9);
    box(root, mats.wainscot, sx * 3.41, 0.56, -1, 0.06, 1.08, 8.9);
    box(root, mats.woodDark, sx * 3.38, 0.09, -1, 0.1, 0.18, 9); // baseboard
    box(root, mats.woodDark, sx * 3.38, 1.13, -1, 0.1, 0.07, 9); // chair rail
    box(root, mats.woodDark, sx * 3.39, 3.5, -1, 0.09, 0.14, 9); // crown
  }
  // Front wall (+Z, behind the player).
  box(root, mats.wallPlaster, 0, 1.8, 3.5, 7, 3.6, 0.15);
  box(root, mats.wainscot, 0, 0.56, 3.41, 6.9, 1.08, 0.06);
  box(root, mats.woodDark, 0, 0.09, 3.38, 6.9, 0.18, 0.1);
  box(root, mats.woodDark, 0, 3.5, 3.39, 6.9, 0.14, 0.09);
  // Back wall (-Z) with the doorway opening (2 m wide, 2.9 m tall).
  for (const sx of [-1, 1]) {
    box(root, mats.wallPlaster, sx * 2.25, 1.8, -5.5, 2.5, 3.6, 0.15);
    box(root, mats.wainscot, sx * 2.25, 0.56, -5.41, 2.4, 1.08, 0.06);
  }
  box(root, mats.wallPlaster, 0, 3.25, -5.5, 2, 0.7, 0.15);
  for (const sx of [-1, 1])
    box(root, mats.woodDark, sx * 1.08, 1.45, -5.38, 0.14, 2.9, 0.2);
  box(root, mats.woodDark, 0, 2.91, -5.38, 2.3, 0.14, 0.2);

  // --- Ceiling and beams --------------------------------------------------
  box(root, mats.ceiling, 0, 3.6, -1, 7, 0.15, 9);
  for (const z of [-4.5, -3, -1.5, 0, 1.5, 3])
    box(root, mats.woodDark, 0, 3.44, z, 7, 0.18, 0.22);
  // Lamp fixture shade + cord (the host app owns the lamp light itself).
  const shade = new THREE.Mesh(
    geo(new THREE.ConeGeometry(0.36, 0.22, 14, 1, true)),
    mats.metalAged,
  );
  shade.position.set(0, 2.92, -1);
  root.add(shade);
  box(root, mats.metalAged, 0, 3.26, -1, 0.02, 0.5, 0.02);

  // --- Window on the +X wall ----------------------------------------------
  box(root, basic({ color: 0x0d161b }), 3.39, 2, -2, 0.03, 1.7, 1.3);
  for (const z of [-2.66, -2, -1.34])
    box(root, mats.woodDark, 3.35, 2, z, 0.08, 1.8, 0.055);
  box(root, mats.woodDark, 3.35, 2, -2, 0.08, 0.06, 1.3);

  // --- Window light shafts (additive, fade with tension) ------------------
  const shaftMat = basic({
    color: 0x9fc4cc,
    transparent: true,
    opacity: 0.06,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const shaftGeo = geo(new THREE.PlaneGeometry(1.3, 2.6));
  for (const [x, y, z, s] of [
    [2.55, 1.35, -2.1, 1],
    [2.15, 1.1, -1.75, 0.7],
  ]) {
    const p = new THREE.Mesh(shaftGeo, shaftMat);
    p.position.set(x, y, z);
    p.rotation.set(0.42, -1.2, 0.35);
    p.scale.setScalar(s);
    root.add(p);
  }

  // --- Picture frames with dark portraits ---------------------------------
  const portraitMat = basic({ color: 0x04070a });
  const frameA = box(root, mats.woodDark, -3.41, 2.05, 0.4, 0.06, 0.92, 0.7);
  box(root, portraitMat, -3.37, 2.05, 0.4, 0.02, 0.74, 0.54);
  const frameB = box(root, mats.woodDark, 1.5, 2.15, 3.41, 0.8, 1.0, 0.06);
  box(root, portraitMat, 1.5, 2.15, 3.37, 0.62, 0.82, 0.02);

  // --- Cabinet, books ------------------------------------------------------
  box(root, mats.woodDark, -2.55, 0.65, -3.7, 1.2, 1.3, 0.6);
  box(root, mats.metalAged, -2.55, 1.34, -3.7, 1.3, 0.08, 0.7);
  for (const x of [-2.85, -2.25])
    box(root, mats.wainscot, x, 0.7, -3.385, 0.5, 1, 0.035);
  const bookMats = [
    own(new THREE.MeshStandardMaterial({ color: 0x4a2b24, roughness: 0.9 })),
    own(new THREE.MeshStandardMaterial({ color: 0x2d3a2e, roughness: 0.9 })),
  ];
  for (const [i, x] of [-3.02, -2.9, -2.78].entries())
    box(root, bookMats[i % 2], x, 1.5, -3.75, 0.08, 0.24, 0.17, i * 0.12);

  // --- Interactable: wireless radio on the cabinet -------------------------
  const radioGroup = new THREE.Group();
  radioGroup.position.set(-2.32, 1.53, -3.62);
  radioGroup.rotation.y = 0.35;
  radioGroup.userData.active = false;
  box(radioGroup, mats.woodDark, 0, 0, 0, 0.5, 0.3, 0.24);
  const dialMat = own(
    new THREE.MeshStandardMaterial({
      color: 0x241607,
      emissive: 0xff9c3f,
      emissiveIntensity: 0,
      roughness: 0.6,
    }),
  );
  box(radioGroup, dialMat, 0.02, 0.03, 0.125, 0.28, 0.1, 0.01);
  for (const x of [-0.16, 0.16])
    box(radioGroup, mats.metalAged, x, -0.08, 0.125, 0.05, 0.05, 0.02);
  const dialLight = new THREE.PointLight(0xff9c3f, 0, 1.8, 2);
  dialLight.position.set(0.02, 0.05, 0.2);
  radioGroup.add(dialLight);
  root.add(radioGroup);

  // --- Chair ---------------------------------------------------------------
  const chair = new THREE.Group();
  chair.position.set(1.8, 0, -3.7);
  chair.rotation.y = -0.3;
  box(chair, mats.fabricWorn, 0, 0.5, 0, 0.62, 0.09, 0.62);
  for (const x of [-0.24, 0.24])
    for (const z of [-0.24, 0.24])
      box(chair, mats.woodDark, x, 0.23, z, 0.065, 0.46, 0.065);
  box(chair, mats.woodDark, 0, 1, -0.27, 0.62, 0.85, 0.08);
  root.add(chair);

  // --- Interactable: antique wall clock on the +Z wall ---------------------
  const clockGroup = new THREE.Group();
  clockGroup.position.set(-1.6, 2.2, 3.4);
  clockGroup.rotation.y = Math.PI; // face into the room (toward -Z)
  box(clockGroup, mats.woodDark, 0, 0, 0, 0.36, 1.0, 0.14);
  const faceGeo = geo(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 20));
  const face = new THREE.Mesh(faceGeo, mats.metalAged);
  face.rotation.x = Math.PI / 2;
  face.position.set(0, 0.3, 0.075);
  clockGroup.add(face);
  const handMat = basic({ color: 0x090b09 });
  const minuteHand = new THREE.Group(),
    hourHand = new THREE.Group();
  for (const [pivot, len] of [
    [minuteHand, 0.105],
    [hourHand, 0.07],
  ]) {
    pivot.position.set(0, 0.3, 0.09);
    box(pivot, handMat, 0, len / 2, 0, 0.012, len, 0.008);
    clockGroup.add(pivot);
  }
  const pendulumPivot = new THREE.Group();
  pendulumPivot.position.set(0, 0.1, 0.05);
  box(pendulumPivot, mats.metalAged, 0, -0.26, 0, 0.018, 0.5, 0.01);
  box(pendulumPivot, mats.metalAged, 0, -0.52, 0, 0.09, 0.09, 0.02);
  clockGroup.add(pendulumPivot);
  root.add(clockGroup);

  // --- Interactable: door leaning open against the corridor frame ----------
  const doorGroup = new THREE.Group();
  doorGroup.position.set(-1.0, 0, -5.42); // hinge on the left doorpost
  box(doorGroup, mats.woodDark, 0.48, 1.42, 0, 0.96, 2.84, 0.06);
  box(doorGroup, mats.metalAged, 0.86, 1.4, 0.05, 0.05, 0.05, 0.05);
  doorGroup.rotation.y = DOOR_REST;
  root.add(doorGroup);

  // --- Corridor: six pre-built segments revealed by tension ----------------
  const corridor = new THREE.Group();
  const segments = [];
  const corridorBase = mats.corridorWall;
  for (let i = 0; i < SEGMENTS; i++) {
    const segMat = own(corridorBase.clone());
    segMat.transparent = true;
    segMat.opacity = 0;
    const seg = new THREE.Group();
    const zc = -5.5 - i * SEG_LEN - SEG_LEN / 2;
    box(seg, segMat, -1.05, 1.45, zc, 0.1, 2.9, SEG_LEN);
    box(seg, segMat, 1.05, 1.45, zc, 0.1, 2.9, SEG_LEN);
    box(seg, segMat, 0, 2.92, zc, 2.2, 0.1, SEG_LEN);
    box(seg, segMat, 0, -0.05, zc, 2.2, 0.1, SEG_LEN);
    if (i === 4) {
      // A faint second doorframe deep in the dark; fades with its segment.
      for (const sx of [-1, 1])
        box(seg, segMat, sx * 0.8, 1.3, zc - 0.6, 0.12, 2.6, 0.12);
      box(seg, segMat, 0, 2.62, zc - 0.6, 1.72, 0.12, 0.12);
    }
    seg.visible = false;
    corridor.add(seg);
    segments.push({ group: seg, mat: segMat });
  }
  // Black end cap slides back as the corridor extends.
  const capMat = basic({ color: 0x000000 });
  const endCap = box(corridor, capMat, 0, 1.45, -8.5, 2.3, 3, 0.1);
  // Single hanging bulb mid-corridor (segment 2); one of our two lights.
  const bulbPivot = new THREE.Group();
  bulbPivot.position.set(0.1, 2.9, -10.4);
  box(bulbPivot, mats.metalAged, 0, -0.3, 0, 0.015, 0.6, 0.015);
  const bulbMat = basic({ color: 0xffe2b0, transparent: true, opacity: 0 });
  const bulb = new THREE.Mesh(geo(new THREE.SphereGeometry(0.05, 10, 8)), bulbMat);
  bulb.position.y = -0.63;
  bulbPivot.add(bulb);
  const bulbLight = new THREE.PointLight(0xffd9a0, 0, 5.5, 2);
  bulbLight.position.y = -0.63;
  bulbPivot.add(bulbLight);
  bulbPivot.visible = false;
  corridor.add(bulbPivot);
  root.add(corridor);

  // --- Decay details: peeling paint, claw drags, cobwebs, fallen book ------
  const detailPlane = geo(new THREE.PlaneGeometry(1, 1));
  function wallDecal(material, x, y, z, w, h, ry, rz = 0) {
    const m = new THREE.Mesh(detailPlane, material);
    m.position.set(x, y, z);
    m.rotation.set(0, ry, rz);
    m.scale.set(w, h, 1);
    root.add(m);
    return m;
  }
  // Peeling-paint patch on the left wall (just proud of the plaster).
  wallDecal(mats.wallDamaged, -3.418, 1.9, 1.2, 2.2, 2.1, Math.PI / 2);
  // Long claw drags on the right wall beside the corridor mouth.
  wallDecal(mats.scratchedPlaster, 3.418, 1.5, -4.2, 1.5, 2.3, -Math.PI / 2);
  // Cobwebs: three cheap translucent planes sagging across upper corners.
  const cobwebMat = basic({
    color: 0xb9beb2,
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const cobwebs = [];
  for (const [x, y, z, ry] of [
    [-3.1, 3.25, -5.1, Math.PI / 4],
    [3.1, 3.3, 3.1, -Math.PI / 4],
  ]) {
    const web = new THREE.Mesh(detailPlane, cobwebMat);
    web.position.set(x, y, z);
    web.rotation.set(0.5, ry, 0.3);
    web.scale.set(0.7, 0.55, 1);
    root.add(web);
    cobwebs.push(web);
  }
  // --- Interactable: child's drawing taped to the front wall ---------------
  const drawingGroup = new THREE.Group();
  drawingGroup.position.set(0.55, 1.45, 3.415);
  drawingGroup.rotation.y = Math.PI; // faces into the room
  drawingGroup.rotation.z = 0.05; // taped slightly crooked
  const paper = new THREE.Mesh(detailPlane, mats.paperDrawing);
  paper.scale.set(0.28, 0.36, 1);
  drawingGroup.add(paper);
  root.add(drawingGroup);

  // --- Interactable: dangling wire with a sparking tip ----------------------
  const wirePivot = new THREE.Group();
  wirePivot.position.set(0.95, 3.52, -5.05); // hangs by the corridor mouth
  const wireMat = own(
    new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 0.6 }),
  );
  box(wirePivot, wireMat, 0.02, -0.62, 0, 0.018, 1.24, 0.018, 0.06);
  const sparkMat = basic({
    color: 0xffe9b8,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const spark = new THREE.Mesh(geo(new THREE.SphereGeometry(0.03, 8, 6)), sparkMat);
  spark.position.set(0.06, -1.26, 0);
  wirePivot.add(spark);
  root.add(wirePivot);

  // --- Shadow entity: soft-edged silhouette, drifts, never teleports -------
  const figure = new THREE.Group();
  const innerMat = basic({ color: 0x020404, transparent: true, opacity: 0 });
  const outerMat = basic({
    color: 0x020404,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const bodyGeo = geo(new THREE.ConeGeometry(0.28, 1.4, 12));
  const headGeo = geo(new THREE.SphereGeometry(0.14, 14, 10));
  for (const [mat, s] of [
    [innerMat, 1],
    [outerMat, 1.28],
  ]) {
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.y = 0.8;
    body.scale.setScalar(s);
    figure.add(body);
    const head = new THREE.Mesh(headGeo, mat);
    head.position.y = 1.61;
    head.scale.setScalar(s);
    figure.add(head);
  }
  figure.position.set(0, 0, -6.5);
  figure.visible = false;
  root.add(figure);

  // --- Dust motes: one Points cloud, positions mutated in place ------------
  const DUST = 400;
  const dustPos = new Float32Array(DUST * 3);
  const dustVel = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = -3.2 + Math.random() * 6.4;
    dustPos[i * 3 + 1] = 0.15 + Math.random() * 3.1;
    dustPos[i * 3 + 2] = -5.2 + Math.random() * 8.4;
    dustVel[i * 3] = (Math.random() - 0.5) * 0.03;
    dustVel[i * 3 + 1] = -0.008 - Math.random() * 0.02;
    dustVel[i * 3 + 2] = (Math.random() - 0.5) * 0.03;
  }
  const dustGeo = geo(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = own(
    new THREE.PointsMaterial({
      color: 0xcfd8c2,
      size: 0.02,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  root.add(new THREE.Points(dustGeo, dustMat));

  scene.add(root);

  // --- Interactables --------------------------------------------------------
  function tag(group, id) {
    group.traverse((o) => (o.userData.interactableId = id));
    return group;
  }
  let wrongTimer = 0,
    doorTarget = DOOR_REST,
    flutterTimer = 0,
    sparkBurst = 0;
  const interactables = [
    {
      id: "clock",
      label: "Antique wall clock",
      mesh: tag(clockGroup, "clock"),
      onInteract() {
        wrongTimer += 8; // hands spin backwards, fast, for a while
      },
    },
    {
      id: "radio",
      label: "Wireless radio",
      mesh: tag(radioGroup, "radio"),
      onInteract() {
        radioGroup.userData.active = !radioGroup.userData.active;
      },
    },
    {
      id: "corridor-door",
      label: "Leaning door",
      mesh: tag(doorGroup, "corridor-door"),
      onInteract() {
        doorTarget = Math.min(DOOR_MAX, doorTarget + 0.3);
      },
    },
    {
      id: "drawing",
      label: "Child's drawing",
      mesh: tag(drawingGroup, "drawing"),
      onInteract() {
        flutterTimer = 4; // the paper stirs as if breathed on
      },
    },
    {
      id: "wire",
      label: "Dangling wire",
      mesh: tag(wirePivot, "wire"),
      onInteract() {
        sparkBurst = 1.6; // provoked: a violent little arc shower
      },
    },
  ];

  /** Creak the leaning door open by `delta` radians (clamped to its arc). */
  function creakDoor(delta = 0.12) {
    const d = Number.isFinite(delta) ? delta : 0;
    doorTarget = clamp(doorTarget + d, 0, DOOR_MAX);
    return doorTarget;
  }

  // --- Per-frame state (no allocations inside update) ----------------------
  let smoothed = 0,
    extent = MIN_EXTENT,
    innerTime = 0,
    shadowOpacity = 0,
    doorAngle = DOOR_REST,
    clockMinute = 0,
    clockHour = 0,
    pendulumAmp = 1,
    dialGlow = 0;
  const figureTarget = new THREE.Vector3();

  function update(dt, time, visuals = {}) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    innerTime += dt;
    const tension = Number.isFinite(visuals.tension)
      ? clamp(visuals.tension, 0, 1)
      : 0;
    const state = visuals.state ?? "WAIT";
    const quality = Number.isFinite(visuals.quality) ? visuals.quality : 1;
    // WAIT eases everything back toward calm regardless of the raw input.
    const target = state === "WAIT" ? 0 : tension;
    smoothed += (target - smoothed) * ease(dt, 1.6);

    // Corridor extension: smoothed tension reveals pre-built segments.
    extent = MIN_EXTENT + smoothed * (SEGMENTS - MIN_EXTENT);
    for (let i = 0; i < SEGMENTS; i++) {
      const op = clamp(extent - i, 0, 1);
      const s = segments[i];
      s.group.visible = op > 0.01;
      s.mat.opacity = op * (1 - i * 0.09); // recedes into darkness
    }
    endCap.position.z = -5.5 - Math.min(extent, SEGMENTS) * SEG_LEN + 0.04;

    // Hanging bulb: tied to its segment's reveal, sways subtly, flickers more
    // as tension rises or signal quality drops.
    const bulbOp = clamp(extent - 2, 0, 1);
    bulbPivot.visible = bulbOp > 0.01;
    if (bulbPivot.visible) {
      bulbPivot.rotation.x = Math.sin(innerTime * 0.7) * 0.06;
      bulbPivot.rotation.z = Math.sin(innerTime * 0.53 + 1.7) * 0.08;
      const unrest = clamp(smoothed + (1 - quality) * 0.5, 0, 1);
      const flicker =
        1 - unrest * 0.3 * (0.5 + 0.5 * Math.sin(innerTime * 7.3) * Math.sin(innerTime * 3.1));
      bulbMat.opacity = bulbOp * 0.9;
      bulbLight.intensity = bulbOp * (0.25 + smoothed * 0.5) * flicker;
    } else {
      bulbLight.intensity = 0;
      bulbMat.opacity = 0;
    }

    // Window shafts follow the lighting toggle and inverse tension.
    const lighting = visuals.lighting !== false;
    shaftMat.opacity =
      (lighting ? 0.07 : 0.015) *
      (1 - smoothed * 0.85) *
      (0.85 + 0.15 * Math.sin(innerTime * 0.4));

    // Dust drift.
    for (let i = 0; i < DUST * 3; i += 3) {
      dustPos[i] += dustVel[i] * dt;
      dustPos[i + 1] += dustVel[i + 1] * dt;
      dustPos[i + 2] += dustVel[i + 2] * dt;
      if (dustPos[i + 1] < 0.1) dustPos[i + 1] = 3.3;
      if (dustPos[i] < -3.3) dustPos[i] = 3.3;
      else if (dustPos[i] > 3.3) dustPos[i] = -3.3;
      if (dustPos[i + 2] < -5.3) dustPos[i + 2] = 3.2;
      else if (dustPos[i + 2] > 3.2) dustPos[i + 2] = -5.3;
    }
    dustGeo.attributes.position.needsUpdate = true;
    dustMat.opacity = (visuals.fog === false ? 0.14 : 0.22) + smoothed * 0.1;

    // Shadow entity: gradual fade, drift between anchors, never teleports
    // while visible.
    const shadowOn =
      visuals.shadow !== false && state !== "WAIT" && tension > 0.45;
    const opacityTarget = shadowOn ? clamp((tension - 0.4) * 2, 0, 0.85) : 0;
    shadowOpacity += (opacityTarget - shadowOpacity) * ease(dt, 2.2);
    innerMat.opacity = shadowOpacity;
    outerMat.opacity = shadowOpacity * 0.35;
    const loc = visuals.shadowPosition;
    figureTarget.set(
      loc === "left" ? -2.7 : loc === "right" ? 2.7 : 0,
      0,
      loc === "back" ? -6.5 : -4.7, // "back" stands deep inside the corridor
    );
    if (figure.visible) figure.position.lerp(figureTarget, ease(dt, 1.6));
    else figure.position.copy(figureTarget);
    figure.visible = shadowOpacity > 0.01;
    figure.rotation.y = Math.sin(innerTime * 0.31) * 0.06;

    // Door: slow swing toward its target; drifts open on its own at PEAK,
    // settles back toward rest during WAIT.
    if (state === "PEAK") doorTarget = Math.min(DOOR_MAX, doorTarget + dt * 0.06);
    else if (state === "WAIT")
      doorTarget += (DOOR_REST - doorTarget) * ease(dt, 0.4);
    doorAngle += (doorTarget - doorAngle) * ease(dt, 0.9);
    doorGroup.rotation.y = doorAngle;

    // Clock: slow correct time normally; backwards and fast after interaction;
    // pendulum freezes when tension exceeds 0.6.
    if (wrongTimer > 0) {
      wrongTimer -= dt;
      clockMinute -= dt * 4.5;
      clockHour -= dt * 2.8;
    } else {
      clockMinute += dt * 0.105;
      clockHour += dt * 0.0087;
    }
    minuteHand.rotation.z = -clockMinute;
    hourHand.rotation.z = -clockHour;
    pendulumAmp += ((tension > 0.6 ? 0 : 1) - pendulumAmp) * ease(dt, 1.5);
    pendulumPivot.rotation.z = Math.sin(innerTime * 2.4) * 0.22 * pendulumAmp;

    // Radio dial glow follows its toggled state.
    dialGlow += ((radioGroup.userData.active ? 1 : 0) - dialGlow) * ease(dt, 4);
    dialMat.emissiveIntensity = dialGlow * 1.4;
    dialLight.intensity = dialGlow * 0.5;

    // Prop micro-motion: frames settle almost imperceptibly.
    frameA.rotation.x = 0.012 * Math.sin(innerTime * 0.23);
    frameB.rotation.z = 0.01 * Math.sin(innerTime * 0.19 + 2.1);

    // Cobwebs breathe with the room's air.
    for (let i = 0; i < cobwebs.length; i++)
      cobwebs[i].rotation.z = 0.3 + 0.04 * Math.sin(innerTime * 0.6 + i * 2.1);

    // Child's drawing: pinned crooked; stirs when interacted with, and
    // trembles faintly on its own at high tension.
    if (flutterTimer > 0) flutterTimer -= dt;
    const stir = (flutterTimer > 0 ? 1 : 0) + smoothed * 0.25;
    drawingGroup.rotation.z =
      0.05 + stir * 0.1 * Math.sin(innerTime * 9.1) * Math.sin(innerTime * 5.3);

    // Dangling wire sways; its tip arcs sporadically (deterministic pattern),
    // harder under tension, and showers when provoked via the interactable.
    wirePivot.rotation.x = Math.sin(innerTime * 0.9) * 0.05;
    wirePivot.rotation.z = Math.sin(innerTime * 0.67 + 0.8) * (0.07 + stir * 0.05);
    if (sparkBurst > 0) sparkBurst -= dt;
    const arcGate =
      Math.sin(innerTime * 1.3) * Math.sin(innerTime * 2.9 + 1.2) >
      0.93 - smoothed * 0.25;
    const arcing = sparkBurst > 0 || arcGate;
    sparkMat.opacity = arcing
      ? 0.45 + 0.55 * Math.abs(Math.sin(innerTime * 41))
      : 0;
    spark.scale.setScalar(arcing ? 0.8 + 0.6 * Math.abs(Math.sin(innerTime * 29)) : 0.6);
  }

  function dispose() {
    scene.remove(root);
    for (const g of ownedGeometries) g.dispose();
    for (const m of ownedMaterials) m.dispose();
    ownedGeometries.length = 0;
    ownedMaterials.length = 0;
  }

  const debug = {
    root,
    figure,
    spark,
    drawing: drawingGroup,
    get doorTarget() {
      return doorTarget;
    },
    get corridorExtent() {
      return extent;
    },
    get corridorVisibleCount() {
      let n = 0;
      for (const s of segments) if (s.group.visible) n++;
      return n;
    },
  };

  return { update, interactables, creakDoor, dispose, debug };
}
