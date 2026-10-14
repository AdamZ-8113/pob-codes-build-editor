// Experiment-only source overlay. Apply only to an owned scratch driver tree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const loadfSourceSha256 = '5eebcd64b34ef222a37e908ab10ad10efbe1b985c2b76ab7f066f69cef6ab6ac';

function checkedSource(source) {
  assert.equal(createHash('sha256').update(source).digest('hex'), loadfSourceSha256, 'Lua LoadF source drift');
  return Buffer.isBuffer(source) ? source.toString('utf8') : source;
}

function replaceOnce(text, before, after, name) {
  const first = text.indexOf(before);
  assert.ok(first >= 0 && text.indexOf(before, first + before.length) === -1, `Ambiguous Lua ${name} anchor`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function reopenOwnedBinaryStream(text) {
  // WasmFS freopen can retain a NodeFile open count. This FILE is locally owned;
  // pay for closing it before opening the replacement, including error paths.
  return replaceOnce(text,
    '    lf.f = freopen(filename, "rb", lf.f);  /* reopen in binary mode */',
    '    (void)fclose(lf.f);  /* experiment: release the locally owned stream */\n    lf.f = fopen(filename, "rb");  /* reopen in binary mode */',
    'binary reopen');
}

export function applyBinaryReopen(source) {
  return reopenOwnedBinaryStream(checkedSource(source));
}

export function applyLoadfBuffer(source, bytes = 64 * 1024, { binaryReopen = false } = {}) {
  let text = checkedSource(source);
  assert.ok([64 * 1024, 256 * 1024].includes(bytes), 'Unsupported experimental LoadF capacity');
  const before = '  char buff[LUAL_BUFFERSIZE];  /* area for reading file */';
  const after = `  char buff[${bytes}];  /* experiment-only file read buffer; luaL_Buffer is unchanged */`;
  text = replaceOnce(text, before, after, 'LoadF buffer');
  return binaryReopen ? reopenOwnedBinaryStream(text) : text;
}

export function applyStdioBuffer(source, bytes = 256 * 1024) {
  assert.ok([64 * 1024, 256 * 1024].includes(bytes), 'Unsupported experimental stdio capacity');
  let text = reopenOwnedBinaryStream(checkedSource(source));
  text = replaceOnce(text,
    '  char buff[LUAL_BUFFERSIZE];  /* area for reading file */',
    `  char buff[LUAL_BUFFERSIZE];  /* area for reading file */\n  char io_buff[${bytes}];  /* experiment: separate owned stdio storage */`,
    'stdio storage');
  // Only streams owned by this function may borrow its stack storage. The
  // stream is closed before LoadF returns; stdin keeps its original buffering.
  // A rejected setvbuf request falls back to the original stdio behavior.
  for (const operation of ['open', 'reopen']) {
    const before = `    if (lf.f == NULL) return errfile(L, "${operation}", fnameindex);`;
    text = replaceOnce(text, before,
      `${before}\n    (void)setvbuf(lf.f, lf.io_buff, _IOFBF, sizeof(lf.io_buff));`,
      `stdio ${operation}`);
  }
  return text;
}
