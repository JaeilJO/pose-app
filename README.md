# pose-app

AI auto-pose 3D reference tool for artists. Prototype v0.1.

Drag a few dots and the whole body follows into a natural pose. The tool generates no images, only poses.

## Run

```bash
npm install
npm run dev      # local dev server (also reachable from a phone on the same Wi-Fi)
npm test         # headless checks for the posing engine and the skirt cloth
npm run build    # one self-contained dist/index.html
```

## What's in v0.1

- Two realistic mannequin bodies (male, female): MakeHuman's CC0 base mesh, targets, skeleton and skin weights, fitted onto Blender Studio's CC0 realistic sculpts for anatomy, drawn once-subdivided with the sculpt's surface detail (`tools/build_human.py`, `tools/sculpt_fit.py`, `tools/subdiv.py`). Body panel: male/female, height, body fat, muscle, and shoulders/chest/arms/belly/hips/thighs/calves; the pose carries over.
- Chest and belly jiggle with gravity sag (`src/jiggle.js`).
- Self-collision: arms and legs stay out of the body and each other; a hand or foot dragged into the body stops at its surface (`src/collide.js`).
- Auto-pose: drag hands, feet, head or hips. If the target is out of reach, the spine bends and the hips move to help.
- Pins: feet start planted. A dragged hand or foot stays pinned (red). Tap a dot to pin or unpin it.
- Joint limits: elbows and knees are hinges, and the spine and neck stay inside human ranges. Hands are kept out of the torso.
- FK: drag any body part to rotate that joint. Drag the pelvis to turn or tilt the whole body.
- Touch-first toolbar: undo/redo, reset, camera views, lens (FOV with dolly), snapshot, timer for speed tests, FPS.
- Skirt physics test: position-based cloth with leg collisions, sub-stepped so fast kicks don't tunnel through.
- Languages: EN / ES / PT / KO.

## Code map

| File | What it does |
| --- | --- |
| `src/rig.js` | Skeleton (bones, rest pose, snapshot/restore) |
| `src/ik.js` | Two-bone IK, CCD pass, joint limits, FK aim |
| `src/poser.js` | Full-body solver: effectors, pins, body-follow, undo state |
| `src/human.js` | Loads the human body asset, binds it to the rig, sets the standing pose |
| `src/assets/human-*.js` | Generated body data (do not edit; rebuild with `tools/build_human.py`) |
| `src/proxies.js` | Invisible touch targets per bone |
| `src/body.js` | Contour line helper (and the older procedural body) |
| `src/mannequin.js` | Older wooden mannequin shapes (unused) |
| `src/cloth.js` | Skirt cloth simulation |
| `src/main.js` | Scene, input, UI |
| `src/i18n.js` | UI strings |
| `test/solver.test.mjs` | Headless engine checks |

## Assets and licenses

The body comes from [MakeHuman](https://github.com/makehumancommunity/makehuman): its base mesh, targets,
skeleton and weights were released as CC0 in 2020, so they can be used commercially without attribution.
Rebuild the asset after cloning MakeHuman:

Anatomy and surface detail come from Blender Studio's [Human Base Meshes](https://www.blender.org/download/demo-files/)
(CC0). Export the two realistic bodies at full multires level as `npz` (`co`: vertices, `tris`: triangles; Blender
coordinates) with Blender, then:

```bash
python3 tools/build_human.py <makehuman>/makehuman/data src/assets/human-male.js male male_hi.npz
python3 tools/build_human.py <makehuman>/makehuman/data src/assets/human-female.js female female_hi.npz
```

Needs numpy, scipy and trimesh (+ embreex for the AO bake).
