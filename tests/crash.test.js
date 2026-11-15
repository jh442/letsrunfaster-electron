'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { formatCrashDetail, MAX_TAIL_CHARS } = require('../electron/crash');

const LOG_DIR = path.join('/home/user', 'LetsRunFaster Ingestor', 'logs');

test('crash detail reports the exit code and both log files', () => {
  const text = formatCrashDetail({ code: 1, signal: null, tail: '', logDir: LOG_DIR, path });
  assert.match(text, /Exit code: 1/);
  assert.match(text, /produced no output/);
  assert.ok(text.includes(path.join(LOG_DIR, 'engine-python.log')));
});

test('crash detail includes the engine tail', () => {
  // The field failure produced exit code 1 with a silent log; if the engine
  // does print something, the user must not have to go find it.
  const tail = 'Fatal Python error: Segmentation fault\nTraceback (most recent call last):';
  const text = formatCrashDetail({ code: 1, signal: null, tail, logDir: LOG_DIR, path });
  assert.ok(text.includes(tail));
});

test('crash detail keeps only the end of a long tail', () => {
  const tail = 'x'.repeat(MAX_TAIL_CHARS) + 'LAST LINE';
  const text = formatCrashDetail({ code: 1, signal: null, tail, logDir: LOG_DIR, path });
  assert.ok(text.includes('LAST LINE'));
  assert.ok(text.includes('...'));
  assert.ok(!text.includes('x'.repeat(MAX_TAIL_CHARS + 1)));
});

test('crash detail falls back to the signal name', () => {
  const text = formatCrashDetail({ code: null, signal: 'SIGKILL', logDir: LOG_DIR, path });
  assert.match(text, /Exit code: SIGKILL/);
});
