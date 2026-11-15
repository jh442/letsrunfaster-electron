'use strict';

/**
 * Preload: the only bridge between the renderer and the OS.
 *
 * The renderer is the engine's own web UI, so this surface stays tiny on
 * purpose -- folder selection, version info, and nothing that could read
 * files or start processes. `ui/src/platform.js` in the engine repo is the
 * renderer-side counterpart.
 */

const { contextBridge, ipcRenderer } = require('electron');

let info = {};
try {
  info = ipcRenderer.sendSync('app:info') || {};
} catch {
  info = {};
}

contextBridge.exposeInMainWorld('lrfDesktop', {
  isDesktop: true,
  appVersion: info.version || null,
  logDir: info.logDir || null,
  engine: {
    url: info.engineUrl || null,
    version: info.engineVersion || null,
  },

  /**
   * Native folder picker. Resolves to an absolute path, or null if cancelled.
   * @param {{ title?: string, defaultPath?: string }} options
   * @returns {Promise<string | null>}
   */
  pickDirectory(options = {}) {
    return ipcRenderer.invoke('dialog:pick-directory', {
      title: typeof options.title === 'string' ? options.title : undefined,
      defaultPath: typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
    });
  },
});
