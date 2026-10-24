/**
 * CapacitorFSBridge.js
 * Implements the `window.NativeFS` contract that core/FileSystemManager.js
 * expects, backed by @capacitor/filesystem — this is the concrete
 * Android/iOS storage-permission + sandbox bridge for section 1.
 *
 * Call installCapacitorFSBridge() once, before FileSystemManager.initialize(),
 * from src/main.js.
 */

import { Filesystem, Directory } from '@capacitor/filesystem';

// All PRISMAMD paths are rooted under the app's own Documents directory —
// no broad external-storage permission is requested, matching current
// Android scoped-storage / iOS sandbox rules.
const BASE_DIR = Directory.Documents;

function toRelative(path) {
  // FileSystemManager works with absolute-looking paths like "/PRISMAMD/Models";
  // Capacitor wants paths relative to BASE_DIR.
  return path.replace(/^\/+/, '');
}

class CapacitorFSBridge {
  async requestPermission(scope) {
    // @capacitor/filesystem requests permission implicitly on first read/write
    // on iOS; on Android with scoped storage under Documents it needs none.
    // This explicit call surfaces the system prompt up front so the app's
    // "automated storage" step (section 1) has a real yes/no to act on.
    try {
      const status = await Filesystem.checkPermissions();
      if (status.publicStorage === 'granted') return true;
      const req = await Filesystem.requestPermissions();
      return req.publicStorage === 'granted' || req.publicStorage === undefined; // undefined = platform doesn't gate this dir
    } catch {
      // Some platforms/versions don't expose checkPermissions for app-sandboxed dirs — treat as granted.
      return true;
    }
  }

  async mkdirp(path) {
    try {
      await Filesystem.mkdir({ path: toRelative(path), directory: BASE_DIR, recursive: true });
    } catch (err) {
      if (!String(err?.message).includes('exists')) throw err;
    }
  }

  async listDir(path) {
    const { files } = await Filesystem.readdir({ path: toRelative(path), directory: BASE_DIR });
    return files.map(f => ({
      name: f.name,
      path: `${path.replace(/\/$/, '')}/${f.name}`,
      size: f.size ?? 0,
      mtime: f.mtime ?? 0,
      isDir: f.type === 'directory',
    }));
  }

  /**
   * Capacitor has no native directory-watch API, so this polls on an
   * interval and diffs against the last listing — good enough for a
   * "drop a file in Models/ and see it in the picker" workflow.
   */
  watch(path, callback, intervalMs = 2000) {
    let lastSnapshot = '';
    const timer = setInterval(async () => {
      try {
        const entries = await this.listDir(path);
        const snapshot = JSON.stringify(entries.map(e => [e.name, e.size, e.mtime]));
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          callback(entries);
        }
      } catch {
        /* directory may not exist yet on first tick; ignore and retry */
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }

  async readFile(path, binary = true) {
    const result = await Filesystem.readFile({ path: toRelative(path), directory: BASE_DIR });
    if (!binary) return result.data; // already a string for text encodings
    const binaryStr = atob(result.data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes.buffer;
  }

  async writeFile(path, data) {
    let base64;
    if (typeof data === 'string') {
      base64 = btoa(data);
    } else {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      let binaryStr = '';
      for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
      base64 = btoa(binaryStr);
    }
    await Filesystem.writeFile({ path: toRelative(path), directory: BASE_DIR, data: base64, recursive: true });
  }
}

export function installCapacitorFSBridge() {
  globalThis.NativeFS = new CapacitorFSBridge();
}
