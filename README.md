# PRISMAMD

Open-source, mobile-first 3D MMD animation application.

Viewport and object workflow modeled on **Prisma3D**; visual language
modeled on random professional shit because i fucking hate neon.
Targets Android/iOS through a cross-platform WebView shell
(Capacitor/Tauri-mobile class tooling), rendering with WebGL2 and an
optional WebGPU/WGSL path.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full module map and
per-frame execution loop.

## Status

Early architecture scaffold — core subsystems are implemented as
standalone ES6 modules with working math/parsing logic; some format
tables (PMX materials/morphs, full FBX/.x token grammars) are stubbed
with clear extension points. Not yet wired into a renderer or app shell.

## Modules

| Path | Covers |
|---|---|
| `src/platform/CapacitorFSBridge.js` | Android/iOS filesystem bridge backing `window.NativeFS`, via `@capacitor/filesystem` |
| `src/main.js` | App bootstrap: installs the FS bridge, starts core systems and the render loop |
| `src/core/FileSystemManager.js` | Storage permission request, `/PRISMAMD` folder bootstrap, live asset-folder watching |
| `src/core/SceneManager.js` | Multi-model scene graph, per-model skeleton + skinning |
| `src/core/Timeline.js` | Fractional-frame clock, 12/15/30/60 FPS profiles, diamond keyframe tracks |
| `src/core/BezierEasing.js` | Cubic-bezier interpolation graph (Ease-In/Out/Linear/Step + custom handles) |
| `src/core/MathUtils.js` | Shared quaternion/matrix kernel (slerp, TRS composition) |
| `src/io/ImportExport.js` | `.pmd` / `.pmx` / `.vmd` / `.vpd` / `.fbx` / `.x` / `.fx` import pipeline |
| `src/io/PMDPFormat.js` | Native `.pmdp` zip-packaged project format |
| `src/render/ShaderCore.js` | Toon + SPH (.sph/.spa) GLSL/WGSL fragment shaders |
| `src/render/StretchRig.js` | Non-uniform squash & stretch bone rigging |
| `src/render/FXAdaptor.js` | Legacy Direct3D `.fx` Effects-framework → mobile GLSL/WGSL converter |
| `src/perf/PerformanceController.js` | IK / Motion Blur / Hide FX toggles, 720p/1080p export cap |

## Mobile shell (Android & iOS)

PRISMAMD ships as a Capacitor WebView app — `capacitor.config.json` points
at `www/` as the web root, and `src/platform/CapacitorFSBridge.js` wires
`core/FileSystemManager.js`'s `window.NativeFS` contract to
`@capacitor/filesystem`, sandboxed under the app's Documents directory
(so no broad external-storage permission is requested).

```bash
npm install
npm run add:android    # one-time: creates the native android/ project
npm run android          # vite build -> www/, cap sync, open Android Studio
# — or, for a debug APK with no Android Studio GUI:
npm run android:apk      # same, then `./gradlew assembleDebug`
#   -> android/app/build/outputs/apk/debug/app-debug.apk

npm run add:ios        # one-time: creates the native ios/ project (macOS only)
npm run ios              # vite build -> www/, cap sync, open Xcode
```

`npm run build:web` runs Vite against the root `index.html` + `src/main.js`
entry and outputs the bundle to `www/` (the directory `capacitor.config.json`
points at). `npm run dev` runs a local Vite dev server for iterating in a
desktop browser before syncing to a device.

CI builds the debug APK automatically via `.github/workflows/build.yml`
on every push to `main` (see its `build-android` job for the exact steps,
and the Actions run's artifacts for the APK itself).

## Requirements

Several modules are written against injected native/WASM bindings
rather than bundling heavy toolchains directly:

- A zip codec (e.g. [`fflate`](https://github.com/101arrowz/fflate)) for `.pmdp`
- An FBX decoding backend (e.g. an `ufbx`/`fbx2gltf` WASM binding)
- An HLSL→SPIR-V→WGSL/GLSL toolchain (e.g. DXC or glslang + naga + SPIRV-Cross, as WASM) for `.fx` conversion

The filesystem bridge itself (`window.NativeFS`) is already implemented
for Capacitor in `src/platform/CapacitorFSBridge.js` — swap it out only
if you move to a different native shell.

## License

MIT — see [`LICENSE`](./LICENSE).
