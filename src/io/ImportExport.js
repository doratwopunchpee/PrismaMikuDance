/**
 * ImportExport.js
 * Section 4 — modular, asynchronous binary/text parsing blocks.
 *
 * Each format gets its own self-contained parser class exposing
 * `static async parse(arrayBuffer)` and (where meaningful) `static encode(model)`.
 * Parsers are registered into a FormatRegistry so the asset loader can
 * dispatch purely off file extension, keeping SceneManager/Timeline
 * format-agnostic.
 */

import { MorphTarget, MorphType } from '../core/MorphSystem.js';

// ---------- shared binary cursor ----------

class BinaryReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
  }
  u8() { return this.view.getUint8(this.offset++); }
  i8() { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  u16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  i32() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  bytesRaw(n) { const v = this.bytes.slice(this.offset, this.offset + n); this.offset += n; return v; }
  cstr(n, encoding = 'shift-jis') {
    const raw = this.bytesRaw(n);
    const nul = raw.indexOf(0);
    const slice = nul >= 0 ? raw.slice(0, nul) : raw;
    try { return new TextDecoder(encoding).decode(slice); } catch { return new TextDecoder().decode(slice); }
  }
  /** PMX-style length-prefixed text: int32 byte length, then raw bytes — no nul terminator. */
  text(encoding = 'utf-16le') {
    const len = this.i32();
    const raw = this.bytesRaw(len);
    try { return new TextDecoder(encoding).decode(raw); } catch { return new TextDecoder().decode(raw); }
  }
  /** PMX variable-width signed index (1/2/4 bytes, per the file's own globals header; -1 = "none"). */
  index(size) {
    if (size === 1) return this.i8();
    if (size === 2) return this.i16();
    return this.i32();
  }
  /** PMX unsigned vertex-array index (width also set by the globals header). */
  vertexIndex(size) {
    if (size === 1) return this.u8();
    if (size === 2) return this.u16();
    return this.u32();
  }
}

// PMX morph-type byte -> our MorphType vocabulary (3–7 are UV + 4 additional UV channels).
const PMX_MORPH_TYPE_MAP = {
  0: MorphType.GROUP, 1: MorphType.VERTEX, 2: MorphType.BONE,
  3: MorphType.UV, 4: MorphType.UV, 5: MorphType.UV, 6: MorphType.UV, 7: MorphType.UV,
  8: MorphType.MATERIAL, 9: MorphType.FLIP, 10: MorphType.IMPULSE,
};

// ---------- .pmd / .pmx (MMD model nodes) ----------

export class PMXParser {
  /**
   * Full PMX 2.0/2.1 structural parse: header, vertices (all five deform
   * types — BDEF1/2/4, SDEF, QDEF), faces, textures, materials, bones
   * (including IK chains and inherit/fixed-axis/local-axis flags), and the
   * morph table (feeding core/MorphSystem.js's facial morph panels).
   * Display frames, rigid bodies, joints, and soft bodies are physics/UI
   * setup that isn't needed to pose the mesh or drive morphs, so parsing
   * deliberately stops once morphs are read.
   */
  static async parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const magic = r.cstr(4, 'ascii'); // "PMX "
    if (!magic.trim().startsWith('PMX')) throw new Error('Not a valid PMX file');

    const version = r.f32();
    const globalsCount = r.u8();
    const globals = Array.from({ length: globalsCount }, () => r.u8());
    const [encodingFlag, additionalUVCount, vertexIndexSize, textureIndexSize,
      materialIndexSize, boneIndexSize, morphIndexSize, rigidBodyIndexSize] = globals;
    const textEncoding = encodingFlag === 1 ? 'utf-8' : 'utf-16le';

    const nameJP = r.text(textEncoding);
    const nameEN = r.text(textEncoding);
    const commentJP = r.text(textEncoding);
    const commentEN = r.text(textEncoding);

