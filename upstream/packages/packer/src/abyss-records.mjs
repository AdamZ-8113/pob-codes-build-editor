// Desktop-pin native ABYS/ABYN data, never main-runtime generated shards.
import { inflateSync } from 'node:zlib';
import { parseAbyssLookup, encodeAbyssLookupSlice } from '../../../abyss-lookup-format.js';
export const families = ['Tecrod', 'Ulaman', 'Kurgal', 'Amanamu', 'Zorath'];
export const recordPath = (type, socket, bucket) => `Data/TimelessJewelData/AbyssRecords/${type}-${socket}-${bucket}.bin`;
export function shardFamily(parts, type) {
  const lookup = parseAbyssLookup(inflateSync(Buffer.concat(parts)));
  if (lookup.jewelType !== type || lookup.seedMinimum !== 100 || lookup.seedMaximum !== 8000 || lookup.seedIncrement !== 1) throw new Error('Desktop Abyss input identity changed');
  const bucketSize = type === 11 ? 32 : 512;
  const sockets = lookup.format === 'ABYS' ? lookup.sockets.map(s => s.socketId) : [0];
  const entries = [];
  for (const socket of sockets) for (let start = 0; start < lookup.seedCount; start += bucketSize) {
    const count = Math.min(bucketSize, lookup.seedCount - start);
    const bytes = encodeAbyssLookupSlice(lookup, {seedStartIndex: start, seedCount: count, socketId: socket});
    const shard = parseAbyssLookup(bytes);
    // Check every native variable-length record, including all ABYN ascendancies.
    const original = lookup.format === 'ABYS' ? [lookup.sockets.find(s => s.socketId === socket)] : [...lookup.nodes, ...lookup.ascendancies];
    const records = shard.format === 'ABYS' ? shard.sockets : [...shard.nodes, ...shard.ascendancies];
    for (let block = 0; block < original.length; block++) for (let i = 0; i < count; i++) {
      const a = original[block], b = records[block];
      if (!Buffer.from(a.data.subarray(a.offsets[start+i], a.offsets[start+i+1])).equals(Buffer.from(b.data.subarray(b.offsets[i], b.offsets[i+1])))) throw new Error('Abyss shard roundtrip changed a native record');
    }
    entries.push({path: recordPath(type, socket, start / bucketSize), data: bytes});
  }
  return {entries, metadata: {type, format: lookup.format, seedMinimum: lookup.seedMinimum,
    seedMaximum: lookup.seedMaximum, seedIncrement: lookup.seedIncrement, bucketSize, sockets}};
}

