/**
 * ShaderCore.js
 * Section 5 — toon/SPH texture pipeline and the fragment math fix for the
 * classic mobile symptom: toon ramps + sphere-map highlights desaturating
 * into flat gray/white under naive multiply blending.
 *
 * Root cause this solves: `baseColor * toonRamp * sphHighlight` with all
 * three terms in [0,1] compounds darkening/desaturation multiplicatively.
 * Fix: keep toon shading as a *tint* on diffuse luminance (not a raw
 * multiply), add SPH additively in linear space scaled by a highlight
 * strength, then re-apply saturation lost to the ramp before tonemapping.
 */

export const ToonSPH_GLSL_Fragment = /* glsl */ `
#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vNormalWS;
in vec3 vViewDirWS;

uniform sampler2D uBaseTex;
uniform sampler2D uToonTex;   // 1D-ish ramp sampled by N·L, MMD convention
uniform sampler2D uSphTex;    // sphere-mapped highlight/add texture
uniform int  uSphMode;        // 0 = off, 1 = multiply (.sph), 2 = add (.spa)
uniform vec3 uLightDirWS;
uniform vec3 uTintColor;      // material edge/tint color
uniform float uSaturationRestore; // 0..1, compensates ramp desaturation

vec3 restoreSaturation(vec3 color, float amount) {
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  return mix(vec3(luma), color, 1.0 + amount * 0.5);
}

void main() {
  vec3 base = texture(uBaseTex, vUv).rgb;

  float ndotl = clamp(dot(normalize(vNormalWS), normalize(uLightDirWS)) * 0.5 + 0.5, 0.0, 1.0);
  vec3 toon = texture(uToonTex, vec2(0.5, ndotl)).rgb;

  // Blend toon as a tint on top of base luminance instead of a flat multiply,
  // which is what crushes bright/white materials into gray.
  vec3 shaded = base * mix(vec3(1.0), toon, 0.65);

  // Sphere map UV from the view-space normal (matcap-style projection).
  vec3 n = normalize(vNormalWS);
  vec2 sphUv = n.xy * 0.5 + 0.5;
  vec3 sph = texture(uSphTex, sphUv).rgb;

  if (uSphMode == 1) {
    // .sph multiply: apply in a way that cannot drive luminance to zero.
    shaded = shaded * mix(vec3(1.0), sph, 0.5) + shaded * 0.25;
  } else if (uSphMode == 2) {
    // .spa add: pure additive highlight, unclamped until final tonemap.
    shaded += sph * 0.6;
  }

  shaded *= uTintColor;
  shaded = restoreSaturation(shaded, uSaturationRestore);

  // Simple Reinhard tonemap keeps additive SPH highlights from blowing out
  // while preserving the vibrance restored above.
  vec3 mapped = shaded / (shaded + vec3(1.0));
  mapped = pow(mapped, vec3(1.0 / 2.2)); // gamma

  fragColor = vec4(mapped, 1.0);
}
`;

/** WGSL mirror for the WebGPU path, same math. */
export const ToonSPH_WGSL_Fragment = /* wgsl */ `
struct Uniforms {
  lightDirWS: vec3<f32>,
  sphMode: i32,
  tintColor: vec3<f32>,
  saturationRestore: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var baseTex: texture_2d<f32>;
@group(0) @binding(2) var toonTex: texture_2d<f32>;
@group(0) @binding(3) var sphTex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

fn restoreSaturation(color: vec3<f32>, amount: f32) -> vec3<f32> {
  let luma = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  return mix(vec3<f32>(luma), color, 1.0 + amount * 0.5);
}

@fragment
fn fs_main(
  @location(0) vUv: vec2<f32>,
  @location(1) vNormalWS: vec3<f32>,
) -> @location(0) vec4<f32> {
  let base = textureSample(baseTex, samp, vUv).rgb;
  let ndotl = clamp(dot(normalize(vNormalWS), normalize(u.lightDirWS)) * 0.5 + 0.5, 0.0, 1.0);
  let toon = textureSample(toonTex, samp, vec2<f32>(0.5, ndotl)).rgb;

  var shaded = base * mix(vec3<f32>(1.0), toon, 0.65);

  let n = normalize(vNormalWS);
  let sphUv = n.xy * 0.5 + vec2<f32>(0.5);
  let sph = textureSample(sphTex, samp, sphUv).rgb;

  if (u.sphMode == 1) {
    shaded = shaded * mix(vec3<f32>(1.0), sph, 0.5) + shaded * 0.25;
  } else if (u.sphMode == 2) {
    shaded = shaded + sph * 0.6;
  }

  shaded = shaded * u.tintColor;
  shaded = restoreSaturation(shaded, u.saturationRestore);

  var mapped = shaded / (shaded + vec3<f32>(1.0));
  mapped = pow(mapped, vec3<f32>(1.0 / 2.2));

  return vec4<f32>(mapped, 1.0);
}
`;

/** Material-side texture slot bookkeeping, surfaced next to "Edit Textures" in the UI. */
export class MaterialTextureSlots {
  constructor() {
    this.baseTex = null;
    this.sphTex = null;   // .sph (multiply) or .spa (add)
    this.sphMode = 0;     // 0 off, 1 multiply, 2 add — set from file extension on assign
    this.toonTex = null;
    this.tintColor = [1, 1, 1];
    this.saturationRestore = 0.3; // tunable per-material fix amount
  }

  assignSph(path) {
    this.sphTex = path;
    this.sphMode = path.toLowerCase().endsWith('.spa') ? 2 : 1;
  }
}