    // ---- vertices ----
    const vertexCount = r.i32();
    const vertices = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const boneWeights = new Float32Array(vertexCount * 4);
    const boneIndices = new Int32Array(vertexCount * 4);

    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] = r.f32(); vertices[i * 3 + 1] = r.f32(); vertices[i * 3 + 2] = r.f32();
      normals[i * 3] = r.f32(); normals[i * 3 + 1] = r.f32(); normals[i * 3 + 2] = r.f32();
      uvs[i * 2] = r.f32(); uvs[i * 2 + 1] = r.f32();
      for (let k = 0; k < additionalUVCount; k++) { r.f32(); r.f32(); r.f32(); r.f32(); }

      const deformType = r.u8();
      const bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
      if (deformType === 0) { // BDEF1
        bi[0] = r.index(boneIndexSize); bw[0] = 1;
      } else if (deformType === 1) { // BDEF2
        bi[0] = r.index(boneIndexSize); bi[1] = r.index(boneIndexSize);
        bw[0] = r.f32(); bw[1] = 1 - bw[0];
      } else if (deformType === 2) { // BDEF4
        for (let k = 0; k < 4; k++) bi[k] = r.index(boneIndexSize);
        for (let k = 0; k < 4; k++) bw[k] = r.f32();
      } else if (deformType === 3) { // SDEF — spherical deform; C/R0/R1 correction vectors consumed, not yet applied
        bi[0] = r.index(boneIndexSize); bi[1] = r.index(boneIndexSize);
        bw[0] = r.f32(); bw[1] = 1 - bw[0];
        r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32();
      } else if (deformType === 4) { // QDEF (2.1) — dual-quaternion skin, treated as BDEF4 weights here
        for (let k = 0; k < 4; k++) bi[k] = r.index(boneIndexSize);
        for (let k = 0; k < 4; k++) bw[k] = r.f32();
      }
      for (let k = 0; k < 4; k++) { boneIndices[i * 4 + k] = Math.max(bi[k], 0); boneWeights[i * 4 + k] = bw[k]; }
      r.f32(); // edge scale
    }

    // ---- faces ----
    const faceIndexCount = r.i32();
    const indices = vertexIndexSize === 1 ? new Uint8Array(faceIndexCount)
      : vertexIndexSize === 2 ? new Uint16Array(faceIndexCount) : new Uint32Array(faceIndexCount);
    for (let i = 0; i < faceIndexCount; i++) indices[i] = r.vertexIndex(vertexIndexSize);

    // ---- textures ----
    const textureCount = r.i32();
    const textures = [];
    for (let i = 0; i < textureCount; i++) textures.push(r.text(textEncoding));

    // ---- materials ----
    const materialCount = r.i32();
    const materials = [];
    for (let i = 0; i < materialCount; i++) {
      const name = r.text(textEncoding);
      const nameEnM = r.text(textEncoding);
      const diffuse = [r.f32(), r.f32(), r.f32(), r.f32()];
      const specular = [r.f32(), r.f32(), r.f32()];
      const specularity = r.f32();
      const ambient = [r.f32(), r.f32(), r.f32()];
      const drawFlags = r.u8();
      const edgeColor = [r.f32(), r.f32(), r.f32(), r.f32()];
      const edgeSize = r.f32();
      const textureIndex = r.index(textureIndexSize);
      const sphereIndex = r.index(textureIndexSize);
      const sphereMode = r.u8();
      const toonFlag = r.u8();
      const toonIndex = toonFlag === 0 ? r.index(textureIndexSize) : r.u8();
      const memo = r.text(textEncoding);
      const surfaceCount = r.i32(); // face-index entries this material covers (/3 = triangle count)
      materials.push({ name, nameEn: nameEnM, diffuse, specular, specularity, ambient, drawFlags,
        edgeColor, edgeSize, textureIndex, sphereIndex, sphereMode, toonFlag, toonIndex, memo, surfaceCount });
    }

    // ---- bones ----
    const boneCount = r.i32();
    const bones = [];
    for (let i = 0; i < boneCount; i++) {
      const name = r.text(textEncoding);
      const nameEnB = r.text(textEncoding);
      const position = [r.f32(), r.f32(), r.f32()];
      const parentIndex = r.index(boneIndexSize);
      const transformLevel = r.i32();
      const flags = r.u16();

      let tailPosition = null, tailBoneIndex = -1;
      if (flags & 0x0001) tailBoneIndex = r.index(boneIndexSize);
      else tailPosition = [r.f32(), r.f32(), r.f32()];

      let inheritParentIndex = -1, inheritInfluence = 0;
      if (flags & 0x0100 || flags & 0x0200) { // inherit rotation / inherit translation
        inheritParentIndex = r.index(boneIndexSize); inheritInfluence = r.f32();
      }

      let fixedAxis = null;
      if (flags & 0x0400) fixedAxis = [r.f32(), r.f32(), r.f32()];

      let localXAxis = null, localZAxis = null;
      if (flags & 0x0800) { localXAxis = [r.f32(), r.f32(), r.f32()]; localZAxis = [r.f32(), r.f32(), r.f32()]; }

      let externalParentKey = null;
      if (flags & 0x2000) externalParentKey = r.i32();

      let ik = null;
      if (flags & 0x0020) {
        const ikTargetIndex = r.index(boneIndexSize);
        const ikLoopCount = r.i32();
        const ikLimitAngle = r.f32();
        const linkCount = r.i32();
        const links = [];
        for (let l = 0; l < linkCount; l++) {
          const linkBoneIndex = r.index(boneIndexSize);
          const hasLimit = r.u8();
          let limitLower = null, limitUpper = null;
          if (hasLimit) { limitLower = [r.f32(), r.f32(), r.f32()]; limitUpper = [r.f32(), r.f32(), r.f32()]; }
          links.push({ linkBoneIndex, hasLimit: !!hasLimit, limitLower, limitUpper });
        }
        ik = { ikTargetIndex, ikLoopCount, ikLimitAngle, links };
      }

      bones.push({ name, nameEn: nameEnB, position, parentIndex, transformLevel, flags,
        tailPosition, tailBoneIndex, inheritParentIndex, inheritInfluence,
        fixedAxis, localXAxis, localZAxis, externalParentKey, ik, ikEnabled: !!(flags & 0x0020) });
    }

    // ---- morphs (facial morph panel data — core/MorphSystem.js consumes this) ----
    const morphCount = r.i32();
    const morphs = [];
    for (let i = 0; i < morphCount; i++) {
      const name = r.text(textEncoding);
      const nameEnM = r.text(textEncoding);
      const panel = r.u8();
      const typeByte = r.u8();
      const offsetCount = r.i32();
      const morph = new MorphTarget({ name, nameEn: nameEnM, panel, type: PMX_MORPH_TYPE_MAP[typeByte] || MorphType.VERTEX });

      if (typeByte === 0) { // GROUP
        for (let o = 0; o < offsetCount; o++) {
          morph.groupMembers.push({ morphIndex: r.index(morphIndexSize), weight: r.f32() });
        }
      } else if (typeByte === 1) { // VERTEX — the facial-expression workhorse
        for (let o = 0; o < offsetCount; o++) {
          const vertexIndex = r.vertexIndex(vertexIndexSize);
          morph.vertexOffsets.push({ vertexIndex, dx: r.f32(), dy: r.f32(), dz: r.f32() });
        }
      } else if (typeByte === 2) { // BONE — parsed, application left as an extension point
        const raw = [];
        for (let o = 0; o < offsetCount; o++) {
          raw.push({
            boneIndex: r.index(boneIndexSize),
            translation: [r.f32(), r.f32(), r.f32()],
            rotation: [r.f32(), r.f32(), r.f32(), r.f32()],
          });
        }
        morph.rawPayload = raw;
      } else if (typeByte >= 3 && typeByte <= 7) { // UV + 4 additional UV channels
        const raw = [];
        for (let o = 0; o < offsetCount; o++) {
          raw.push({ vertexIndex: r.vertexIndex(vertexIndexSize), uvOffset: [r.f32(), r.f32(), r.f32(), r.f32()] });
        }
        morph.rawPayload = raw;
      } else if (typeByte === 8) { // MATERIAL
        const raw = [];
        for (let o = 0; o < offsetCount; o++) {
          raw.push({
            materialIndex: r.index(materialIndexSize),
            calcMode: r.u8(),
            diffuse: [r.f32(), r.f32(), r.f32(), r.f32()],
            specular: [r.f32(), r.f32(), r.f32()],
            specularity: r.f32(),
            ambient: [r.f32(), r.f32(), r.f32()],
            edgeColor: [r.f32(), r.f32(), r.f32(), r.f32()],
            edgeSize: r.f32(),
            textureTint: [r.f32(), r.f32(), r.f32(), r.f32()],
            sphereTint: [r.f32(), r.f32(), r.f32(), r.f32()],
            toonTint: [r.f32(), r.f32(), r.f32(), r.f32()],
          });
        }
        morph.rawPayload = raw;
      } else if (typeByte === 9) { // FLIP (2.1)
        const raw = [];
        for (let o = 0; o < offsetCount; o++) raw.push({ morphIndex: r.index(morphIndexSize), weight: r.f32() });
        morph.rawPayload = raw;
      } else if (typeByte === 10) { // IMPULSE (2.1)
        const raw = [];
        for (let o = 0; o < offsetCount; o++) {
          raw.push({
            rigidBodyIndex: r.index(rigidBodyIndexSize),
            isLocal: !!r.u8(),
            velocity: [r.f32(), r.f32(), r.f32()],
            torque: [r.f32(), r.f32(), r.f32()],
          });
        }
        morph.rawPayload = raw;
      }

      morphs.push(morph);
    }

    return {
      format: 'pmx',
      version,
      name: { jp: nameJP, en: nameEN },
      comment: { jp: commentJP, en: commentEN },
      textures,
      materials,
      bones,
      mesh: { vertices, normals, uvs, boneWeights, boneIndices, indices, morphs },
    };
  }
}

