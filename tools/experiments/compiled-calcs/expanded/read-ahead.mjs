// Experiment-only, per-open read-ahead for immutable packaged Lua source.
// Payload authorization/lazy loading still happens in the unchanged broker open.
export function createReadAheadRpc(base, { enabled = true, chunkBytes = 256 * 1024, maxRetainedBytes = 4 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > maxRetainedBytes) throw new Error('Invalid read-ahead capacity');
  const files = new Map();
  const activeDescriptors = new Map();
  const stats = {
    enabled, chunkBytes, maxRetainedBytes, calls: {}, forwardedCalls: {},
    successfulForwardedCalls: {}, failedForwardedCalls: {},
    requestedReadBytes: 0, deliveredReadBytes: 0, transportedReadBytes: 0,
    requestedReadLengths: {}, forwardedReadLengths: {},
    windowHits: 0, windowFetches: 0, eligibleOpens: 0,
    retainedBytes: 0, peakRetainedBytes: 0, peakOpenFiles: 0,
  };

  function discard(file) {
    if (file?.bytes) stats.retainedBytes -= file.bytes.byteLength;
    if (file) { file.bytes = undefined; file.eof = false; }
  }
  function invalidate() { for (const file of files.values()) discard(file); }
  function forward(operation, args, data, capacity) {
    stats.forwardedCalls[operation] = (stats.forwardedCalls[operation] ?? 0) + 1;
    if (operation === 'read') stats.forwardedReadLengths[args[1]] = (stats.forwardedReadLengths[args[1]] ?? 0) + 1;
    let result;
    try {
      result = base(operation, args, data, capacity);
      stats.successfulForwardedCalls[operation] = (stats.successfulForwardedCalls[operation] ?? 0) + 1;
    } catch (error) {
      stats.failedForwardedCalls[operation] = (stats.failedForwardedCalls[operation] ?? 0) + 1;
      throw error;
    }
    if (operation === 'open') {
      const path = args[0];
      activeDescriptors.set(result.value, typeof path === 'string' && path.startsWith('/root/') && !path.split('/').includes('..') ? path : '[non-payload]');
    }
    if (operation === 'close') activeDescriptors.delete(args[0]);
    if (operation === 'read') stats.transportedReadBytes += result.data?.byteLength ?? 0;
    return result;
  }
  function deliver(bytes) {
    stats.deliveredReadBytes += bytes.byteLength;
    // Returned buffers retain the original RPC ownership contract.
    return { value: bytes.byteLength, data: bytes.byteLength ? bytes.slice() : undefined };
  }
  function rpc(operation, args = [], data, capacity) {
    stats.calls[operation] = (stats.calls[operation] ?? 0) + 1;
    if (operation === 'read') {
      stats.requestedReadBytes += Number(args[1]) || 0;
      stats.requestedReadLengths[args[1]] = (stats.requestedReadLengths[args[1]] ?? 0) + 1;
    }
    if (!enabled) {
      const result = forward(operation, args, data, capacity);
      if (operation === 'read') stats.deliveredReadBytes += Number(result.value) || 0;
      return result;
    }
    if (operation === 'open') {
      const [path, mode] = args;
      const result = forward(operation, args, data, capacity);
      discard(files.get(result.value));
      files.delete(result.value);
      if (typeof mode === 'string' && /[wa+]/.test(mode)) invalidate();
      if (typeof path === 'string' && path.startsWith('/root/') && path.endsWith('.lua')
          && !path.split('/').includes('..') && ['r', 'rb'].includes(mode)) {
        files.set(result.value, { bytes: undefined, start: 0, eof: false });
        stats.eligibleOpens++;
        stats.peakOpenFiles = Math.max(stats.peakOpenFiles, files.size);
      }
      return result;
    }
    if (operation === 'close') {
      // A failed close can still invalidate the underlying descriptor. Never
      // satisfy a later read from bytes retained before the close attempt.
      discard(files.get(args[0])); files.delete(args[0]);
      return forward(operation, args, data, capacity);
    }
    if (['write', 'ftruncate', 'truncate', 'rename', 'unlink', 'rmdir', 'mkdir'].includes(operation)) invalidate();
    if (operation === 'read') {
      const [fd, length, position] = args;
      const file = files.get(fd);
      if (file && Number.isSafeInteger(length) && length > 0 && length <= chunkBytes
          && Number.isSafeInteger(position) && position >= 0) {
        if (file.bytes && position >= file.start &&
            (position + length <= file.start + file.bytes.byteLength || file.eof)) {
          stats.windowHits++;
          const offset = Math.min(position - file.start, file.bytes.byteLength);
          return deliver(file.bytes.subarray(offset, Math.min(offset + length, file.bytes.byteLength)));
        }
        const result = forward('read', [fd, chunkBytes, position], undefined, chunkBytes + 4096);
        const bytes = result.data ?? new Uint8Array();
        if (!Number.isInteger(result.value) || result.value < 0 || result.value !== bytes.byteLength || bytes.byteLength > chunkBytes) {
          throw new Error('Invalid read-ahead transport result');
        }
        discard(file);
        for (const other of files.values()) {
          if (stats.retainedBytes + bytes.byteLength <= maxRetainedBytes) break;
          if (other !== file) discard(other);
        }
        file.bytes = bytes; file.start = position; file.eof = bytes.byteLength < chunkBytes;
        stats.windowFetches++;
        stats.retainedBytes += bytes.byteLength;
        stats.peakRetainedBytes = Math.max(stats.peakRetainedBytes, stats.retainedBytes);
        return deliver(bytes.subarray(0, Math.min(length, bytes.byteLength)));
      }
    }
    const result = forward(operation, args, data, capacity);
    if (operation === 'read') stats.deliveredReadBytes += Number(result.value) || 0;
    return result;
  }
  rpc.profile = () => structuredClone({ ...stats, openFiles: files.size,
    activeDescriptorCount: activeDescriptors.size, activeDescriptorPaths: [...activeDescriptors.values()].sort() });
  return rpc;
}
