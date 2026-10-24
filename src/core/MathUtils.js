/**
 * MathUtils.js
 * Minimal, dependency-free linear algebra kernel (column-major, Float32Array-backed,
 * compatible with WebGL's uniformMatrix4fv transpose=false convention).
 * Shared by SceneManager (bone matrices), Timeline (TRS evaluation), and StretchRig.
 */

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static add(a, b) { return new Vec3(a.x + b.x, a.y + b.y, a.z + b.z); }
  static sub(a, b) { return new Vec3(a.x - b.x, a.y - b.y, a.z - b.z); }
  static scale(a, s) { return new Vec3(a.x * s, a.y * s, a.z * s); }
  static lerp(a, b, t) { return new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  static length(a) { return Math.hypot(a.x, a.y, a.z); }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static cross(a, b) { return new Vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
  static normalize(a) {
    const len = Vec3.length(a);
    return len > 1e-8 ? new Vec3(a.x / len, a.y / len, a.z / len) : new Vec3(0, 0, 0);
  }
  clone() { return new Vec3(this.x, this.y, this.z); }
}

/** Transforms a point (not a direction — translation included) by a column-major 4x4 matrix. */
export function transformPoint(m, v) {
  return new Vec3(
    m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
    m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
    m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14],
  );
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }

  static fromAxisAngle(axis, rad) {
    const half = rad * 0.5;
    const s = Math.sin(half);
    const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
    return new Quat((axis.x / len) * s, (axis.y / len) * s, (axis.z / len) * s, Math.cos(half));
  }

  /** Spherical linear interpolation — used for bone rotation keyframes. */
  static slerp(a, b, t) {
    let { x: ax, y: ay, z: az, w: aw } = a;
    let { x: bx, y: by, z: bz, w: bw } = b;
    let dot = ax * bx + ay * by + az * bz + aw * bw;

    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }

    const EPS = 1e-6;
    if (dot > 1 - EPS) {
      // Nearly identical: fall back to normalized lerp to avoid division by ~0.
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
      const len = Math.hypot(x, y, z, w) || 1;
      return new Quat(x / len, y / len, z / len, w / len);
    }

    const theta0 = Math.acos(dot);
    const theta = theta0 * t;
    const sinTheta0 = Math.sin(theta0);
    const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / sinTheta0;
    const s1 = Math.sin(theta) / sinTheta0;

    return new Quat(
      ax * s0 + bx * s1,
      ay * s0 + by * s1,
      az * s0 + bz * s1,
      aw * s0 + bw * s1,
    );
  }

  toMat4(out = new Float32Array(16)) {
    const { x, y, z, w } = this;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    out[0] = 1 - (yy + zz); out[1] = xy + wz;       out[2] = xz - wy;       out[3] = 0;
    out[4] = xy - wz;       out[5] = 1 - (xx + zz); out[6] = yz + wx;       out[7] = 0;
    out[8] = xz + wy;       out[9] = yz - wx;       out[10] = 1 - (xx + yy); out[11] = 0;
    out[12] = 0;            out[13] = 0;            out[14] = 0;            out[15] = 1;
    return out;
  }
}

/** Compose T * R * S (with optional non-uniform per-axis scale for squash & stretch). */
export function composeTRS(translation, quat, scale, out = new Float32Array(16)) {
  const r = quat.toMat4();
  const sx = scale.x, sy = scale.y, sz = scale.z;

  out[0] = r[0] * sx; out[1] = r[1] * sx; out[2] = r[2] * sx; out[3] = 0;
  out[4] = r[4] * sy; out[5] = r[5] * sy; out[6] = r[6] * sy; out[7] = 0;
  out[8] = r[8] * sz; out[9] = r[9] * sz; out[10] = r[10] * sz; out[11] = 0;
  out[12] = translation.x; out[13] = translation.y; out[14] = translation.z; out[15] = 1;
  return out;
}

export function mat4Multiply(a, b, out = new Float32Array(16)) {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function mat4Identity(out = new Float32Array(16)) {
  out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return out;
}