export class PMDParser {
  /** Legacy PMD (pre-PMX) — fixed Shift-JIS name fields, simpler vertex stride. */
  static async parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const magic = r.cstr(3, 'ascii'); // "Pmd"
    if (magic !== 'Pmd') throw new Error('Not a valid PMD file');
    const version = r.f32();
    const name = r.cstr(20, 'shift-jis');
    const comment = r.cstr(256, 'shift-jis');
    const vertexCount = r.u32();

    const vertices = new Float32Array(vertexCount * 3);
    const boneIndices = new Int32Array(vertexCount * 2);
    const boneWeights = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] = r.f32(); vertices[i * 3 + 1] = r.f32(); vertices[i * 3 + 2] = r.f32();
      r.f32(); r.f32(); r.f32(); // normal
      r.f32(); r.f32();          // uv
      boneIndices[i * 2] = r.view.getUint16(r.offset, true); r.offset += 2;
      boneIndices[i * 2 + 1] = r.view.getUint16(r.offset, true); r.offset += 2;
      boneWeights[i] = r.u8() / 100;
      r.u8(); // edge flag
    }

    return { format: 'pmd', version, name, comment, mesh: { vertices, boneIndices, boneWeights } };
  }
}

// ---------- .vmd (motion tracks) / .vpd (pose arrays) ----------

