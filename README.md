# LetsRunFaster Ingestor — Desktop

A native wrapper around the [LetsRunFaster Ingestor](https://github.com/jh442/letsrunfaster-ingestor)
engine. The engine (Python) owns Garmin auth, exporting, and the UI; this repo
only packages it into a double-clickable app for macOS, Windows, and Linux.

**Why a separate repo:** the engine stays usable as a CLI and a browser tool.
This repo adds the desktop concerns — window lifecycle, a native folder picker,
an owned app icon, and a place for auto-update later — without putting Electron
and Node into the Python package.

## How it works

```
Electron main process
  ├─ spawns  lrf-ingestor ui --no-browser --port 0   (bundled binary)
  ├─ reads   LRF_READY url=http://127.0.0.1:53421 port=53421 version=0.2.0
  ├─ polls   GET /api/health                        (ok before window loads)
  └─ loads   http://127.0.0.1:<port>/  in a sandboxed window
```

- The port is never hardcoded; a busy port or a second instance cannot produce
  a blank window.
- The renderer is the engine's own web UI, so the browser build and the desktop
  build can never drift apart.
- The engine's state (`LRF_INGESTOR_HOME`) points at Electron's `userData`
  folder, so tokens and the API key survive app updates and never sit inside
  the app bundle.

## Requirements

- Node 22+ to build.
- An engine release that includes the `ui --no-browser --port 0` handshake.
  The pin lives in [`engine.json`](engine.json); bump it after tagging a new
  engine release.

## What a user installs

One file per machine. The installer bundles both the Electron shell and the
engine binary — no Python, Node, or terminal involved.

| Machine | Artifact |
| --- | --- |
| Windows x64 | `LetsRunFaster-Ingestor-<version>-win-x64.exe` |
| Windows on ARM | `LetsRunFaster-Ingestor-<version>-win-arm64.exe` |
| macOS (Apple Silicon) | `LetsRunFaster-Ingestor-<version>-mac-arm64.dmg` |
| Linux x64 | `LetsRunFaster-Ingestor-<version>-linux-x64.AppImage` |

Intel Macs and Linux ARM are not built yet: the engine is compiled natively
per platform, so each target needs its own build job. Windows on ARM gets a
native arm64 engine (not an emulated x64 one), which keeps first launch fast.

The window frame is drawn by the OS. The app asks for dark chrome
(`nativeTheme.themeSource = 'dark'`), which Windows and macOS honor. Under
WSLg the frame belongs to the WSL window manager and ignores that request, so
a light border there is expected and does not appear in the Windows build.

## Development

Point the shell at a locally built engine (no download needed):

```bash
# once, in the engine repo
cd ../letsrunfaster-ingestor
pyinstaller lrf-ingestor.spec

# here
npm install
LRF_ENGINE_BIN=../letsrunfaster-ingestor/dist/LrfIngestor npm start
```

Or fetch the pinned release binary:

```bash
npm run fetch-engine     # verifies SHA256SUMS.txt from the GitHub release
npm start
```

`npm test` covers the readiness handshake parser and binary discovery. There is
no renderer test suite here — the renderer is tested in the engine repo.

## Testing

Four layers, cheapest first:

1. **Unit tests** — handshake parsing and binary discovery.

   ```bash
   npm test
   ```

2. **Engine smoke test** — starts the real binary exactly as the app does,
   checks `LRF_READY`, `/api/health`, that `LRF_INGESTOR_HOME` is honored, that
   the built UI is served, and that the process stops cleanly. No display
   needed, so it also runs in CI.

   ```bash
   npm run smoke
   LRF_ENGINE_BIN=../letsrunfaster-ingestor/dist/LrfIngestor npm run smoke
   ```

3. **The real window** — this is the layer that catches layout, focus, and
   native-dialog problems.

   ```bash
   LRF_ENGINE_BIN=../letsrunfaster-ingestor/dist/LrfIngestor npm start
   ```

   On a minimal Linux install, Electron needs Chromium's shared libraries;
   without them it exits with `error while loading shared libraries:
   libnspr4.so`:

   ```bash
   sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
     libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
     libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64
   # Ubuntu 22.04 uses libasound2 instead of libasound2t64
   ```

   Under WSL, use WSLg (Windows 11) or `xvfb-run -a npm start` for a headless
   run that only checks the app boots without crashing.

4. **The packaged app** — what users actually install.

   ```bash
   npm run dist:dir     # unpacked, skip installer tooling
   ./release/linux-*-unpacked/letsrunfaster-ingestor-desktop
   npm run dist         # AppImage / dmg / nsis installer
   ```

Manual checklist for the window: splash gives way to the app (no white
flash), Garmin sign-in works including MFA, activities preview loads, an export
runs to completion, the folder picker writes the chosen path and it is still
there after restarting the app, `Esc` dismisses progress, closing the window
quits (no stray process), a second launch focuses the first window, and killing
the engine process surfaces the "engine stopped" dialog with a working restart.

Logs land in the app state folder (`~/.config/LetsRunFaster Ingestor/logs/` on
Linux, `~/Library/Application Support/LetsRunFaster Ingestor/logs/` on macOS,
`%APPDATA%\LetsRunFaster Ingestor\logs\` on Windows).

## Packaging

```bash
npm run fetch-engine
npm run dist             # host platform; release/ gets the installer
npm run dist:dir         # unpacked app, faster for smoke tests
```

CI (`.github/workflows/build.yml`) builds each platform on its own runner and
attaches installers to a GitHub Release on `v*` tags. The engine artifact is
downloaded from the pinned release and checksum-verified, never committed.

## Where state lives

| Platform | `userData` |
| --- | --- |
| macOS | `~/Library/Application Support/LetsRunFaster Ingestor` |
| Windows | `%APPDATA%\LetsRunFaster Ingestor` |
| Linux | `~/.config/LetsRunFaster Ingestor` |

Inside it: `config.json` (API key, mode 0600), `tokens/` (Garmin session),
`logs/engine.log` (everything the engine printed, including HTTP requests),
`logs/engine-python.log` (version banner, exceptions, native-crash stack
dumps), `window-state.json`. Exports default to `Documents/LetsRunFaster`.

When the engine stops unexpectedly, the dialog shows the exit code, the last
lines the engine wrote, and the tail of `engine-python.log` (which is where a
native crash dump lands), with buttons to copy that text, open the log folder,
or restart. If the log simply stops, `lrf-ingestor.exe diagnose` in a terminal
runs each network step separately and logs which one kills the process.

## Security posture

- `contextIsolation`, `sandbox`, no `nodeIntegration`; the preload exposes only
  `pickDirectory` and version info.
- Navigation is pinned to the engine origin; external links open in the OS
  browser, never in the app.
- A strict CSP is applied to engine responses; devtools and reload are disabled
  in packaged builds.
- Single-instance lock: two copies would race over the Garmin token cache.

## Not done yet

- **App icon.** Drop `build/icon.icns`, `build/icon.ico`, and `build/icon.png`
  (1024px). See [`build/README.md`](build/README.md).
- **Code signing / notarization.** Unsigned macOS builds are blocked by
  Gatekeeper on other machines; Windows shows SmartScreen warnings. Needs an
  Apple Developer ID and a Windows certificate in CI secrets.
- **Auto-update.** `electron-updater` plus a published feed; the engine binary
  would be updated by shipping a new app version.
- **Background scheduling.** The engine already exposes an RPC sidecar
  (`garmin_engine/rpc_server.py`) for headless use; a tray/menu-bar mode would
  run the export loop without a window.
