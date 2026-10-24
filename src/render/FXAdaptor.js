/**
 * FXAdaptor.js
 * Section 5 — Desktop FX adaptor strategy: an async WASM/JS compilation
 * stack that reads legacy desktop DirectX .fx (HLSL Effects framework)
 * shader scripts and safely converts them into mobile-compliant
 * GLSL ES 3.0 / WGSL — a genuine Direct3D .fx converter, not a generic
 * HLSL passthrough, so old PC-era model shaders come across accurately.
 *
 * .fx is not raw HLSL: it's the Effects-framework *container* format
 * (technique/pass blocks, SetVertexShader/PixelShader bindings, fixed-
 * function render state assignments like AlphaBlendEnable/CullMode) wrapped
 * around one or more HLSL functions. Two dialects exist in the wild and
 * both are parsed here:
 *   - D3D9-era:   `PixelShader = compile ps_2_0 PS_Main();`
 *   - D3D10/11-era (FX11): `SetPixelShader(CompileShader(ps_4_0, PS_Main()));`
 *
 * Pipeline per discovered shader stage:
 *   HLSL function body --[DXC/glslang WASM]--> SPIR-V
 *                       --[naga WASM]--------> WGSL  (WebGPU path)
 *                       --[SPIRV-Cross WASM]-> GLSL ES 3.0 (WebGL2 path)
 *
 * This module only orchestrates the stack and defines the safety gate —
 * actual codegen is delegated to injected WASM bindings so the core app
 * bundle stays small and these heavy tools load on demand.
 */

export class FXCompileError extends Error {
  constructor(stage, message) {
    super(`[FXAdaptor:${stage}] ${message}`);
    this.stage = stage;
  }
}

/**
 * @typedef {object} FXToolchain
 * @property {(hlslSrc:string, profile:string) => Promise<Uint8Array>} compileHlslToSpirv  // DXC/glslang
 * @property {(spirv:Uint8Array) => Promise<string>} spirvToWgsl                            // naga
 * @property {(spirv:Uint8Array) => Promise<string>} spirvToGlslEs3                          // SPIRV-Cross
 */

const MOBILE_UNSUPPORTED_HLSL_FEATURES = [
  /\btessellation\b/i,
  /\bgeometry\s+shader\b/i,
  /\bDiscardAndEndMeshShader\b/,
  /\bRayPayload\b/,
];

// ---------- Direct3D render-state → WebGL/WebGPU mapping ----------

/** Fixed-function state names as they appear inside a D3D9 pass{} block. */
const D3D9_BOOL_STATES = new Set(['ZEnable', 'ZWriteEnable', 'AlphaBlendEnable', 'AlphaTestEnable', 'ScissorTestEnable']);

const CULL_MODE_MAP = Object.freeze({
  NONE: 'none',       // D3DCULL_NONE
  CW: 'front',         // D3DCULL_CW   -> GL front-face culling equivalent after winding flip
  CCW: 'back',          // D3DCULL_CCW  -> GL default
});

const BLEND_MAP = Object.freeze({
  ZERO: 'zero', ONE: 'one',
  SRCALPHA: 'src-alpha', INVSRCALPHA: 'one-minus-src-alpha',
  DESTALPHA: 'dst-alpha', INVDESTALPHA: 'one-minus-dst-alpha',
  SRCCOLOR: 'src', INVSRCCOLOR: 'one-minus-src',
  DESTCOLOR: 'dst', INVDESTCOLOR: 'one-minus-dst',
});

/** Normalizes legacy D3D fixed-function state assignments into a renderer-agnostic descriptor. */
export class RenderStateMapper {
  static mapAssignment(key, value, out) {
    const k = key.trim();
    const v = value.trim().replace(/;$/, '');

    if (D3D9_BOOL_STATES.has(k)) {
      out[k[0].toLowerCase() + k.slice(1)] = /^(true|1)$/i.test(v);
      return;
    }
    if (/^CullMode$/i.test(k)) {
      const mode = v.replace(/^D3DCULL_/i, '').toUpperCase();
      out.cullMode = CULL_MODE_MAP[mode] ?? 'back';
      return;
    }
    if (/^(SrcBlend|DestBlend)$/i.test(k)) {
      const blendKey = v.replace(/^D3DBLEND_/i, '').toUpperCase();
      out[k[0].toLowerCase() + k.slice(1)] = BLEND_MAP[blendKey] ?? 'one';
      return;
    }
    // Any state this mapper doesn't recognize is preserved verbatim for diagnostics
    // rather than silently dropped — surfaced in EffectPass.unmappedStates.
    out.unmapped = out.unmapped || {};
    out.unmapped[k] = v;
  }
}