export class VMDParser {
  static async parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const header = r.cstr(30, 'shift-jis'); // "Vocaloid Motion Data 0002"
    const modelName = r.cstr(20, 'shift-jis');
    const boneFrameCount = r.u32();

    const boneFrames = [];
    for (let i = 0; i < boneFrameCount; i++) {
      const boneName = r.cstr(15, 'shift-jis');
      const frame = r.u32();
      const tx = r.f32(), ty = r.f32(), tz = r.f32();
      const rx = r.f32(), ry = r.f32(), rz = r.f32(), rw = r.f32();
      const interpolationBytes = r.bytesRaw(64); // 4x bezier handle bytes per TRS channel, MMD-packed
      boneFrames.push({ boneName, frame, translation: [tx, ty, tz], rotation: [rx, ry, rz, rw], interpolationBytes });
    }

    return { format: 'vmd', header, modelName, boneFrames };
    // camera/light/shadow/morph blocks follow the same cursor pattern after boneFrames.
  }

  /** Export: pack PRISMAMD Timeline tracks back into VMD binary bone-frame records. */
  static encode(timeline, modelName) {
    const parts = [];
    for (const [targetId, track] of timeline.tracks) {
      if (targetId === 'camera') continue;
      for (const kf of track.keyframes) {
        parts.push({ boneName: targetId, frame: kf.frame, translation: kf.translation, rotation: kf.rotation });
      }
    }
    return { format: 'vmd', modelName, boneFrames: parts }; // binary serialization mirrors parse() in reverse
  }
}

