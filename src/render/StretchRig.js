/**
 * StretchRig.js
 * Section 5 — squash & stretch: non-uniform bone matrix modifiers applied
 * directly in the transform loop, letting an animator stretch/squeeze a
 * bone's length along its own local axis (classic cartoon-animation rig,
 * not natively present in MMD's rigid bone system).
 */

import { Vec3 } from '../core/MathUtils.js';

/** Per-bone squash/stretch state the UI's bone inspector edits directly. */
export class StretchChannel {
  constructor(boneName) {
    this.boneName = boneName;
    this.axisStretch = new Vec3(1, 1, 1); // multiplier per local axis; (1,1,1) = no-op
    this.volumePreserve = true;           // when true, compresses the other two axes to conserve volume
  }

  /** Returns the final non-uniform local scale to feed into composeTRS. */
  resolveScale(baseScale) {
    if (!this.volumePreserve) {
      return new Vec3(
        baseScale.x * this.axisStretch.x,
        baseScale.y * this.axisStretch.y,
        baseScale.z * this.axisStretch.z,
      );
    }
    // Approximate volume preservation: stretch one axis, compress the other
    // two by 1/sqrt(stretch), matching the classic squash-and-stretch rule.
    const { x: sx, y: sy, z: sz } = this.axisStretch;
    const dominant = Math.max(Math.abs(sx - 1), Math.abs(sy - 1), Math.abs(sz - 1));
    if (dominant === 0) return baseScale.clone();

    const compensate = 1 / Math.sqrt(Math.max(sx, sy, sz, 1e-4));
    return new Vec3(
      baseScale.x * (sx !== 1 ? sx : compensate),
      baseScale.y * (sy !== 1 ? sy : compensate),
      baseScale.z * (sz !== 1 ? sz : compensate),
    );
  }
}

export class StretchRig {
  constructor() {
    /** @type {Map<string, StretchChannel>} boneName -> channel */
    this.channels = new Map();
  }

  getOrCreateChannel(boneName) {
    if (!this.channels.has(boneName)) this.channels.set(boneName, new StretchChannel(boneName));
    return this.channels.get(boneName);
  }

  /** Called each frame from SceneManager.stepAll, before world-matrix composition finalizes. */
  applyToSkeleton(skeleton) {
    for (const bone of skeleton.bones) {
      const channel = this.channels.get(bone.name);
      if (!channel) continue;
      bone.localScale = channel.resolveScale(bone.localScale);
    }
  }
}

export const stretchRig = new StretchRig();
