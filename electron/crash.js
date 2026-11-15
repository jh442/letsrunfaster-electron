'use strict';

/**
 * Crash-report formatting for the engine supervisor.
 *
 * Kept free of Electron imports so it can be unit tested with `node --test`.
 * When the engine dies without a Python traceback (native crash in libcurl,
 * or an external kill) the last lines of its stderr are the entire diagnosis,
 * so they belong in the dialog rather than only in the log file.
 */

const MAX_TAIL_CHARS = 2000;

/**
 * @param {{ code?: number|null, signal?: string|null, tail?: string, logDir: string, path?: { join: Function } }} detail
 * @returns {string}
 */
function formatCrashDetail({ code, signal, tail, logDir, path }) {
  const join = path ? path.join : (...parts) => parts.join('/');
  const lines = [`Exit code: ${code ?? signal ?? 'unknown'}`];

  const text = String(tail || '').trim();
  if (!text) {
    lines.push('', 'The engine produced no output before it stopped.');
  } else {
    lines.push('', 'Last output from the engine:');
    // The end of a traceback is the informative part; keep the dialog short.
    lines.push(text.length > MAX_TAIL_CHARS ? `...\n${text.slice(-MAX_TAIL_CHARS)}` : text);
  }

  lines.push(
    '',
    `Logs: ${logDir}`,
    `Engine diagnostics: ${join(logDir, 'engine-python.log')}`,
  );
  return lines.join('\n');
}

module.exports = { formatCrashDetail, MAX_TAIL_CHARS };