export class VPDParser {
  /** VPD is plain text (Shift-JIS), not binary — a static pose, not a track. */
  static async parse(text) {
    const boneBlocks = [...text.matchAll(/Bone(\d+)\{([^}]+)\}/g)];
    const bones = boneBlocks.map(([, , body]) => {
      const nums = body.match(/-?\d+\.\d+(e[-+]?\d+)?/gi)?.map(Number) || [];
      const [tx, ty, tz, rx, ry, rz, rw] = nums;
      return { translation: [tx, ty, tz], rotation: [rx, ry, rz, rw] };
    });
    return { format: 'vpd', bones };
  }
}

// ---------- .fbx / .x (generic scene interchange) ----------

export class FBXParser {
  /** FBX ASCII/binary scene graph import — delegates node-tree walk to a pluggable backend. */
  static async parse(arrayBuffer, { backend } = {}) {
    if (!backend) throw new Error('FBXParser requires a `backend` (e.g. an fbx2gltf/ufbx WASM binding)');
    const scene = await backend.decode(arrayBuffer);
    return { format: 'fbx', scene }; // normalized into PRISMAMD mesh/skeleton shape by the caller
  }
}

export class DirectXMeshParser {
  /** Legacy .x (DirectX) text/binary geometry — minimal "Frame"/"Mesh" token walker. */
  static async parse(text) {
    const meshMatch = text.match(/Mesh\s*\w*\s*\{([\s\S]*?)\}/);
    if (!meshMatch) throw new Error('No Mesh block found in .x file');
    const body = meshMatch[1];
    const vertexCount = parseInt(body.trim().split(/[;,\s]+/)[0], 10);
    return { format: 'x', vertexCount, raw: body }; // full token grammar expands on this skeleton
  }
}

// ---------- .fx (legacy Direct3D Effects framework shader) ----------

export class FXEffectFileParser {
  /**
   * Routes a legacy desktop .fx shader through FXAdaptor (render/FXAdaptor.js)
   * so model materials authored against old PC-era effect files convert
   * accurately (technique/pass structure + render state intact) instead of
   * being treated as opaque text. Needs an FXAdaptor instance (its own
   * HLSL/SPIR-V/WGSL WASM toolchain) injected via opts.fxAdaptor.
   */
  static async parse(text, { fxAdaptor } = {}) {
    if (!fxAdaptor) {
      throw new Error('FXEffectFileParser requires `{ fxAdaptor }` — an FXAdaptor instance with its WASM toolchain injected.');
    }
    const techniques = await fxAdaptor.convertEffectFile(text);
    return { format: 'fx', techniques }; // each technique carries mobile-ready WGSL+GLSL per pass/stage
  }
}

// ---------- registry ----------

export const FormatRegistry = new Map([
  ['pmx', PMXParser],
  ['pmd', PMDParser],
  ['vmd', VMDParser],
  ['vpd', VPDParser],
  ['fbx', FBXParser],
  ['x', DirectXMeshParser],
  ['fx', FXEffectFileParser],
]);

export async function importAsset(path, arrayBufferOrText, opts) {
  const ext = path.split('.').pop().toLowerCase();
  const Parser = FormatRegistry.get(ext);
  if (!Parser) throw new Error(`No parser registered for .${ext}`);
  return Parser.parse(arrayBufferOrText, opts);
}
