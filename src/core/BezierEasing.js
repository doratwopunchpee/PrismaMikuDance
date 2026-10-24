/**
 * BezierEasing.js
 * Section 3 — interpolation graph engine. Cubic-bezier easing with
 * hand-editable control-point handles (P0=(0,0) fixed, P3=(1,1) fixed,
 * P1/P2 free — the standard CSS-cubic-bezier convention used by MMD-style
 * curve editors), plus named presets (Ease-In, Ease-Out, Linear, Step).
 *
 * Solves x(t) via Newton-Raphson (fast, stable for monotonic x) with a
 * bisection fallback, then returns y(t) — exactly how timeline curve
 * handles should drive keyframe interpolation.
 */

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 1e-3;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 10;

function A(a1, a2) { return 1.0 - 3.0 * a2 + 3.0 * a1; }
function B(a1, a2) { return 3.0 * a2 - 6.0 * a1; }
function C(a1) { return 3.0 * a1; }

function calcBezier(t, a1, a2) {
  return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
}

function getSlope(t, a1, a2) {
  return 3.0 * A(a1, a2) * t * t + 2.0 * B(a1, a2) * t + C(a1);
}

/**
 * CubicBezierCurve — one editable interpolation segment between two
 * adjacent diamond keyframes.
 */
export class CubicBezierCurve {
  /** @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 handle coords, each in [0,1] */
  constructor(x1, y1, x2, y2) {
    this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2;
  }

  _solveX(x) {
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const slope = getSlope(t, this.x1, this.x2);
      if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
      const xEst = calcBezier(t, this.x1, this.x2) - x;
      t -= xEst / slope;
    }

    // Bisection fallback for degenerate slopes (e.g. Step-like handles).
    let lo = 0, hi = 1, guess = t;
    for (let i = 0; i < SUBDIVISION_MAX_ITERATIONS; i++) {
      guess = this._isValid(t) ? t : (lo + hi) / 2;
      const xEst = calcBezier(guess, this.x1, this.x2) - x;
      if (Math.abs(xEst) < SUBDIVISION_PRECISION) break;
      if (xEst > 0) hi = guess; else lo = guess;
    }
    return guess;
  }

  _isValid(t) { return t >= 0 && t <= 1 && isFinite(t); }

  /** Main entry point: given normalized time x in [0,1], return eased y. */
  solve(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const t = this._solveX(x);
    return calcBezier(t, this.y1, this.y2);
  }

  /**
   * Builds handles from a velocity+influence pair per side — the control
   * scheme motion-graphics tools (Alight Motion, After Effects "Easy Ease")
   * expose instead of raw x/y handles:
   *   - velocity: tangent slope at the keyframe. 0 = flat start/end (classic
   *     ease), 1 = matches the straight linear path, >1 "throws" past it.
   *   - influence: 0–100%, how far along the segment that velocity holds
   *     before the curve bends back toward the other end (handle length).
   * Internally this is just a reparameterization of the same P1/P2 handles
   * CubicBezierCurve already uses — nothing new is solved, only expressed
   * in the vocabulary that control feels like in a velocity-handle editor.
   */
  static fromVelocity({ outVelocity = 0, outInfluence = 33.33, inVelocity = 0, inInfluence = 33.33 } = {}) {
    const x1 = Math.min(Math.max(outInfluence / 100, 0.001), 1);
    const y1 = outVelocity * x1;
    const x2 = 1 - Math.min(Math.max(inInfluence / 100, 0.001), 1);
    const y2 = 1 - inVelocity * (1 - x2);
    return new CubicBezierCurve(x1, y1, x2, y2);
  }
}

// ---------------------------------------------------------------------
// Non-bezier preset curves. Bounce/Elastic/Back/Anticipate overshoot or
// oscillate past [0,1] and can't be expressed as a single cubic bezier —
// each is its own closed-form `solve(x)` (Robert Penner's standard
// equations), but shares the same `{ solve(x) }` interface as
// CubicBezierCurve so KeyframeInterpolator never needs to know which kind
// of curve it's holding.
// ---------------------------------------------------------------------

function easeOutBounce(x) {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
  if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
  x -= 2.625 / d1; return n1 * x * x + 0.984375;
}
function easeInBounce(x) { return 1 - easeOutBounce(1 - x); }
function easeInOutBounce(x) {
  return x < 0.5 ? (1 - easeOutBounce(1 - 2 * x)) / 2 : (1 + easeOutBounce(2 * x - 1)) / 2;
}

