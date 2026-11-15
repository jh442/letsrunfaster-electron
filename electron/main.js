'use strict';

/**
 * Electron main process.
 *
 * Responsibilities: own the engine process, harden the renderer, and present
 * one native window. There is no UI code here -- the window loads the
 * engine's own server, so the browser and desktop builds can never drift.
 */

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { Engine, resolveEngineBinary } = require('./engine');
const crashReport = require('./crash');

const APP_ROOT = path.join(__dirname, '..');
const SPLASH_FILE = path.join(__dirname, 'splash.html');
const START_ATTEMPTS = 3;

const DATA_DIR = app.getPath('userData');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

/** The renderer is only trusted at the local engine origin. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // The progress bar is driven by an inline style attribute.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

let mainWindow = null;
let engine = null;
let engineOrigin = null;
let shuttingDown = false;

app.setAppUserModelId('com.letsrunfaster.ingestor');

// The UI is dark-only. Forcing the theme keeps the *native* window chrome
// (title bar, traffic lights) dark on Windows and macOS instead of picking up
// a light OS theme. Linux window decorations belong to the window manager and
// cannot be styled from here.
nativeTheme.themeSource = 'dark';

/* -------------------------------------------------------------------------- *
 * Window state
 * -------------------------------------------------------------------------- */

function readWindowState() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
  if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return {};

  // Drop coordinates that no longer land on an attached display (a monitor
  // was unplugged), otherwise the window opens off-screen and looks broken.
  const onScreen =
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    screen.getAllDisplays().some(({ workArea: area }) =>
      saved.x < area.x + area.width - 80 &&
      saved.x + saved.width > area.x + 80 &&
      saved.y < area.y + area.height - 80 &&
      saved.y + saved.height > area.y + 80,
    );
  return onScreen
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { width: saved.width, height: saved.height };
}

function saveWindowState(window) {
  try {
    const bounds = window.getNormalBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(bounds, null, 2));
  } catch {
    /* state is a convenience, never a failure */
  }
}

/* -------------------------------------------------------------------------- *
 * Window
 * -------------------------------------------------------------------------- */

function createWindow() {
  const state = readWindowState();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1280,
    height: state.height || 860,
    minWidth: 1024,
    minHeight: 700,
    // Matches the page background so the first paint never flashes white.
    backgroundColor: '#0b0e14',
    title: 'LetsRunFaster Ingestor',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Cheap and instant: a dark splash beats a blank window while the engine
  // unpacks its one-file bundle on first launch.
  mainWindow.loadFile(SPLASH_FILE);
}

/* -------------------------------------------------------------------------- *
 * Engine lifecycle
 * -------------------------------------------------------------------------- */

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { cache: 'no-store' });
      if (res.ok) return res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Engine did not answer /api/health: ${lastError?.message || 'timeout'}`);
}

async function startEngine() {
  const binary = resolveEngineBinary({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: APP_ROOT,
  });

  engine = new Engine({
    binary,
    dataDir: DATA_DIR,
    logDir: LOG_DIR,
    onUnexpectedExit: (detail) => handleEngineCrash(detail),
  });

  const info = await engine.start();
  engineOrigin = `http://127.0.0.1:${info.port}`;
  await waitForHealth(engineOrigin);
  app.setAboutPanelOptions({
    applicationName: 'LetsRunFaster Ingestor',
    applicationVersion: app.getVersion(),
    version: `engine ${info.version || 'unknown'}`,
    website: 'https://www.letsrunfaster.com',
  });
  if (mainWindow) await mainWindow.loadURL(`${engineOrigin}/`);
}

/** The default export destination, created on demand so the folder opens. */
async function openExportFolder() {
  const dir = path.join(app.getPath('documents'), 'LetsRunFaster');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* fall through: openPath reports the real problem */
  }
  const failure = await shell.openPath(dir);
  if (failure) dialog.showErrorBox('Could not open the export folder', failure);
}