export function adaptAbyssReader(source, helper) {
  const begin = source.indexOf('local function loadAbyssJewel(jewelType)');
  const end = source.indexOf('local function getSeedIndex', begin);
  if (begin < 0 || end < 0 || (source.match(/loadAbyssJewel\(jewelType\)/g) ?? []).length !== 4) throw new Error('Abyss reader hooks changed');
  const adapted = (source.slice(0, begin) + helper + '\n' + source.slice(end))
    .replace('loadAbyssJewel(jewelType)', 'loadAbyssJewel(jewelType, seed, 0, bulk)')
    .replace('loadAbyssJewel(jewelType)', 'loadAbyssJewel(jewelType, seed, socketId, bulk)')
    .replace('loadAbyssJewel(jewelType)', 'loadAbyssJewel(jewelType, seed, 0, bulk)')
    .replace('readNode(seed, nodeId, jewelType)', 'readNode(seed, nodeId, jewelType, bulk)')
    .replaceAll('readNode(seed, nodeId, jewelType)', 'readNode(seed, nodeId, jewelType, bulk)')
    .replace('for _, socketId in ipairs(socketIds) do\n\t\t\tjewelLUT.blockOffsets[socketId] = offset\n\t\t\tfor _ = 1, jewelLUT.seedCount do', 'for _, socketId in ipairs(socketIds) do\n\t\t\tjewelLUT.blockOffsets[socketId] = offset\n\t\t\tlocal offsets = {}; jewelLUT.seedOffsets[socketId] = offsets\n\t\t\tfor seedIndex = 1, jewelLUT.seedCount do\n\t\t\t\toffsets[seedIndex] = offset')
    .replace('for _, nodeId in ipairs(nodeIds) do\n\t\t\tjewelLUT.blockOffsets[nodeId] = offset\n\t\t\tfor _ = 1, jewelLUT.seedCount do', 'for _, nodeId in ipairs(nodeIds) do\n\t\t\tjewelLUT.blockOffsets[nodeId] = offset\n\t\t\tlocal offsets = {}; jewelLUT.seedOffsets[nodeId] = offsets\n\t\t\tfor seedIndex = 1, jewelLUT.seedCount do\n\t\t\t\toffsets[seedIndex] = offset')
    .replace('jewelLUT.ascendancyOffsets[ascendancyName] = offset\n\t\t\tfor _ = 1, jewelLUT.seedCount do', 'jewelLUT.ascendancyOffsets[ascendancyName] = offset\n\t\t\tlocal offsets = {}; jewelLUT.seedOffsets["ascendancy:" .. ascendancyName] = offsets\n\t\t\tfor seedIndex = 1, jewelLUT.seedCount do\n\t\t\t\toffsets[seedIndex] = offset')
    .replace('readAbyssJewelLUT(seed, socketId, jewelType, path, ascendancyName)', 'readAbyssJewelLUT(seed, socketId, jewelType, path, ascendancyName, bulk)')
    .replace('readNode(seed, nodeId, jewelType, bulk)', 'readNode(seed, nodeId, jewelType, bulk, provided)')
    .replace('local jewelLUT = loadAbyssJewel(jewelType, seed, 0, bulk)', 'local jewelLUT = provided or loadAbyssJewel(jewelType, seed, 0, bulk)')
    .replace('local affectedNodes = { }\n\tfor nodeId in pairs(path) do', 'local jewelLUT = loadAbyssJewel(jewelType, seed, 0, bulk, path, ascendancyName)\n\tlocal affectedNodes = { }\n\tfor nodeId in pairs(path) do')
    .replaceAll('readNode(seed, nodeId, jewelType, bulk)', 'readNode(seed, nodeId, jewelType, bulk, jewelLUT)')
    .replace('local jewelLUT = loadAbyssJewel(jewelType, seed, 0, bulk)\n\tlocal seedIndex = jewelLUT and getSeedIndex(jewelLUT, seed)\n\tif seedIndex and', 'if seedIndex and')
    // A Zorath request shares one LUT and seed index across path/ascendancy nodes.
    .replace('readNode(seed, nodeId, jewelType, bulk, provided)', 'readNode(seed, nodeId, jewelType, bulk, provided, providedIndex)')
    .replace('local seedIndex = jewelLUT and getSeedIndex(jewelLUT, seed)', 'local seedIndex = providedIndex or jewelLUT and getSeedIndex(jewelLUT, seed)')
    .replace('local affectedNodes = { }\n\tfor nodeId in pairs(path) do', 'local seedIndex = jewelLUT and getSeedIndex(jewelLUT, seed)\n\tlocal affectedNodes = { }\n\tfor nodeId in pairs(path) do')
    .replaceAll('readNode(seed, nodeId, jewelType, bulk, jewelLUT)', 'readNode(seed, nodeId, jewelType, bulk, jewelLUT, seedIndex)')
    // All offsets were already validated and indexed during native parsing.
    .replace('getRecordOffsets(jewelLUT, nodeId, jewelLUT.blockOffsets[nodeId], skipModification)', 'jewelLUT.seedOffsets[nodeId]')
    .replace('getRecordOffsets(jewelLUT, socketId, jewelLUT.blockOffsets[socketId], skipSocketRecord)', 'jewelLUT.seedOffsets[socketId]')
    .replace('getRecordOffsets(jewelLUT, blockKey, blockOffset, skipAscendancyRecord)', 'jewelLUT.seedOffsets[blockKey]');
  for (const hook of ['jewelLUT.seedOffsets[socketId] = offsets','jewelLUT.seedOffsets[nodeId] = offsets','jewelLUT.seedOffsets["ascendancy:" .. ascendancyName] = offsets']) {
    if (!adapted.includes(hook)) throw new Error('Abyss parser index hook changed');
  }
  return adapted;
}

export function adaptAbyssSearch(source) {
  const hook = 'data.readAbyssJewelLUT(curSeed, socketId, timelessData.jewelType.id, zorathPath, self.build.spec.curAscendClassName)';
  if (source.split(hook).length !== 2) throw new Error('Timeless search hook changed');
  // Explicit argument scopes bulk access to this call, including cancellation/re-entry.
  return source.replace(hook, hook.slice(0, -1) + ', true)');
}