// ---------- .fx technique/pass structural parser ----------

/** One compiled stage reference extracted from a pass block (either .fx dialect). */
class ShaderStageRef {
  constructor(stage, profile, entryPoint) {
    this.stage = stage;           // 'vertex' | 'pixel' | 'geometry' | 'hull' | 'domain'
    this.profile = profile;       // e.g. 'vs_3_0', 'ps_4_0'
    this.entryPoint = entryPoint; // HLSL function name, e.g. 'VS_Main'
  }
}

class EffectPass {
  constructor(name) {
    this.name = name;
    /** @type {ShaderStageRef[]} */
    this.stages = [];
    this.renderState = {};
  }
}

class EffectTechnique {
  constructor(name) {
    this.name = name;
    /** @type {EffectPass[]} */
    this.passes = [];
  }
}

const STAGE_BY_PROFILE_PREFIX = Object.freeze({ vs: 'vertex', ps: 'pixel', gs: 'geometry', hs: 'hull', ds: 'domain' });

/**
 * Parses the Effects-framework shell around the HLSL: global code block,
 * technique/pass structure, and per-pass shader-stage bindings in both the
 * legacy D3D9 (`PixelShader = compile ps_2_0 Fn();`) and FX11
 * (`SetPixelShader(CompileShader(ps_4_0, Fn()));`) dialects.
 */
export class EffectFileParser {
  static parse(fxSource) {
    const techniqueBlocks = [...fxSource.matchAll(/technique\d*\s+(\w+)\s*\{([\s\S]*?)\n\}/g)];

    // Everything outside technique{} blocks is the shared HLSL (structs, cbuffers, functions).
    const globalHlsl = fxSource.replace(/technique\d*\s+\w+\s*\{[\s\S]*?\n\}/g, '').trim();

    const techniques = techniqueBlocks.map(([, techName, body]) => {
      const technique = new EffectTechnique(techName);
      const passBlocks = [...body.matchAll(/pass\s+(\w+)\s*\{([\s\S]*?)\}/g)];

      for (const [, passName, passBody] of passBlocks) {
        const pass = new EffectPass(passName);

        // D3D9 dialect: `VertexShader = compile vs_3_0 VS_Main();`
        for (const m of passBody.matchAll(/(VertexShader|PixelShader|GeometryShader)\s*=\s*compile\s+(\w+)\s+(\w+)\s*\([^)]*\)\s*;/g)) {
          const [, , profile, entry] = m;
          const stage = STAGE_BY_PROFILE_PREFIX[profile.split('_')[0].toLowerCase()] || 'pixel';
          pass.stages.push(new ShaderStageRef(stage, profile, entry));
        }

        // FX11 dialect: `SetPixelShader(CompileShader(ps_4_0, PS_Main()));`
        for (const m of passBody.matchAll(/Set(VertexShader|PixelShader|GeometryShader|HullShader|DomainShader)\s*\(\s*CompileShader\s*\(\s*(\w+)\s*,\s*(\w+)\s*\([^)]*\)\s*\)\s*\)\s*;/g)) {
          const [, , profile, entry] = m;
          const stage = STAGE_BY_PROFILE_PREFIX[profile.split('_')[0].toLowerCase()] || 'pixel';
          pass.stages.push(new ShaderStageRef(stage, profile, entry));
        }

        // Fixed-function render state assignments, e.g. `AlphaBlendEnable = true;` / `CullMode = D3DCULL_CCW;`
        for (const m of passBody.matchAll(/(\w+)\s*=\s*([^;]+);/g)) {
          const [, key, value] = m;
          if (/^(Set\w+|VertexShader|PixelShader|GeometryShader)$/.test(key)) continue; // already handled above
          RenderStateMapper.mapAssignment(key, value, pass.renderState);
        }

        technique.passes.push(pass);
      }
      return technique;
    });

    return { globalHlsl, techniques };
  }

  /** Pulls one named HLSL function body out of the shared global block, for per-stage compilation. */
  static extractFunctionSource(globalHlsl, entryPoint) {
    const re = new RegExp(`[\\w<>\\[\\]]+\\s+${entryPoint}\\s*\\([^)]*\\)\\s*(?::\\s*\\w+\\s*)?\\{`);
    const match = globalHlsl.match(re);
    if (!match) throw new FXCompileError('extract', `Entry point "${entryPoint}" not found in effect source.`);

    let i = match.index + match[0].length;
    let depth = 1;
    const start = match.index;
    while (depth > 0 && i < globalHlsl.length) {
      if (globalHlsl[i] === '{') depth++;
      else if (globalHlsl[i] === '}') depth--;
      i++;
    }
    return globalHlsl.slice(start, i);
  }
}

