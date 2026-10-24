/**
 * ClippingPrevention.js
 * Corrective collision avoidance between bones — aimed squarely at the
 * classic retarget problem: human motion capture applied to a cartoonish
 * character whose proportions don't match the source skeleton, so an
 * oversized arm/hand swings straight through the face or torso where a
 * human-proportioned arm never would have reached.
 *
 * This is deliberately NOT a physics simulation. It's a cheap post-pose
 * positional correction: bones get simple collider shapes (sphere or
 * capsule), overlapping pairs are pushed apart along the separation axis
 * each frame, weighted by a per-collider `pushWeight` so an author can mark
 * sensitive geometry (a face) as mostly immovable and let a limb yield
 * instead of distorting the face to dodge it. That's a deliberate design
 * choice for a real-time mobile app: a full constraint solver or FK/IK
 * re-pass would cost far more per frame than this is worth for what's
 * fundamentally a visual-plausibility fix, not physical accuracy.
 *
 * Runs once per frame across every posed model — after every model's
 * Skeleton.evaluateWorldMatrices() (and StretchRig) has run, before any
 * model's updateSkinning() — see SceneManager.stepAll. Works identically
 * for two different models clipping into each other (a crowd scene) and
 * for one model's own limbs clipping into itself.
 */

import { Vec3, transformPoint } from './MathUtils.js';

// ---------- collider shapes (defined in bone-local space, transformed to world each frame) ----------

export class SphereCollider {
  /**
   * @param {string} boneName
   * @param {object} opts
   * @param {{x:number,y:number,z:number}} [opts.offset] bone-local center offset
   * @param {number} [opts.radius]
   * @param {number} [opts.pushWeight] 0 = immovable/protected (e.g. face), 1 = moves normally, >1 = yields more readily than its opponent
   * @param {number} [opts.adjacencyDepth] same-model parent/child chain depth to exclude from collision (joints are supposed to touch)
   */
  constructor(boneName, { offset = { x: 0, y: 0, z: 0 }, radius = 1, pushWeight = 1, adjacencyDepth = 1 } = {}) {
    this.type = 'sphere';
    this.boneName = boneName;
    this.offset = offset;
    this.radius = radius;
    this.pushWeight = pushWeight;
    this.adjacencyDepth = adjacencyDepth;
  }
}

export class CapsuleCollider {
  /** Same as SphereCollider but swept between two bone-local points — fits a limb segment better than a single sphere. */
  constructor(boneName, { offsetA = { x: 0, y: 0, z: 0 }, offsetB = { x: 0, y: 1, z: 0 }, radius = 1, pushWeight = 1, adjacencyDepth = 1 } = {}) {
    this.type = 'capsule';
    this.boneName = boneName;
    this.offsetA = offsetA;
    this.offsetB = offsetB;
    this.radius = radius;
    this.pushWeight = pushWeight;
    this.adjacencyDepth = adjacencyDepth;
  }
}

// ---------- closest-point geometry (Ericson, Real-Time Collision Detection §5.1.9, compacted) ----------

/** Closest point on segment [a,b] to point p. */
function closestPointOnSegment(p, a, b) {
  const ab = Vec3.sub(b, a);
  const t = Vec3.dot(Vec3.sub(p, a), ab) / Math.max(Vec3.dot(ab, ab), 1e-10);
  const clamped = Math.min(Math.max(t, 0), 1);
  return Vec3.add(a, Vec3.scale(ab, clamped));
}

/** Closest points between two segments [p1,q1] and [p2,q2]; returns { c1, c2 }. */
function closestPointsBetweenSegments(p1, q1, p2, q2) {
  const d1 = Vec3.sub(q1, p1), d2 = Vec3.sub(q2, p2), r = Vec3.sub(p1, p2);
  const a = Vec3.dot(d1, d1), e = Vec3.dot(d2, d2), f = Vec3.dot(d2, r);
  let s, t;

  if (a <= 1e-10 && e <= 1e-10) { s = 0; t = 0; }
  else if (a <= 1e-10) { s = 0; t = Math.min(Math.max(f / e, 0), 1); }
  else {
    const c = Vec3.dot(d1, r);
    if (e <= 1e-10) { t = 0; s = Math.min(Math.max(-c / a, 0), 1); }
    else {
      const b = Vec3.dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.min(Math.max((b * f - c * e) / denom, 0), 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(Math.max(-c / a, 0), 1); }
      else if (t > 1) { t = 1; s = Math.min(Math.max((b - c) / a, 0), 1); }
    }
  }

  return { c1: Vec3.add(p1, Vec3.scale(d1, s)), c2: Vec3.add(p2, Vec3.scale(d2, t)) };
}

// ---------- resolved collider: world-space shape for one collider this frame ----------

function resolveWorldShape(entry) {
  const worldMatrix = entry.model.skeleton.bones[entry.boneIndex].worldMatrix;
  const c = entry.collider;
  if (c.type === 'sphere') {
    return { type: 'sphere', center: transformPoint(worldMatrix, c.offset), radius: c.radius };
  }
  return {
    type: 'capsule',
    a: transformPoint(worldMatrix, c.offsetA),
    b: transformPoint(worldMatrix, c.offsetB),
    radius: c.radius,
  };
}

