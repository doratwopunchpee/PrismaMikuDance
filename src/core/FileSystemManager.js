/**
 * FileSystemManager.js
 * Section 1 — OS file subsystem, permission handling, and automated
 * directory bootstrap. Written against a generic native bridge
 * (`window.NativeFS`) so it stays portable across Capacitor/Tauri-mobile/
 * a custom WebView bridge — swap NativeFSAdapter's internals only.
 */

export const PRISMAMD_ROOT = '/PRISMAMD';
export const PRISMAMD_DIRS = Object.freeze([
  `${PRISMAMD_ROOT}/Models`,
  `${PRISMAMD_ROOT}/Motions`,
  `${PRISMAMD_ROOT}/Projects`,   // .pmdp packages
  `${PRISMAMD_ROOT}/Textures`,
  `${PRISMAMD_ROOT}/Exports`,
]);

/** Thin adapter around whatever native filesystem bridge the shell exposes. */
class NativeFSAdapter {
  constructor(bridge = globalThis.NativeFS) {
    if (!bridge) {
      throw new Error('NativeFS bridge missing — shell must inject window.NativeFS');
    }
    this.bridge = bridge;
  }

  requestPermission(scope) {
    // scope: 'read' | 'write' | 'readwrite'
    return this.bridge.requestPermission(scope);
  }

  mkdirp(path) {
    return this.bridge.mkdirp(path);
  }

  listDir(path) {
    return this.bridge.listDir(path); // -> [{name, path, size, mtime, isDir}]
  }

  watch(path, callback) {
    // Native layer should debounce OS-level fs events (inotify / FSEvents / Android MediaStore).
    return this.bridge.watch(path, callback);
  }

  readFile(path, { binary = true } = {}) {
    return this.bridge.readFile(path, binary);
  }

  writeFile(path, data) {
    return this.bridge.writeFile(path, data);
  }
}

export class FileSystemManager {
  constructor() {
    this.adapter = null;
    this.ready = false;
    /** @type {Map<string, Array<object>>} dir -> cached file entries */
    this.index = new Map();
    /** @type {Set<(dir:string, entries:object[]) => void>} */
    this._listeners = new Set();
  }

  /**
   * Step 1: request permission, then create the folder tree. Call once at launch.
   * The five managed directories are independent, so their mkdirp + initial
   * listDir calls run concurrently rather than one-await-at-a-time — each
   * native-bridge round trip has fixed overhead (more pronounced on Android/
   * iOS than on desktop), so five dirs sequentially was roughly 5x the
   * latency of a single round trip for no reason.
   */
  async initialize() {
    this.adapter = new NativeFSAdapter();

    const granted = await this.adapter.requestPermission('readwrite');
    if (!granted) {
      throw new Error('PRISMAMD requires storage permission to manage Models/Motions assets.');
    }

    await Promise.all(PRISMAMD_DIRS.map(dir => this.adapter.mkdirp(dir)));
    await this._rescanAll();
    this._hookLiveWatchers();

    this.ready = true;
    return true;
  }

  /** Lifecycle asset hooking: live-watch each managed dir for additions/removals. */
  _hookLiveWatchers() {
    for (const dir of PRISMAMD_DIRS) {
      this.adapter.watch(dir, async () => {
        const entries = await this.adapter.listDir(dir);
        this.index.set(dir, entries);
        this._emit(dir, entries);
      });
    }
  }

  async _rescanAll() {
    const results = await Promise.all(PRISMAMD_DIRS.map(dir => this.adapter.listDir(dir)));
    PRISMAMD_DIRS.forEach((dir, i) => this.index.set(dir, results[i]));
  }

  /** UI subscribes here to repopulate asset pickers the instant a file appears. */
  onAssetsChanged(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _emit(dir, entries) {
    for (const cb of this._listeners) cb(dir, entries);
  }

  listModels() {
    return (this.index.get(`${PRISMAMD_ROOT}/Models`) || [])
      .filter(f => /\.(pmd|pmx|fbx|x)$/i.test(f.name));
  }

  listMotions() {
    return (this.index.get(`${PRISMAMD_ROOT}/Motions`) || [])
      .filter(f => /\.(vmd|vpd)$/i.test(f.name));
  }

  listProjects() {
    return (this.index.get(`${PRISMAMD_ROOT}/Projects`) || [])
      .filter(f => /\.pmdp$/i.test(f.name));
  }

  async readAsset(path, opts) {
    return this.adapter.readFile(path, opts);
  }

  async writeAsset(path, data) {
    return this.adapter.writeFile(path, data);
  }
}

export const fileSystem = new FileSystemManager();
