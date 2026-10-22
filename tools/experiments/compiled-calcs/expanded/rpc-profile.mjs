// Experiment-only transport accounting. Every call and result passes through
// unchanged; this observer never caches, enlarges, or copies file reads.
export function createProfiledRpc(base) {
  const descriptors = new Map();
  const stats = {
    calls: {}, forwardedCalls: {}, successfulForwardedCalls: {}, failedForwardedCalls: {},
    requestedReadBytes: 0, deliveredReadBytes: 0, transportedReadBytes: 0,
    requestedReadLengths: {}, forwardedReadLengths: {},
  };
  function rpc(operation, args = [], data, capacity) {
    stats.calls[operation] = (stats.calls[operation] ?? 0) + 1;
    stats.forwardedCalls[operation] = (stats.forwardedCalls[operation] ?? 0) + 1;
    if (operation === 'read') {
      stats.requestedReadBytes += Number(args[1]) || 0;
      stats.requestedReadLengths[args[1]] = (stats.requestedReadLengths[args[1]] ?? 0) + 1;
      stats.forwardedReadLengths[args[1]] = (stats.forwardedReadLengths[args[1]] ?? 0) + 1;
    }
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
      descriptors.set(result.value, typeof path === 'string' && path.startsWith('/root/') && !path.split('/').includes('..') ? path : '[non-payload]');
    }
    if (operation === 'close') descriptors.delete(args[0]);
    if (operation === 'read') {
      stats.deliveredReadBytes += Number(result.value) || 0;
      stats.transportedReadBytes += result.data?.byteLength ?? 0;
    }
    return result;
  }
  rpc.profile = () => structuredClone({ ...stats,
    activeDescriptorCount: descriptors.size, activeDescriptorPaths: [...descriptors.values()].sort() });
  return rpc;
}