/** Returns { axis: Vec3 (unit, points from A toward B), depth: number } if overlapping, else null. */
function testOverlap(shapeA, shapeB) {
  let centerA, centerB, radiusSum;

  if (shapeA.type === 'sphere' && shapeB.type === 'sphere') {
    centerA = shapeA.center; centerB = shapeB.center;
    radiusSum = shapeA.radius + shapeB.radius;
  } else if (shapeA.type === 'sphere' && shapeB.type === 'capsule') {
    centerA = shapeA.center; centerB = closestPointOnSegment(shapeA.center, shapeB.a, shapeB.b);
    radiusSum = shapeA.radius + shapeB.radius;
  } else if (shapeA.type === 'capsule' && shapeB.type === 'sphere') {
    centerB = shapeB.center; centerA = closestPointOnSegment(shapeB.center, shapeA.a, shapeA.b);
    radiusSum = shapeA.radius + shapeB.radius;
  } else {
    const { c1, c2 } = closestPointsBetweenSegments(shapeA.a, shapeA.b, shapeB.a, shapeB.b);
    centerA = c1; centerB = c2;
    radiusSum = shapeA.radius + shapeB.radius;
  }

  const delta = Vec3.sub(centerB, centerA);
  const dist = Vec3.length(delta);
  const depth = radiusSum - dist;
  if (depth <= 0) return null;

  // Coincident centers (dist ~0): pick an arbitrary stable axis rather than divide by zero.
  const axis = dist > 1e-6 ? Vec3.scale(delta, 1 / dist) : new Vec3(0, 1, 0);
  return { axis, depth };
}

// ---------- subtree translation (keeps a corrected bone's children attached) ----------

const _descendantCache = new WeakMap(); // Skeleton -> Map<boneIndex, number[]>

function getDescendantIndices(skeleton, boneIndex) {
  let perSkeleton = _descendantCache.get(skeleton);
  if (!perSkeleton) { perSkeleton = new Map(); _descendantCache.set(skeleton, perSkeleton); }
  if (perSkeleton.has(boneIndex)) return perSkeleton.get(boneIndex);

  // Bones are stored parent-before-child (standard PMX/MMD convention), so a
  // single forward scan correctly finds every descendant via its ancestor chain.
  const isDescendant = new Array(skeleton.bones.length).fill(false);
  isDescendant[boneIndex] = true;
  for (let i = boneIndex + 1; i < skeleton.bones.length; i++) {
    const parent = skeleton.bones[i].parentIndex;
    if (parent >= 0 && isDescendant[parent]) isDescendant[i] = true;
  }
  const result = [];
  for (let i = 0; i < isDescendant.length; i++) if (isDescendant[i]) result.push(i);
  perSkeleton.set(boneIndex, result);
  return result;
}

/** Rigidly translates a bone and its whole subtree by delta — a cheap "drag", not a re-solved pose. */
function translateSubtree(skeleton, boneIndex, delta) {
  if (delta.x === 0 && delta.y === 0 && delta.z === 0) return;
  for (const idx of getDescendantIndices(skeleton, boneIndex)) {
    const m = skeleton.bones[idx].worldMatrix;
    m[12] += delta.x; m[13] += delta.y; m[14] += delta.z;
  }
}

/** Is this bone an ancestor or descendant of the other, within `depth` steps? Joints are meant to touch, so skip them. */
function isSkeletallyAdjacent(skeleton, indexA, indexB, depth) {
  const chainContains = (start, target, steps) => {
    let cur = start;
    for (let i = 0; i < steps && cur >= 0; i++) {
      cur = skeleton.bones[cur].parentIndex;
      if (cur === target) return true;
    }
    return false;
  };
  return chainContains(indexA, indexB, depth) || chainContains(indexB, indexA, depth);
}

// ---------- the system ----------

export class ClippingPreventionSystem {
  constructor() {
    /** @type {Array<{model:object, boneIndex:number, collider:(SphereCollider|CapsuleCollider)}>} */
    this.colliders = [];
    this.enabled = true;
    /** Multiple relaxation passes settle chained contacts (e.g. three overlapping limbs) better than one. */
    this.iterations = 2;
  }

  /** @param {object} modelInstance a SceneManager.ModelInstance @param {SphereCollider|CapsuleCollider} collider */
  registerCollider(modelInstance, collider) {
    const boneIndex = modelInstance.skeleton.bones.findIndex(b => b.name === collider.boneName);
    if (boneIndex === -1) {
      throw new Error(`ClippingPrevention: bone "${collider.boneName}" not found on model "${modelInstance.name}"`);
    }
    this.colliders.push({ model: modelInstance, boneIndex, collider });
  }

  clearModel(modelInstance) {
    this.colliders = this.colliders.filter(entry => entry.model !== modelInstance);
  }

  /** Call once per frame after every model's skeleton has been posed, before any model is skinned. */
  resolve() {
    if (!this.enabled || this.colliders.length < 2) return;

    for (let pass = 0; pass < this.iterations; pass++) {
      for (let i = 0; i < this.colliders.length; i++) {
        const a = this.colliders[i];
        for (let j = i + 1; j < this.colliders.length; j++) {
          const b = this.colliders[j];

          const sameModel = a.model === b.model;
          const depth = Math.max(a.collider.adjacencyDepth, b.collider.adjacencyDepth);
          if (sameModel && isSkeletallyAdjacent(a.model.skeleton, a.boneIndex, b.boneIndex, depth)) continue;

          const shapeA = resolveWorldShape(a);
          const shapeB = resolveWorldShape(b);
          const overlap = testOverlap(shapeA, shapeB);
          if (!overlap) continue;

          const wA = a.collider.pushWeight, wB = b.collider.pushWeight;
          const total = wA + wB;
          if (total <= 0) continue; // both sides marked immovable — nothing we can do without distorting a protected part

          const moveA = overlap.depth * (wA / total);
          const moveB = overlap.depth * (wB / total);
          translateSubtree(a.model.skeleton, a.boneIndex, Vec3.scale(overlap.axis, -moveA));
          translateSubtree(b.model.skeleton, b.boneIndex, Vec3.scale(overlap.axis, moveB));
        }
      }
    }
  }
}

export const clippingPrevention = new ClippingPreventionSystem();
