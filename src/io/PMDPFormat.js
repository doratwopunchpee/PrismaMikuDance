/**
 * PMDPFormat.js
 * Section 4 — the native ".pmdp" project format: a zip-compressed package
 * containing a clean `project.json` manifest plus local folder references
 * (never embeds raw model/motion bytes — it points back into
 * /PRISMAMD/Models /Motions so projects stay small and re-link live).
 *
 * Package layout:
 *   my_song.pmdp (zip)
 *    └─ project.json
 *
 * Compression uses any DEFLATE-capable zip lib injected as `zipCodec`
 * (e.g. fflate) so this module stays dependency-free at the source level.
 */

export const PMDP_SCHEMA_VERSION = 1;

export function serializeProject({ scene, timeline, camera, settings }) {
  const manifest = {
    schema: PMDP_SCHEMA_VERSION,
    createdWith: 'PRISMAMD',
    savedAt: new Date().toISOString(),

    settings: {
      fps: timeline.fps,
      lengthFrames: timeline.lengthFrames,
      resolution: settings.exportResolution, // '720p' | '1080p', see PerformanceController
      performanceFlags: settings.performanceFlags,
    },

    camera: {
      position: { ...camera.position },
      target: { ...camera.target },
      fovDeg: camera.fovDeg,
      trackId: camera.timelineTrackId,
    },

    // Local folder references only — paths resolve against /PRISMAMD/Models /Motions /Textures.
    models: scene.models.map(m => ({
      id: m.id,
      name: m.name,
      sourcePath: m.sourcePath,         // e.g. "/PRISMAMD/Models/miku.pmx"
      transform: {
        translation: { ...m.transform.translation },
        rotation: { ...m.transform.rotation },
        scale: { ...m.transform.scale },
      },
      timelineTrackId: m.timelineTrackId,
      visible: m.visible,
    })),

    tracks: Array.from(timeline.tracks.values()).map(track => ({
      targetId: track.targetId,
      label: track.label,
      keyframes: track.keyframes.map(kf => ({
        frame: kf.frame,
        translation: { ...kf.translation },
        rotation: { ...kf.rotation },
        scale: { ...kf.scale },
        handles: [kf.interpolatorOut.curve.x1, kf.interpolatorOut.curve.y1,
                  kf.interpolatorOut.curve.x2, kf.interpolatorOut.curve.y2],
      })),
    })),
  };

  return manifest;
}

export async function writePmdp(path, manifest, { zipCodec, fileSystem }) {
  const json = JSON.stringify(manifest, null, 2);
  const zipped = zipCodec.zipSync({ 'project.json': zipCodec.strToU8(json) });
  await fileSystem.writeAsset(path, zipped);
  return path;
}

export async function readPmdp(path, { zipCodec, fileSystem }) {
  const raw = await fileSystem.readAsset(path, { binary: true });
  const unzipped = zipCodec.unzipSync(raw);
  const json = zipCodec.strFromU8(unzipped['project.json']);
  const manifest = JSON.parse(json);

  if (manifest.schema > PMDP_SCHEMA_VERSION) {
    throw new Error(`.pmdp schema v${manifest.schema} is newer than this build supports (v${PMDP_SCHEMA_VERSION})`);
  }
  return manifest;
}

/**
 * Rehydrates a manifest into live SceneManager/Timeline objects.
 * Caller supplies the already-imported mesh/skeleton data per model
 * (fetched via ImportExport.importAsset against manifest.models[i].sourcePath).
 */
export function hydrateProject(manifest, { ModelInstance, Skeleton, Timeline, Vec3, Quat, loadedMeshesById }) {
  const timeline = new Timeline(manifest.settings.fps);
  timeline.lengthFrames = manifest.settings.lengthFrames;

  for (const t of manifest.tracks) {
    const track = timeline.getOrCreateTrack(t.targetId, t.label);
    for (const kf of t.keyframes) {
      track.insertKeyframe({
        frame: kf.frame,
        translation: new Vec3(kf.translation.x, kf.translation.y, kf.translation.z),
        rotation: new Quat(kf.rotation.x, kf.rotation.y, kf.rotation.z, kf.rotation.w),
        scale: new Vec3(kf.scale.x, kf.scale.y, kf.scale.z),
      });
    }
  }

  const models = manifest.models.map(m => {
    const loaded = loadedMeshesById.get(m.id); // { mesh, skeleton } pre-loaded from sourcePath
    const instance = new ModelInstance({ name: m.name, skeleton: loaded.skeleton, mesh: loaded.mesh });
    instance.sourcePath = m.sourcePath;
    instance.visible = m.visible;
    instance.timelineTrackId = m.timelineTrackId;
    instance.transform.translation = new Vec3(m.transform.translation.x, m.transform.translation.y, m.transform.translation.z);
    return instance;
  });

  return { models, timeline };
}
