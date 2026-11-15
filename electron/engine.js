'use strict';

/**
 * Lifecycle for the bundled Python engine.
 *
 * The shell never guesses a port: it starts `lrf-ingestor ui --no-browser
 * --port 0`, waits for the single `LRF_READY url=... port=...` line on
 * stdout, and only then loads the window. That keeps a second instance, a
 * stale port, or a slow first-run extraction from producing a blank window.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const READY_PREFIX = 'LRF_READY ';
const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 4_000;
const LOG_TAIL_LINES = 40;

function engineBinaryName() {
  return process.platform === 'win32' ? 'lrf-ingestor.exe' : 'lrf-ingestor';
}

/**
 * @param {{ isPackaged: boolean, resourcesPath: string, appRoot: string }} where
 * @returns {string} absolute path to the engine executable
 */
function resolveEngineBinary({ isPackaged, resourcesPath, appRoot }) {
  if (process.env.LRF_ENGINE_BIN) return path.resolve(process.env.LRF_ENGINE_BIN);

  const name = engineBinaryName();
  // Packaged: electron-builder copies resources/bin -> <app>/resources/bin.
  if (isPackaged) return path.join(resourcesPath, 'bin', name);

  // Development: a fetched binary, else the sibling engine repo's local
  // PyInstaller output (`pyinstaller lrf-ingestor.spec` in that repo).
  const repoRoot = path.resolve(appRoot, '..', 'letsrunfaster-ingestor');
  const candidates = [
    path.resolve(appRoot, 'resources', 'bin', name),
    path.join(repoRoot, 'dist', process.platform === 'win32' ? 'LrfIngestor.exe' : 'LrfIngestor'),
    path.join(repoRoot, 'dist', name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

/** Parse the engine's readiness handshake line. */
function parseReadyLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith(READY_PREFIX)) return null;

  const fields = Object.fromEntries(
    trimmed
      .slice(READY_PREFIX.length)
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => {
        const at = part.indexOf('=');
        return at === -1 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
      }),
  );

  const port = Number(fields.port);
  if (!fields.url || !Number.isFinite(port) || port <= 0) return null;
  return {
    url: fields.url,
    port,
    pid: Number(fields.pid) || null,
    version: fields.version || null,
    raw: trimmed,
  };
}

class Engine {
  #child = null;
  #info = null;
  #stopping = false;
  #readyWaiters = null;

  /**
   * @param {{
   *   binary: string,
   *   dataDir: string,
   *   logDir: string,
   *   onUnexpectedExit?: (detail: { code: number|null, signal: string|null }) => void,
   * }} options
   */
  constructor({ binary, dataDir, logDir, onUnexpectedExit }) {
    this.binary = binary;
    this.dataDir = dataDir;
    this.logDir = logDir;
    this.onUnexpectedExit = onUnexpectedExit || (() => {});
  }

  get info() {
    return this.#info;
  }

  get running() {
    return Boolean(this.#child);
  }

  async start() {
    if (this.#child) throw new Error('Engine is already running');
    if (!fs.existsSync(this.binary)) {
      throw new Error(
        `Engine binary not found at ${this.binary}. Run "npm run fetch-engine" or set LRF_ENGINE_BIN.`,
      );
    }
    this.#ensureExecutable();
    // spawn() fails with a bare ENOENT if cwd does not exist, which reads as
    // "engine binary missing" and sends people down the wrong path.
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    const log = fs.createWriteStream(path.join(this.logDir, 'engine.log'), { flags: 'a' });
    log.write(`\n=== ${new Date().toISOString()} starting ${this.binary} ===\n`);

    const child = spawn(this.binary, ['ui', '--no-browser', '--port', '0'], {
      // A packaged app must never write next to its (read-only) bundle.
      cwd: this.dataDir,
      env: {
        ...process.env,
        LRF_INGESTOR_HOME: this.dataDir,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#stopping = false;

    const stderrTail = [];

    const ready = new Promise((resolve, reject) => {
      this.#readyWaiters = { resolve, reject };
    });

    const onLine = (line) => {
      const info = parseReadyLine(line);
      if (!info) return;
      this.#info = info;
      this.#readyWaiters?.resolve(info);
      this.#readyWaiters = null;
    };

    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        log.write(chunk);
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (isError) {
            stderrTail.push(line);
            if (stderrTail.length > LOG_TAIL_LINES) stderrTail.shift();
          }
          onLine(line);
        }
      });
    }

    const timeout = setTimeout(() => {
      this.#readyWaiters?.reject(
        new Error(`Engine did not report readiness within ${START_TIMEOUT_MS / 1000}s`),
      );
      this.#readyWaiters = null;
      this.#terminate('SIGKILL');
    }, START_TIMEOUT_MS);
    timeout.unref?.();

    child.on('error', (err) => {
      stderrTail.push(String(err.message || err));
      this.#readyWaiters?.reject(new Error(`Could not start the engine: ${err.message}`));
      this.#readyWaiters = null;
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      const wasReady = Boolean(this.#info);
      const stopping = this.#stopping;
      this.#child = null;
      this.#info = null;
      // Keep the tail: when the engine dies from native code or is killed
      // externally, the last lines of stderr are the only evidence, and the
      // user should not have to find the log file to report it.
      const tail = stderrTail.slice(-LOG_TAIL_LINES).join('\n').trim();
      log.end();
      if (!wasReady) {
        const detail = stderrTail.slice(-8).join('\n').trim() || 'no output';
        this.#readyWaiters?.reject(
          new Error(`Engine exited before it was ready (code ${code ?? signal}).\n\n${detail}`),
        );
        this.#readyWaiters = null;
        return;
      }
      if (!stopping) this.onUnexpectedExit({ code, signal, tail });
    });

    return ready;
  }

  /** Stop the engine and resolve once the process is gone. */
  async stop() {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    this.#readyWaiters?.reject(new Error('Engine stopped before it was ready'));
    this.#readyWaiters = null;

    const exited = new Promise((resolve) => child.once('exit', resolve));
    this.#terminate('SIGTERM');
    const forced = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#terminate('SIGKILL');
        resolve();
      }, STOP_GRACE_MS);
      timer.unref?.();
      exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await forced;
    this.#child = null;
    this.#info = null;
  }

  #ensureExecutable() {
    if (process.platform === 'win32') return;
    try {
      fs.accessSync(this.binary, fs.constants.X_OK);
    } catch {
      try {
        // Downloaded release artifacts lose the exec bit in zip-based
        // distribution paths; repair it rather than failing with EACCES.
        fs.chmodSync(this.binary, 0o755);
      } catch {
        /* leave it: spawn will report the real error */
      }
    }
  }

  #terminate(signal) {
    const pid = this.#child?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      // PyInstaller one-file builds are a bootloader + child process; a plain
      // kill leaves the app running and the port held.
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
      return;
    }
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { Engine, parseReadyLine, resolveEngineBinary, engineBinaryName, READY_PREFIX };
