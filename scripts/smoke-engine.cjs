'use strict';

/**
 * Headless smoke test for the shell <-> engine boundary.
 *
 * Starts the real engine exactly like the app does (`ui --no-browser
 * --port 0`), waits for the LRF_READY handshake, checks /api/health and
 * /api/config against the isolated state directory, then stops it again.
 * This is the part of the app that can be verified without a display, and
 * the part most likely to break on a new engine release.
 *
 * Usage:
 *   node scripts/smoke-engine.cjs
 *   LRF_ENGINE_BIN=../letsrunfaster-ingestor/dist/LrfIngestor node scripts/smoke-engine.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Engine, resolveEngineBinary } = require('../electron/engine.js');

const appRoot = path.resolve(__dirname, '..');
const binary = resolveEngineBinary({
  isPackaged: false,
  resourcesPath: path.join(appRoot, 'resources'),
  appRoot,
});

if (!fs.existsSync(binary)) {
  console.error(`Engine binary not found: ${binary}`);
  console.error('Build it with "pyinstaller lrf-ingestor.spec" in the engine repo,');
  console.error('or set LRF_ENGINE_BIN. (npm run fetch-engine only works after the');
  console.error('pinned release exists on GitHub.)');
  process.exit(1);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrf-smoke-'));
const dataDir = path.join(workDir, 'data');
const logDir = path.join(workDir, 'logs');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  console.log(`engine: ${binary}`);
  console.log(`state:  ${dataDir}`);

  const unexpected = [];
  const engine = new Engine({
    binary,
    dataDir,
    logDir,
    onUnexpectedExit: (detail) => unexpected.push(detail),
  });

  try {
    const info = await engine.start();
    console.log(`ready:  port=${info.port} version=${info.version}`);
    check(!Number.isNaN(info.port) && info.port > 0, 'handshake had no usable port');

    const health = await (await fetch(`${info.url}/api/health`)).json();
    check(health.ok === true, `health check failed: ${JSON.stringify(health)}`);
    check(health.app === 'lrf-ingestor', `unexpected app name: ${health.app}`);
    console.log(`health: ok (engine ${health.version})`);

    const config = await (await fetch(`${info.url}/api/config`)).json();
    check(
      config.app_home === dataDir,
      `LRF_INGESTOR_HOME was not honored: ${config.app_home} != ${dataDir}`,
    );
    check(
      path.isAbsolute(config.default_output_dir),
      `default_output_dir is not absolute: ${config.default_output_dir}`,
    );
    console.log(`config: app_home=${config.app_home}`);

    const page = await (await fetch(`${info.url}/`)).text();
    check(/assets\/[^"]+\.js/.test(page), 'UI page does not reference a built bundle');
    console.log('ui:     built bundle served');

    await engine.stop();
    check(!engine.running, 'engine still running after stop()');
    check(unexpected.length === 0, `unexpected engine exit: ${JSON.stringify(unexpected)}`);

    const log = fs.readFileSync(path.join(logDir, 'engine.log'), 'utf8');
    check(log.includes('LRF_READY'), 'engine log did not capture the handshake');
    console.log('stop:   clean');
    console.log('\nsmoke test passed');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(`\nsmoke test failed: ${err.message}`);
  process.exit(1);
});