// ---------- orchestrator ----------

export class FXAdaptor {
  /** @param {FXToolchain} toolchain */
  constructor(toolchain) {
    if (!toolchain) throw new Error('FXAdaptor requires an injected FXToolchain (DXC/naga/SPIRV-Cross WASM bindings)');
    this.toolchain = toolchain;
    /** @type {Map<string, {wgsl:string, glsl:string}>} source hash -> compiled outputs, avoids recompiling every launch */
    this.cache = new Map();
  }

  _preflight(hlslSrc) {
    const hit = MOBILE_UNSUPPORTED_HLSL_FEATURES.find(re => re.test(hlslSrc));
    if (hit) {
      throw new FXCompileError('preflight', `Source uses a desktop-only feature (${hit}) with no mobile-compliant equivalent.`);
    }
  }

  _hash(src) {
    // Cheap non-cryptographic hash is sufficient for a cache key here.
    let h = 0;
    for (let i = 0; i < src.length; i++) { h = (Math.imul(31, h) + src.charCodeAt(i)) | 0; }
    return h.toString(36);
  }

  /**
   * Full pipeline: validate -> HLSL -> SPIR-V -> {WGSL, GLSL ES3}.
   * Returns both targets so the renderer can pick WebGPU or WebGL2 at runtime.
   */
  async convert(hlslSrc, { entryPoint = 'main', profile = 'ps_5_0' } = {}) {
    const key = this._hash(hlslSrc + entryPoint + profile);
    if (this.cache.has(key)) return this.cache.get(key);

    this._preflight(hlslSrc);

    let spirv;
    try {
      spirv = await this.toolchain.compileHlslToSpirv(hlslSrc, profile);
    } catch (err) {
      throw new FXCompileError('hlsl->spirv', err.message);
    }

    const [wgsl, glsl] = await Promise.all([
      this.toolchain.spirvToWgsl(spirv).catch(err => { throw new FXCompileError('spirv->wgsl', err.message); }),
      this.toolchain.spirvToGlslEs3(spirv).catch(err => { throw new FXCompileError('spirv->glsl', err.message); }),
    ]);

    const result = { wgsl, glsl };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Full-file entry point: parse the .fx technique/pass container, pull each
   * referenced HLSL stage function, run it through `convert()`, and return a
   * mobile-ready pass list with render state carried over from the original
   * D3D fixed-function assignments (CullMode, AlphaBlendEnable, SrcBlend/
   * DestBlend, ZWriteEnable, …).
   *
   * @param {string} fxSource  raw text contents of the .fx file
   * @returns {Promise<{techniqueName:string, passes: object[]}[]>}
   */
  async convertEffectFile(fxSource) {
    const { globalHlsl, techniques } = EffectFileParser.parse(fxSource);
    if (techniques.length === 0) {
      throw new FXCompileError('parse', 'No technique{} blocks found — not a valid Effects-framework .fx file.');
    }

    const out = [];
    for (const technique of techniques) {
      const passesOut = [];
      for (const pass of technique.passes) {
        const stagesOut = [];
        for (const stageRef of pass.stages) {
          const fnSource = EffectFileParser.extractFunctionSource(globalHlsl, stageRef.entryPoint);
          // Stage functions reference shared structs/cbuffers declared earlier in globalHlsl,
          // so each stage still compiles against the full shared header + its own body.
          const compileUnit = `${globalHlsl.split(fnSource)[0]}\n${fnSource}`;
          const compiled = await this.convert(compileUnit, { entryPoint: stageRef.entryPoint, profile: stageRef.profile });
          stagesOut.push({ stage: stageRef.stage, entryPoint: stageRef.entryPoint, sourceProfile: stageRef.profile, ...compiled });
        }
        passesOut.push({ name: pass.name, stages: stagesOut, renderState: pass.renderState });
      }
      out.push({ techniqueName: technique.name, passes: passesOut });
    }
    return out;
  }
}
