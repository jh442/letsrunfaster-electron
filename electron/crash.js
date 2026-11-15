'use strict';

/**
 * Crash-report formatting for the engine supervisor.
 *
 * Kept free of Electron imports so it can be unit tested with `node --test`.
 * When the engine dies without a Python traceback (native crash in an SSL or
 * curl library, or an external kill) there are two sources of evidence:
 *
 * - the last lines of stderr (uvicorn's messages and our own log lines), and
 * - `engine-python.log`, which is where faulthandler writes a stack dump and
 *   where every phase of a request is recorded.
 *
 * Both belong in the dialog: the user should never have to find a file to
 * report a crash.
 */

const MAX_TAIL_CHARS = 1600;

/**
 * @param {{
 *   code?: number|null,
 *   signal?: string|null,
 *   tail?: string,
 *   pythonLogTail?: string,
 *   logDir: string,
 *   path?: { join: Function },
 * }} detail
 * @returns {string}
 */
function formatCrashDetail({ code, signal, tail, pythonLogTail, logDir, path }) {
  const join = path ? path.join : (...parts) => parts.join('/');
  const lines = [`Exit code: ${code ?? signal ?? 'unknown'}`];

  lines.push('', 'Last output from the engine:');
  lines.push(tailText(tail) || '(no output)');

  const diagnostics = tailText(pythonLogTail);
  if (diagnostics) {
    lines.push('', 'Engine diagnostics log:');
    lines.push(diagnostics);
  }

  lines.push(
    '',
    `Logs: ${logDir}`,
    `Engine diagnostics: ${join(logDir, 'engine-python.log')}`,
    '',
    'Tip: running "lrf-ingestor.exe diagnose" in a terminal tests each ' +
      'network step separately and logs which one fails.',
  );
  return lines.join('\n');
}

function tailText(value) {
  const text = String(value || '').trim();
  if (text.length <= MAX_TAIL_CHARS) return text;
  // The end of a traceback is the informative part.
  return `...\n${text.slice(-MAX_TAIL_CHARS)}`;
}

module.exports = { formatCrashDetail, MAX_TAIL_CHARS };
