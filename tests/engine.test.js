'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseReadyLine, resolveEngineBinary } = require('../electron/engine.js');

test('parses the readiness handshake', () => {
  const info = parseReadyLine('LRF_READY url=http://127.0.0.1:53421 port=53421 pid=8123 version=0.1.0');
  assert.deepEqual(
    { url: info.url, port: info.port, pid: info.pid, version: info.version },
    { url: 'http://127.0.0.1:53421', port: 53421, pid: 8123, version: '0.1.0' },
  );
});

test('tolerates extra whitespace and CRLF', () => {
  const info = parseReadyLine('  LRF_READY   url=http://127.0.0.1:9000   port=9000\r');
  assert.equal(info.url, 'http://127.0.0.1:9000');
  assert.equal(info.port, 9000);
});

test('ignores unrelated output', () => {
  assert.equal(parseReadyLine('INFO:     Started server process [1]'), null);
  assert.equal(parseReadyLine(''), null);
  assert.equal(parseReadyLine(undefined), null);
});

test('rejects a handshake without a usable port', () => {
  assert.equal(parseReadyLine('LRF_READY url=http://127.0.0.1:0 port=0'), null);
  assert.equal(parseReadyLine('LRF_READY url=http://127.0.0.1:5000'), null);
});

test('LRF_ENGINE_BIN overrides binary discovery', () => {
  const previous = process.env.LRF_ENGINE_BIN;
  process.env.LRF_ENGINE_BIN = '/opt/engine/LrfIngestor';
  try {
    const resolved = resolveEngineBinary({
      isPackaged: true,
      resourcesPath: '/Applications/App.app/Contents/Resources',
      appRoot: '/opt/app',
    });
    assert.equal(resolved, path.resolve('/opt/engine/LrfIngestor'));
  } finally {
    if (previous === undefined) delete process.env.LRF_ENGINE_BIN;
    else process.env.LRF_ENGINE_BIN = previous;
  }
});

test('packaged apps look in resources/bin', () => {
  const previous = process.env.LRF_ENGINE_BIN;
  delete process.env.LRF_ENGINE_BIN;
  try {
    const resolved = resolveEngineBinary({
      isPackaged: true,
      resourcesPath: '/Applications/App.app/Contents/Resources',
      appRoot: '/opt/app',
    });
    assert.equal(resolved, path.join('/Applications/App.app/Contents/Resources', 'bin', path.basename(resolved)));
    assert.match(path.basename(resolved), /^lrf-ingestor(\.exe)?$/);
  } finally {
    if (previous !== undefined) process.env.LRF_ENGINE_BIN = previous;
  }
});

test('every pinned platform maps to its own engine artifact', () => {
  // Windows on ARM must download the native arm64 engine, not the x64 one:
  // a shared filename would silently ship an emulated engine.
  const spec = require('../engine.json');
  const files = Object.values(spec.assets);
  assert.equal(new Set(files).size, files.length);
  for (const key of ['darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64']) {
    assert.ok(spec.assets[key], `missing engine artifact for ${key}`);
  }
});