function easeOutElastic(x) {
  if (x === 0 || x === 1) return x;
  const p = 0.3, s = p / 4;
  return Math.pow(2, -10 * x) * Math.sin((x - s) * (2 * Math.PI) / p) + 1;
}
function easeInElastic(x) {
  if (x === 0 || x === 1) return x;
  const p = 0.3, s = p / 4;
  return -Math.pow(2, 10 * (x - 1)) * Math.sin((x - 1 - s) * (2 * Math.PI) / p);
}
function easeInOutElastic(x) {
  if (x === 0 || x === 1) return x;
  const p = 0.45, s = p / 4;
  const scaled = 2 * x - 1;
  if (scaled < 0) return -0.5 * Math.pow(2, 10 * scaled) * Math.sin((scaled - s) * (2 * Math.PI) / p);
  return Math.pow(2, -10 * scaled) * Math.sin((scaled - s) * (2 * Math.PI) / p) * 0.5 + 1;
}

/** Back/overshoot: the "throw past the target, settle back" motion-graphics curve. */
function easeInBack(x, overshoot = 1.70158) { return x * x * ((overshoot + 1) * x - overshoot); }
function easeOutBack(x, overshoot = 1.70158) {
  const t = x - 1;
  return 1 + (overshoot + 1) * t * t * t + overshoot * t * t;
}
function easeInOutBack(x, overshoot = 1.70158) {
  const s = overshoot * 1.525;
  const t = x * 2;
  if (t < 1) return 0.5 * (t * t * ((s + 1) * t - s));
  const t2 = t - 2;
  return 0.5 * (t2 * t2 * ((s + 1) * t2 + s) + 2);
}

/** Named presets matching the MMD/animation-standard easing vocabulary,
 *  extended with the motion-graphics set (Bounce, Elastic, Back/Overshoot,
 *  Anticipate, and raw Velocity handles) — the vocabulary Alight Motion's
 *  keyframe graph editor uses. */
export const EasingPresets = Object.freeze({
  Linear: () => new CubicBezierCurve(0, 0, 1, 1),
  EaseIn: () => new CubicBezierCurve(0.42, 0, 1, 1),
  EaseOut: () => new CubicBezierCurve(0, 0, 0.58, 1),
  EaseInOut: () => new CubicBezierCurve(0.42, 0, 0.58, 1),
  /** Step is not a true bezier; handled as a discrete special-case curve. */
  Step: () => ({ solve: x => (x >= 1 ? 1 : 0) }),

  BounceIn: () => ({ solve: easeInBounce }),
  BounceOut: () => ({ solve: easeOutBounce }),
  BounceInOut: () => ({ solve: easeInOutBounce }),

  ElasticIn: () => ({ solve: easeInElastic }),
  ElasticOut: () => ({ solve: easeOutElastic }),
  ElasticInOut: () => ({ solve: easeInOutElastic }),

  /** "Overshoot" in most motion-graphics UIs: throws past the end value, settles back. */
  OvershootIn: () => ({ solve: x => easeInBack(x) }),
  OvershootOut: () => ({ solve: x => easeOutBack(x) }),
  OvershootInOut: () => ({ solve: x => easeInOutBack(x) }),

  /** Anticipate: dips backward before committing forward — a stronger EaseInBack. */
  Anticipate: () => ({ solve: x => easeInBack(x, 2) }),

  /** Raw velocity+influence handles, the per-keyframe "speed in/out" control scheme. */
  Velocity: (opts) => CubicBezierCurve.fromVelocity(opts),
});

/**
 * KeyframeInterpolator — wraps a CubicBezierCurve per-channel (translation /
 * rotation / scale each may have independently hand-edited handles, as in
 * MMD's bone interpolation panel).
 */
export class KeyframeInterpolator {
  constructor(curve = EasingPresets.EaseInOut()) {
    this.curve = curve;
  }

  /** value(t) between two keyframe endpoints a,b at normalized time t in [0,1]. */
  interpolateScalar(a, b, t) {
    const eased = this.curve.solve(t);
    return a + (b - a) * eased;
  }

  setHandles(x1, y1, x2, y2) {
    this.curve = new CubicBezierCurve(x1, y1, x2, y2);
  }
}
