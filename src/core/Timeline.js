/**
 * Timeline.js
 * Section 3 — system clock, framerate profiles, and the diamond-keyframe
 * data schema for both model bone tracks and the camera rig.
 */

import { Vec3, Quat } from './MathUtils.js';
import { EasingPresets, KeyframeInterpolator } from './BezierEasing.js';

export const FRAME_RATE_OPTIONS = Object.freeze([12, 15, 30, 60]);
export const DEFAULT_FPS = 30;

/** One diamond marker on the UI timeline: a TRS sample at a given frame. */
export class Keyframe {
  /**
   * @param {number} frame integer frame index
   * @param {Vec3} translation
   * @param {Quat} rotation
   * @param {Vec3} scale
   * @param {KeyframeInterpolator} [interpolatorOut] curve governing the segment *leaving* this key
   */
  constructor(frame, translation = new Vec3(), rotation = new Quat(), scale = new Vec3(1, 1, 1),
    interpolatorOut = new KeyframeInterpolator(EasingPresets.Linear())) {
    this.frame = frame;
    this.translation = translation;
    this.rotation = rotation;
    this.scale = scale;
    this.interpolatorOut = interpolatorOut;
  }
}

/** A single animatable channel (one bone, or the camera) — a sorted list of Keyframes. */
export class Track {
  constructor(targetId, label) {
    this.targetId = targetId; // bone name or 'camera'
    this.label = label;
    /** @type {Keyframe[]} kept sorted ascending by frame */
    this.keyframes = [];
  }

  insertKeyframe(keyframe) {
    const idx = this.keyframes.findIndex(k => k.frame === keyframe.frame);
    if (idx >= 0) { this.keyframes[idx] = keyframe; return; }
    const insertAt = this.keyframes.findIndex(k => k.frame > keyframe.frame);
    if (insertAt === -1) this.keyframes.push(keyframe);
    else this.keyframes.splice(insertAt, 0, keyframe);
  }

  removeKeyframeAt(frame) {
    this.keyframes = this.keyframes.filter(k => k.frame !== frame);
  }

  /** Sample the track's TRS at an arbitrary (possibly fractional) frame. */
  sample(frame) {
    const ks = this.keyframes;
    if (ks.length === 0) return null;
    if (frame <= ks[0].frame) return { translation: ks[0].translation, rotation: ks[0].rotation, scale: ks[0].scale };
    if (frame >= ks[ks.length - 1].frame) {
      const last = ks[ks.length - 1];
      return { translation: last.translation, rotation: last.rotation, scale: last.scale };
    }

    let a = ks[0], b = ks[ks.length - 1];
    for (let i = 0; i < ks.length - 1; i++) {
      if (frame >= ks[i].frame && frame <= ks[i + 1].frame) { a = ks[i]; b = ks[i + 1]; break; }
    }

    const span = b.frame - a.frame || 1;
    const t = (frame - a.frame) / span;
    const interp = a.interpolatorOut;

    return {
      translation: new Vec3(
        interp.interpolateScalar(a.translation.x, b.translation.x, t),
        interp.interpolateScalar(a.translation.y, b.translation.y, t),
        interp.interpolateScalar(a.translation.z, b.translation.z, t),
      ),
      rotation: Quat.slerp(a.rotation, b.rotation, interp.curve.solve(t)),
      scale: new Vec3(
        interp.interpolateScalar(a.scale.x, b.scale.x, t),
        interp.interpolateScalar(a.scale.y, b.scale.y, t),
        interp.interpolateScalar(a.scale.z, b.scale.z, t),
      ),
    };
  }
}

/** Fractional-frame system clock. Supports scrubbing, play/pause, and live FPS switching. */
export class Timeline {
  constructor(fps = DEFAULT_FPS) {
    this.setFps(fps);
    this.currentFrame = 0;
    this.isPlaying = false;
    this.lengthFrames = 300;
    /** @type {Map<string, Track>} keyed by targetId ('camera' or bone/model name) */
    this.tracks = new Map();
  }

  setFps(fps) {
    if (!FRAME_RATE_OPTIONS.includes(fps)) {
      throw new Error(`Unsupported FPS profile: ${fps}. Choose one of ${FRAME_RATE_OPTIONS.join(', ')}`);
    }
    this.fps = fps;
    this.secondsPerFrame = 1 / fps;
  }

  getOrCreateTrack(targetId, label = targetId) {
    if (!this.tracks.has(targetId)) this.tracks.set(targetId, new Track(targetId, label));
    return this.tracks.get(targetId);
  }

  /** Called once per render loop tick with real elapsed seconds; advances fractional frame. */
  advance(dtSeconds) {
    if (!this.isPlaying) return;
    this.currentFrame += dtSeconds * this.fps;
    if (this.currentFrame > this.lengthFrames) this.currentFrame = 0; // loop by default
  }

  seek(frame) {
    this.currentFrame = Math.max(0, Math.min(this.lengthFrames, frame));
  }

  play() { this.isPlaying = true; }
  pause() { this.isPlaying = false; }

  /** Evaluate every track at the current fractional frame; caller applies results to bones/camera. */
  evaluateAll() {
    const results = new Map();
    for (const [targetId, track] of this.tracks) {
      results.set(targetId, track.sample(this.currentFrame));
    }
    return results;
  }
}

export const timeline = new Timeline();