async function startEngineWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
    try {
      await startEngine();
      return;
    } catch (err) {
      lastError = err;
      await engine?.stop().catch(() => {});
      if (attempt < START_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      }
    }
  }
  await showStartupFailure(lastError);
}

async function showStartupFailure(error) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'LetsRunFaster Ingestor could not start',
    message: 'The local engine did not start.',
    detail: `${error?.message || error}\n\nLogs: ${LOG_DIR}`,
    buttons: ['Try again', 'Open logs', 'Quit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) return startEngineWithRetry();
  if (response === 1) {
    await shell.openPath(LOG_DIR);
    return showStartupFailure(error);
  }
  app.quit();
  return undefined;
}

function readTail(file, maxChars = 1600) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    // Missing or unreadable log: the dialog still shows the stderr tail.
    return '';
  }
}

function formatCrashDetail(detail) {
  return crashReport.formatCrashDetail({
    ...detail,
    // The engine's own log holds faulthandler dumps, which never touch
    // stderr; showing only stderr made the last crash look reasonless.
    pythonLogTail: readTail(path.join(LOG_DIR, 'engine-python.log')),
    logDir: LOG_DIR,
    path,
  });
}

async function handleEngineCrash(detail) {
  if (shuttingDown) return;
  const text = formatCrashDetail(detail || {});
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'The local engine stopped',
    message: 'The service that talks to Garmin stopped unexpectedly.',
    detail: text,
    buttons: ['Restart engine', 'Copy details', 'Open logs', 'Quit'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  });
  if (response === 0) return startEngineWithRetry();
  if (response === 1) {
    clipboard.writeText(text);
    return handleEngineCrash(detail);
  }
  if (response === 2) {
    await shell.openPath(LOG_DIR);
    return handleEngineCrash(detail);
  }
  app.quit();
  return undefined;
}

/* -------------------------------------------------------------------------- *
 * Security
 * -------------------------------------------------------------------------- */

function installSecurity() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!engineOrigin || !details.url.startsWith(engineOrigin)) {
      return callback({ responseHeaders: details.responseHeaders });
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());

    // Links leave the app through the OS browser; the app itself cannot be
    // navigated away from the engine origin.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      if (engineOrigin && url.startsWith(engineOrigin)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // Reload is a fine browser affordance but a broken desktop one: the
      // engine owns the state and a reload can strand an in-flight export.
      const reload = (input.control || input.meta) && input.key.toLowerCase() === 'r';
      if (reload && app.isPackaged) event.preventDefault();
    });
  });
}

/* -------------------------------------------------------------------------- *
 * IPC
 * -------------------------------------------------------------------------- */

function registerIpc() {
  ipcMain.on('app:info', (event) => {
    event.returnValue = {
      version: app.getVersion(),
      engineVersion: engine?.info?.version || null,
      engineUrl: engineOrigin,
      logDir: LOG_DIR,
    };
  });

  ipcMain.handle('dialog:pick-directory', async (_event, options = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Choose a folder',
      defaultPath: options.defaultPath || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  });
}

/* -------------------------------------------------------------------------- *
 * Menu
 * -------------------------------------------------------------------------- */

function buildMenu() {
  const openLogs = () => shell.openPath(LOG_DIR);
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open export folder', click: openExportFolder },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(app.isPackaged
          ? [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]
          : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'LetsRunFaster', click: () => shell.openExternal('https://www.letsrunfaster.com') },
        { label: 'Engine logs', click: openLogs },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------------- *
 * App lifecycle
 * -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  // A second copy would fight over the Garmin session cache; focus the first.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    installSecurity();
    registerIpc();
    buildMenu();
    createWindow();
    await startEngineWithRetry();
  });
}

app.on('window-all-closed', () => {
  // Single-window desktop app: closing the window is quitting, even on macOS
  // (the engine holds network sockets and tokens, so leaving it headless is
  // more surprising than a cold start next launch).
  app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown || !engine?.running) return;
  event.preventDefault();
  shuttingDown = true;
  engine.stop().finally(() => app.quit());
});
