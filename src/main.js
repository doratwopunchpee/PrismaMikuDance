/**
 * main.js
 * Mobile app bootstrap: installs the Capacitor filesystem bridge, then
 * brings up the core subsystems in dependency order. This is the entry
 * point the www/index.html shell loads.
 */

import { installCapacitorFSBridge } from './platform/CapacitorFSBridge.js';
import { fileSystem } from './core/FileSystemManager.js';
import { sceneManager } from './core/SceneManager.js';
import { timeline } from './core/Timeline.js';
import { composeTRS, mat4Multiply } from './core/MathUtils.js';
import { stretchRig } from './render/StretchRig.js';
import { clippingPrevention } from './core/ClippingPrevention.js';
import { performanceController } from './perf/PerformanceController.js';

async function bootstrap() {
  installCapacitorFSBridge();

  // Section 1: request permission + create /PRISMAMD/Models, /Motions, etc.,
  // then start the live asset watchers the UI's model/motion pickers subscribe to.
  await fileSystem.initialize();

  fileSystem.onAssetsChanged((dir, entries) => {
    // UI layer hooks in here to repopulate pickers the instant a file lands.
    console.log(`[PRISMAMD] ${dir} changed:`, entries.map(e => e.name));
  });

  timeline.setFps(30);
  performanceController.setExportResolution('1080p');

  // Render loop — the actual WebGL2/WebGPU context setup lives in a
  // separate render bootstrap module once a canvas is wired up in index.html.
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    timeline.advance(dt);
    sceneManager.stepAll({
      composeTRS,
      mat4Multiply,
      stretchRig,
      clipping: clippingPrevention,
      perf: performanceController,
    });

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

bootstrap().catch(err => {
  console.error('[PRISMAMD] bootstrap failed:', err);
});
