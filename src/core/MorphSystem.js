/**
 * MorphSystem.js
 * Facial morph (blend shape) support, matching MMD's morph panel model:
 * four named panels — Eyebrow / Eye / Mouth / Other — each holding a set
 * of named morphs the animator drives with a 0–1 weight slider.
 *
 * MMD's PMX format defines several morph types (group, vertex, bone, UV,
 * material, flip, impulse). Vertex morphs — per-vertex position offsets,
 * blended by weight — are what drive the overwhelming majority of facial
 * expression work (mouth shapes, eye shapes, eyebrow shapes), and group
 * morphs (a weighted combination of other morphs, e.g. a single "smile"
 * slider driving several mouth-corner vertex morphs at once) are the other
 * panel staple, so both are fully implemented here. Bone/UV/material/flip/
 * impulse morphs are parsed and stored (see io/ImportExport.js) but their
 * per-frame application is an extension point — same pattern as the IK
 * solver pass stub in SceneManager.js.
 */

export const MorphPanel = Object.freeze({
  SYSTEM: 0,  // hidden "base" panel MMD reserves internally; not shown in the UI
  EYEBROW: 1,
  EYE: 2,
  MOUTH: 3,
  OTHER: 4,
});

export const MorphType = Object.freeze({
  GROUP: 'group',
  VERTEX: 'vertex',
  BONE: 'bone',
  UV: 'uv',
  MATERIAL: 'material',
  FLIP: 'flip',
  IMPULSE: 'impulse',
});

/** One named morph: either a set of vertex offsets, or a weighted combination of other morphs. */
export class MorphTarget {
  constructor({ name, nameEn = '', panel = MorphPanel.OTHER, type = MorphType.VERTEX }) {
    this.name = name;
    this.nameEn = nameEn;
    this.panel = panel;
    this.type = type;

    /** @type {Array<{vertexIndex:number, dx:number, dy:number, dz:number}>} type === VERTEX */
    this.vertexOffsets = [];

    /** @type {Array<{morphIndex:number, weight:number}>} type === GROUP — weight here is this
     *  sub-morph's *contribution ratio*, multiplied by the group morph's own slider weight. */
    this.groupMembers = [];

    /** Raw, unapplied payload for morph types this system doesn't drive yet
     *  (bone/UV/material/flip/impulse) — kept so nothing parsed is discarded. */
    this.rawPayload = null;
  }
}

/**
 * Per-model morph state: current slider weights plus the blending logic
 * that turns those weights into a modified vertex buffer, consumed by
 * ModelInstance.updateSkinning() *before* bone skinning runs (vertex
 * morphs deform the rest pose; skinning then poses the deformed mesh).
 */
export class MorphController {
  /** @param {MorphTarget[]} morphs all morphs this model's mesh defines, PMX-table order (so group members' morphIndex lines up) */
  constructor(morphs = []) {
    this.morphs = morphs;
    this.byName = new Map(morphs.map((m, i) => [m.name, i]));
    /** @type {Map<number, number>} morph index -> weight (0..1, occasionally >1 for exaggerated poses) */
    this.weights = new Map();

    // apply() is called once per model every frame. Reusing these two
    // scratch collections (cleared, not reallocated) avoids a GC-churning
    // allocation per model per frame; _dirty additionally lets apply() skip
    // all work entirely on frames where no slider moved, which is the
    // common case — most frames, most models have unchanged expressions.
    this._accumPool = new Map();
    this._visitedPool = new Set();
    this._dirty = true;
  }

  setWeight(name, weight) {
    const idx = this.byName.get(name);
    if (idx === undefined) return false;
    if (this.weights.get(idx) !== weight) {
      this.weights.set(idx, weight);
      this._dirty = true;
    }
    return true;
  }

  getWeight(name) {
    const idx = this.byName.get(name);
    return idx === undefined ? 0 : (this.weights.get(idx) || 0);
  }

  resetAll() {
    if (this.weights.size > 0) this._dirty = true;
    this.weights.clear();
  }

  /** Morphs grouped by panel, in file order — exactly the four-tab layout a morph panel UI needs. */
  byPanel() {
    const panels = new Map([[MorphPanel.EYEBROW, []], [MorphPanel.EYE, []], [MorphPanel.MOUTH, []], [MorphPanel.OTHER, []]]);
    this.morphs.forEach((m, i) => {
      if (m.panel === MorphPanel.SYSTEM) return;
      (panels.get(m.panel) || panels.get(MorphPanel.OTHER)).push({ index: i, morph: m });
    });
    return panels;
  }

  /**
   * Resolves every active weight (including through group morphs, which
   * reference other morphs by index) down to a flat vertexIndex -> {dx,dy,dz}
   * accumulation map. Recursive, with a visited-set cycle guard since
   * nothing in the PMX spec forbids an author accidentally looping groups.
   */
  _accumulateVertexOffsets(morphIndex, weight, accum, visited) {
    if (weight === 0 || visited.has(morphIndex)) return;
    const morph = this.morphs[morphIndex];
    if (!morph) return;
    visited.add(morphIndex);

    if (morph.type === MorphType.VERTEX) {
      for (const { vertexIndex, dx, dy, dz } of morph.vertexOffsets) {
        const prev = accum.get(vertexIndex) || { dx: 0, dy: 0, dz: 0 };
        accum.set(vertexIndex, {
          dx: prev.dx + dx * weight,
          dy: prev.dy + dy * weight,
          dz: prev.dz + dz * weight,
        });
      }
    } else if (morph.type === MorphType.GROUP) {
      for (const member of morph.groupMembers) {
        this._accumulateVertexOffsets(member.morphIndex, weight * member.weight, accum, visited);
      }
    }
    // Other morph types don't contribute vertex offsets.

    visited.delete(morphIndex); // allow the same morph to be reached again via a sibling branch
  }

  /**
   * Applies every active weight on top of `baseVertices` (the mesh's rest-pose
   * positions) into `outPositions` (same length Float32Array, reused to avoid
   * per-frame allocation). Call this before skinning each frame.
   *
   * Skips all work when nothing changed since the last call (_dirty is false)
   * — `outPositions` already holds the correct result from last frame in
   * that case, since both buffers are the same reused arrays every call.
   */
  apply(baseVertices, outPositions) {
    if (!this._dirty) return outPositions;

    outPositions.set(baseVertices);
    if (this.weights.size === 0) { this._dirty = false; return outPositions; }

    const accum = this._accumPool;
    const visited = this._visitedPool;
    accum.clear();

    for (const [morphIndex, weight] of this.weights) {
      if (weight === 0) continue;
      visited.clear();
      this._accumulateVertexOffsets(morphIndex, weight, accum, visited);
    }

    for (const [vertexIndex, offset] of accum) {
      const base = vertexIndex * 3;
      outPositions[base] += offset.dx;
      outPositions[base + 1] += offset.dy;
      outPositions[base + 2] += offset.dz;
    }

    this._dirty = false;
    return outPositions;
  }
}
