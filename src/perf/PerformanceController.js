/**
 * PerformanceController.js
 * Section 6 — system performance resolution caps and modular loop debug
 * bypasses. Single source of truth read by SceneManager (IK), the
 * post-process pass (Motion Blur), and the renderer (Hide FX, export caps).
 */

export const EXPORT_RESOLUTIONS = Object.freeze({
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
});

export class PerformanceController {
  constructor() {
    this.flags = {
      ik: true,
      motionBlur: true,
      hideFX: false, // debug override: when true, forces all custom shaders/post FX off
      clippingPrevention: true, // bone collision avoidance (core/ClippingPrevention.js)
    };
    this._exportResolutionKey = '1080p';
  }

  // ---- loop debug toggles ----

  setIK(enabled) { this.flags.ik = !!enabled; }
  setMotionBlur(enabled) { this.flags.motionBlur = !!enabled; }
  setHideFX(enabled) { this.flags.hideFX = !!enabled; }
  setClippingPrevention(enabled) { this.flags.clippingPrevention = !!enabled; }

  /** Renderer calls this before building its pass list each frame. */
  shouldRunCustomShaders() {
    return !this.flags.hideFX;
  }

  shouldRunMotionBlurPass() {
    return this.flags.motionBlur && !this.flags.hideFX;
  }

  shouldRunIK() {
    return this.flags.ik;
  }

  shouldRunClippingPrevention() {
    return this.flags.clippingPrevention;
  }

  // ---- hardwired export resolution clamp ----

  /** Only '720p' or '1080p' are ever accepted — anything else throws, by design. */
  setExportResolution(key) {
    if (!(key in EXPORT_RESOLUTIONS)) {
      throw new Error(`Export resolution locked to ${Object.keys(EXPORT_RESOLUTIONS).join(' or ')}; got "${key}"`);
    }
    this._exportResolutionKey = key;
  }

  getExportResolution() {
    return { key: this._exportResolutionKey, ...EXPORT_RESOLUTIONS[this._exportResolutionKey] };
  }

  /** Hardware rendering wrapper calls this to clamp any attempted off-spec render target. */
  clampRenderTarget(requestedWidth, requestedHeight) {
    const capWidth = EXPORT_RESOLUTIONS['1080p'].width;
    const capHeight = EXPORT_RESOLUTIONS['1080p'].height;
    return {
      width: Math.min(requestedWidth, capWidth),
      height: Math.min(requestedHeight, capHeight),
    };
  }

  toJSON() {
    return { flags: { ...this.flags }, exportResolution: this._exportResolutionKey };
  }
}

export const performanceController = new PerformanceController();
