# Observation room visual upgrade

The active four-door room now uses an original abandoned institutional observation-room direction. Dirty off-white plaster, dull green ceramic dado tile, water tracks, fine paint aggregate, localized dark blood and human-scale hand streaks replace the former saturated striped walls, large painted portraits and giant blood lettering. The decorative rug is removed. Fixed architectural trim, ceiling service grid, door kick plates, an abandoned dual-monitor observation console with keyboard and a wall vent give the space a practical history.

Canvas albedo remains deterministic and entirely procedural. Two extra independent grayscale bump textures provide plaster and tile relief without turning lettering/blood into raised geometry. Height maps use linear color data. Main walls remain 2560×1024; floor 1024×1024; shared wall bump 1280×512 and floor bump 1024×1024. Assets are disposed with the room. There are no external photographs or franchise assets.

Emissive fill and additive lamp/beam opacity are reduced so the existing two real-time lights shape objects instead of washing everything flat. No shadow maps or additional dynamic lights are enabled. Darkness retains a small emissive floor for gameplay visibility.

The room API, 7 m footprint, floor plane, four opening positions, door pivots/animation and light/flicker semantics are unchanged. All console/architecture details merge by material. Headless geometry budget: 37 meshes, 6037 triangles, two lights (browser sprites add three draws). Actual Quest frame rate still requires device measurement.

Validation: all 15 existing simple-room unit tests pass, including openings/door animation, flicker, normals, resource disposal and budgets. Browser smoke suite could not launch in this checkout because Playwright is not installed. Runtime canvas appearance still requires browser review.

## Photographic redesign follow-up

Replaced the final visible surface identity with `public/materials/room-surface-atlas.png`, an original generated photographic atlas. `surface-materials.mjs` crops exact 627 px quadrants in browser to prevent atlas bleed, repeats the photographed plaster/steel at room scale, assembles wall contact-darkening bands, and applies mirrored checker tiles (~14 tiles across the 7 m floor). Linear microheight textures derive from the plaster and steel. Photographic loading is asynchronous; procedural surfaces remain a failure fallback. `group.userData.photographicSurfacesReady` becomes true on successful application. Late loads are ignored after disposal; resulting textures are tracked by the room.

The domestic bed, paneled wooden door faces, cone pendant, boarded arched window, orange floor glow, light shaft and repeated wet pool decals were removed. Added steel waiting bench, fluorescent service fixture, recessed rectangular observation glass, deep opening reveals, slab steel doors and a single merged non-additive contact-shadow layer under heavy furniture. The overall footprint, door API and collision/floor geometry remain fixed. Current budget: 35 meshes, 5590 triangles, two real-time lights. All 15 simple-room unit tests pass after the photographic redesign.
