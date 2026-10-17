# Free figure model shortlist

Licenses below were read from each model's own page by the researching agent (page text, not memory). Triangle counts are only given where measured or stated on the page. Nothing here is picked for you. Quaternius's site reportedly now publishes a newer "Quaternius Asset Licence"; older pack pages still say CC0, so re-check the page at download time.

| # | Name | Author | Link | License (as shown) | Tris | Rigged | Scare / usability | Concerns |
|---|------|--------|------|--------------------|------|--------|-------------------|----------|
| 1 | Graveyard Kit (zombie, ghost, skeleton, vampire, keeper) | Kenney | https://www.kenney.nl/assets/graveyard-kit | CC0 (page + bundled License.txt) | measured: zombie 1078, ghost 413, skeleton 658, vampire 1100, keeper 1141 | No skin; node animations (idle, walk, attack-melee) | Cute, blocky; fine as a distant silhouette, not scary close up | Stylized look clashes with a realistic room. 512px shared colormap. |
| 2 | Mobile Ready Zombie | Lucian Pavel | https://opengameart.org/content/mobile-ready-zombie | CC0 | 1,938 (page) | No | Low-poly zombie, would need conversion (format not stated) | Download is Zombie.zip, format unknown; 512px diffuse |
| 3 | Undead Squirrel (animated) | CDmir (+TinyWorlds) | https://opengameart.org/content/undead-squirrel-animated | CC0 | not stated | Yes | Odd and unsettling but a squirrel | .blend likely, needs conversion |
| 4 | Alien Bug Animated | CDmir | https://opengameart.org/content/alien-bug-animated | CC0 | not stated | Probably (idle, run, attack anims) | Creature, has glTF tag; not humanoid | Not downloaded or inspected |
| 5 | 3D Horror Game Monster | City Building Game Art | https://opengameart.org/content/3d-horror-game-monster | CC0 | not stated | Animated (run, walk, attack) | Described as terrifying; best scare potential on the list | 146 MB + 87 MB zips, FBX; texture sizes unknown; would need conversion and an optimization pass |
| 6 | Hazmat Zombie | sandsound (from tigertowel's Lowpoly Zombie) | https://opengameart.org/content/hazmat-zombie | CC0 | not stated | not stated | Low-poly zombie in hazmat suit | .blend only; derived work, check upstream |
| 7 | LowPoly Animated Monsters | quaternius | https://opengameart.org/content/lowpoly-animated-monsters | CC0 | not stated | Animated | Fantasy monsters (slime, skeleton, bat), cartoony | FBX/OBJ/Blend only, no glb |
| 8 | Ultimate Monsters Pack | quaternius | https://sketchfab.com/3d-models/ultimate-monsters-pack-fd72e114d119488da71fe3a16f216c4f | Sketchfab field reads "CC Attribution" (description text claims free/CC0: conflicting) | 212.2k for the whole pack | Animated | 50 monsters; cartoony | License conflict: treat as CC-BY with attribution unless confirmed. Pack far over the 60k cap; individual monsters would need splitting. |
| 9 | Animated Human Low Poly | quaternius | https://opengameart.org/content/animated-human-low-poly | CC0 | not stated | Yes | Plain human, usable as a base for a mannequin/doll figure | Not scary as is |

Not recommended: itch.io "PSX Zombie Creatures Pack" (paid, license unconfirmed), "Horror Character Pack" (license unclear), "Max Damage zombie" (credit required, license terms unverified here), CGTrader and RenderHub items (paid).

## Vetted and added to public/models/

Both come from Kenney's Graveyard Kit v5.0 (CC0; License.txt copied to `public/models/KENNEY-LICENSE.txt`). The GLBs were checked as data: valid glTF 2.0 header, length matches, no external buffers, one external image `Textures/colormap.png` (512x512 PNG, 10 KB), no scripts.

- `kenney-zombie.glb` (1078 tris)
- `kenney-ghost.glb` (413 tris)

Loaded in headless Chromium through the real GLTFLoader and normalized to 1.9 m, feet at y=0. Both are cartoony placeholders and are not scary. Neither is recommended as the main scare.

Doll/mannequin family: nothing suitable was found with a verifiable license. Candidate 9 is the closest base figure. The doll look comes from the procedural face instead (`public/simple/face-texture.mjs`).
