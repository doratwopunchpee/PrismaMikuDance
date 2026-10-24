# PRISMAMD — Architecture Overview

Open-source, mobile-first 3D MMD animation application.
Viewport/workflow modeled on **Prisma3D**; visual language modeled on
**Synthesizer V** (flat dark-charcoal panels, compact type, zero flash).

Runtime target: Android/iOS via a cross-platform WebView shell
(Capacitor/Tauri-mobile class tooling — any shell that exposes a
native filesystem + permissions bridge to JS). Rendering: WebGL2
with a WebGPU/WGSL path behind a capability flag.

```
/PRISMAMD
 ├─ core/
 │   ├─ FileSystemManager.js   (1) storage + asset hooking
 │   ├─ SceneManager.js        (2) multi-model scene graph
 │   ├─ Timeline.js            (3) keyframes + playback clock
 │   ├─ BezierEasing.js        (3) interpolation graph math
 │   └─ MathUtils.js           shared matrix/quaternion kernel
 ├─ io/
 │   ├─ ImportExport.js        (4) .pmd/.pmx/.vmd/.vpd/.fbx/.x
 │   └─ PMDPFormat.js          (4) .pmdp project container
 ├─ render/
 │   ├─ ShaderCore.js          (5) toon + SPH GLSL/WGSL
 │   ├─ StretchRig.js          (5) squash & stretch bone math
 │   └─ FXAdaptor.js           (5) legacy .fx → mobile pipeline
 └─ perf/
     └─ PerformanceController.js (6) IK/MotionBlur/HideFX/export caps
```

## Execution loop (single frame)

```
AppLoop.tick(dt)
 ├─ Timeline.advance(dt)                     // 3
 ├─ for each model in SceneManager.models:    // 2
 │    model.skeleton.evaluate(timeline.t)
 │    StretchRig.applyNonUniformBones(model)  // 5
 │    model.skinning.update()
 ├─ PerformanceController.applyToggles(frame) // 6
 └─ Renderer.draw(SceneManager.models, camera, ShaderCore)
```

Every subsystem below is written as a standalone ES6 module with no
hidden globals, so it can be unit-tested outside the WebView shell.
