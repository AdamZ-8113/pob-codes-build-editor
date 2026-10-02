// @ts-check

const HEADER_SIZE = 12;
const FORMAT_ABYS = "ABYS";
const FORMAT_ABYN = "ABYN";
const FORMAT_VERSION = 1;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** @typedef {{ data: Uint8Array, offsets: Uint32Array }} RecordIndex */
/** @typedef {{ format: "ABYS", version: number, jewelType: number, seedMinimum: number, seedMaximum: number, seedIncrement: number, seedCount: number, abyssSize: number, sockets: Array<RecordIndex & { socketId: number }> }} AbysLookup */
/** @typedef {{ format: "ABYN", version: number, jewelType: number, seedMinimum: number, seedMaximum: number, seedIncrement: number, seedCount: number, nodes: Array<RecordIndex & { nodeId: number }>, ascendancies: Array<RecordIndex & { name: string }> }} AbynLookup */
/** @typedef {AbysLookup | AbynLookup} AbyssLookup */

/** @param {Uint8Array} input @returns {AbyssLookup} */
export function parseAbyssLookup(input) {
  const bytes = asBytes(input);
  ensureAvailable(bytes, 0, HEADER_SIZE, "header");
  const format = ascii(bytes, 0, 4);
  const version = bytes[4];
  const jewelType = bytes[5];
  const seedMinimum = readUInt16(bytes, 6);
  const seedMaximum = readUInt16(bytes, 8);
  const seedIncrement = readUInt16(bytes, 10);
  if ((format !== FORMAT_ABYS && format !== FORMAT_ABYN) || version !== FORMAT_VERSION) {
    throw new Error(`Unsupported Abyss lookup header ${format || "<empty>"} version ${version}.`);
  }
  if (jewelType < 7 || jewelType > 11 || (format === FORMAT_ABYS && jewelType === 11) || (format === FORMAT_ABYN && jewelType !== 11)) {
    throw new Error(`Abyss lookup format ${format} does not match jewel type ${jewelType}.`);
  }
  if (!seedIncrement || seedMaximum < seedMinimum || (seedMaximum - seedMinimum) % seedIncrement !== 0) {
    throw new Error("Invalid Abyss lookup seed range.");
  }
  const seedCount = (seedMaximum - seedMinimum) / seedIncrement + 1;
  if (!Number.isSafeInteger(seedCount) || seedCount < 1 || seedCount > 0xffff) {
    throw new Error("Invalid Abyss lookup seed count.");
  }

  let offset = HEADER_SIZE;
  if (format === FORMAT_ABYS) {
    ensureAvailable(bytes, offset, 2, "ABYS socket header");
    const socketCount = bytes[offset];
    const abyssSize = bytes[offset + 1];
    offset += 2;
    const socketIds = [];
    const seen = new Set();
    for (let index = 0; index < socketCount; index += 1) {
      const socketId = readUInt16At(bytes, offset, "ABYS socket id");
      offset += 2;
      if (seen.has(socketId)) {
        throw new Error(`Duplicate ABYS socket id ${socketId}.`);
      }
      seen.add(socketId);
      socketIds.push(socketId);
    }
    const sockets = [];
    for (const socketId of socketIds) {
      const offsets = new Uint32Array(seedCount + 1);
      for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
        offsets[seedIndex] = offset;
        offset = skipSocketRecord(bytes, offset);
      }
      offsets[seedCount] = offset;
      sockets.push({ socketId, data: bytes, offsets });
    }
    assertAtEnd(bytes, offset);
    return { format, version, jewelType, seedMinimum, seedMaximum, seedIncrement, seedCount, abyssSize, sockets };
  }

  const nodeCount = readUInt16At(bytes, offset, "ABYN node count");
  offset += 2;
  const nodeIds = [];
  const seenNodes = new Set();
  for (let index = 0; index < nodeCount; index += 1) {
    const nodeId = readUInt16At(bytes, offset, "ABYN node id");
    offset += 2;
    if (seenNodes.has(nodeId)) {
      throw new Error(`Duplicate ABYN node id ${nodeId}.`);
    }
    seenNodes.add(nodeId);
    nodeIds.push(nodeId);
  }
  const nodes = [];
  for (const nodeId of nodeIds) {
    const offsets = new Uint32Array(seedCount + 1);
    for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
      offsets[seedIndex] = offset;
      offset = skipModification(bytes, offset);
    }
    offsets[seedCount] = offset;
    nodes.push({ nodeId, data: bytes, offsets });
  }
  ensureAvailable(bytes, offset, 4, "ABYN ascendancy marker");
  if (ascii(bytes, offset, 4) !== "ASCS") {
    throw new Error("Missing ABYN ascendancy section.");
  }
  offset += 4;
  const ascendancyCount = readUInt16At(bytes, offset, "ABYN ascendancy count");
  offset += 2;
  const ascendancies = [];
  const seenNames = new Set();
  for (let index = 0; index < ascendancyCount; index += 1) {
    ensureAvailable(bytes, offset, 1, "ABYN ascendancy name length");
    const nameLength = bytes[offset];
    offset += 1;
    ensureAvailable(bytes, offset, nameLength, "ABYN ascendancy name");
    const name = textDecoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    if (!name || seenNames.has(name)) {
      throw new Error(`Invalid or duplicate ABYN ascendancy name ${JSON.stringify(name)}.`);
    }
    seenNames.add(name);
    const offsets = new Uint32Array(seedCount + 1);
    for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
      offsets[seedIndex] = offset;
      offset = skipAscendancyRecord(bytes, offset);
    }
    offsets[seedCount] = offset;
    ascendancies.push({ name, data: bytes, offsets });
  }
  assertAtEnd(bytes, offset);
  return { format, version, jewelType, seedMinimum, seedMaximum, seedIncrement, seedCount, nodes, ascendancies };
}

/**
 * @param {ReturnType<typeof parseAbyssLookup>} lookup
 * @param {{ seedStartIndex: number, seedCount: number, socketId?: number }} options
 */
export function encodeAbyssLookupSlice(lookup, options) {
  const start = options.seedStartIndex;
  const count = options.seedCount;
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1 || start + count > lookup.seedCount) {
    throw new Error("Abyss lookup slice is outside the source seed range.");
  }
  const seedMinimum = lookup.seedMinimum + start * lookup.seedIncrement;
  const seedMaximum = seedMinimum + (count - 1) * lookup.seedIncrement;
  /** @type {Uint8Array[]} */
  const chunks = [encodeHeader(lookup.format, lookup.jewelType, seedMinimum, seedMaximum, lookup.seedIncrement)];

  if (lookup.format === FORMAT_ABYS) {
    const socket = lookup.sockets.find((entry) => entry.socketId === options.socketId);
    if (!socket) {
      throw new Error(`ABYS lookup does not contain socket ${String(options.socketId)}.`);
    }
    chunks.push(Uint8Array.of(1, lookup.abyssSize), encodeUInt16(socket.socketId));
    chunks.push(...sliceRecords(socket, start, count));
    return concatBytes(chunks);
  }

  chunks.push(encodeUInt16(lookup.nodes.length));
  for (const node of lookup.nodes) {
    chunks.push(encodeUInt16(node.nodeId));
  }
  for (const node of lookup.nodes) {
    chunks.push(...sliceRecords(node, start, count));
  }
  chunks.push(textEncoder.encode("ASCS"), encodeUInt16(lookup.ascendancies.length));
  for (const ascendancy of lookup.ascendancies) {
    const name = textEncoder.encode(ascendancy.name);
    if (name.length > 0xff) {
      throw new Error(`ABYN ascendancy name is too long: ${ascendancy.name}.`);
    }
    chunks.push(Uint8Array.of(name.length), name, ...sliceRecords(ascendancy, start, count));
  }
  return concatBytes(chunks);
}

/**
 * @param {ReturnType<typeof parseAbyssLookup>} lookup
 * @param {{ seed: number, socketId?: number }} options
 */
export function buildAbyssMiniatureLookup(lookup, options) {
  const seedIndex = getAbyssSeedIndex(lookup, options.seed);
  return encodeAbyssLookupSlice(lookup, { seedStartIndex: seedIndex, seedCount: 1, socketId: options.socketId });
}

/** Combine complete one-seed miniatures into a native regular-seed archive.
 * ABYS requires the real socket x seed cross product; missing records fail closed.
 * @param {Uint8Array[]} archives
 */
export function combineAbyssMiniatures(archives) {
  const lookups = archives.map(parseAbyssLookup);
  const first = lookups[0];
  if (!first || lookups.some(l => l.jewelType !== first.jewelType || l.format !== first.format || l.seedCount !== 1)) {
    throw new Error("Expected one-seed Abyss records from one family.");
  }
  const seeds = [...new Set(lookups.map(l => l.seedMinimum))].sort((a, b) => a - b);
  const increment = seeds.length > 1 ? seeds[1] - seeds[0] : 1;
  if (seeds.some((seed, i) => seed !== seeds[0] + i * increment)) throw new Error("Abyss seeds are not an arithmetic progression.");
  /** @type {Uint8Array[]} */
  const chunks = [encodeHeader(first.format, first.jewelType, seeds[0], seeds[seeds.length - 1], increment)];
  if (first.format === "ABYS") {
    const sources = /** @type {AbysLookup[]} */ (lookups);
    const sockets = [...new Set(sources.flatMap(l => l.sockets.map(s => s.socketId)))].sort((a, b) => a - b);
    if (sockets.length > 255 || sources.some(l => l.abyssSize !== first.abyssSize)) throw new Error("Inconsistent Abyss socket metadata.");
    chunks.push(Uint8Array.of(sockets.length, first.abyssSize), ...sockets.map(encodeUInt16));
    for (const socket of sockets) for (const seed of seeds) {
      const entry = sources.find(l => l.seedMinimum === seed && l.sockets.some(s => s.socketId === socket))?.sockets.find(s => s.socketId === socket);
      if (!entry) throw new Error("Missing Abyss socket/seed record.");
      chunks.push(...sliceRecords(entry, 0, 1));
    }
  } else {
    const sources = /** @type {AbynLookup[]} */ (lookups);
    if (sources.some(l => l.nodes.map(n => n.nodeId).join() !== first.nodes.map(n => n.nodeId).join() ||
      l.ascendancies.map(a => a.name).join() !== first.ascendancies.map(a => a.name).join())) throw new Error("Inconsistent Abyss node metadata.");
    chunks.push(encodeUInt16(first.nodes.length), ...first.nodes.map(n => encodeUInt16(n.nodeId)));
    const bySeed = seeds.map(seed => {
      const source = sources.find(l => l.seedMinimum === seed);
      if (!source) throw new Error("Missing Abyss seed record.");
      return source;
    });
    for (const [i] of first.nodes.entries()) for (const source of bySeed) chunks.push(...sliceRecords(source.nodes[i], 0, 1));
    chunks.push(textEncoder.encode("ASCS"), encodeUInt16(first.ascendancies.length));
    for (const [i, ascendancy] of first.ascendancies.entries()) {
      const name = textEncoder.encode(ascendancy.name);
      chunks.push(Uint8Array.of(name.length), name);
      for (const source of bySeed) chunks.push(...sliceRecords(source.ascendancies[i], 0, 1));
    }
  }
  return concatBytes(chunks);
}

/** @param {{ seedMinimum: number, seedMaximum: number, seedIncrement: number }} lookup @param {number} seed */
export function getAbyssSeedIndex(lookup, seed) {
  const delta = seed - lookup.seedMinimum;
  if (!Number.isInteger(seed) || delta < 0 || seed > lookup.seedMaximum || delta % lookup.seedIncrement !== 0) {
    throw new Error(`Abyss lookup does not contain seed ${String(seed)}.`);
  }
  return delta / lookup.seedIncrement;
}

/** @param {Uint8Array} bytes @param {number} offset */
export function skipAbyssModification(bytes, offset) {
  return skipModification(asBytes(bytes), offset);
}

/** @param {Uint8Array} bytes @param {number} offset */
function skipModification(bytes, offset) {
  ensureAvailable(bytes, offset, 1, "Abyss modification component count");
  const componentCount = bytes[offset];
  offset += 1;
  for (let index = 0; index < componentCount; index += 1) {
    ensureAvailable(bytes, offset, 3, "Abyss modification component");
    const statCount = bytes[offset + 2];
    offset += 3;
    ensureAvailable(bytes, offset, statCount * 2, "Abyss modification rolls");
    offset += statCount * 2;
  }
  return offset;
}

/** @param {Uint8Array} bytes @param {number} offset */
function skipSocketRecord(bytes, offset) {
  ensureAvailable(bytes, offset, 1, "ABYS affected node count");
  const affectedNodeCount = bytes[offset];
  offset += 1;
  for (let index = 0; index < affectedNodeCount; index += 1) {
    ensureAvailable(bytes, offset, 2, "ABYS affected node id");
    offset = skipModification(bytes, offset + 2);
  }
  return offset;
}

/** @param {Uint8Array} bytes @param {number} offset */
function skipAscendancyRecord(bytes, offset) {
  ensureAvailable(bytes, offset, 1, "ABYN selected node count");
  const selectedCount = bytes[offset];
  ensureAvailable(bytes, offset + 1, selectedCount * 2, "ABYN selected node ids");
  return offset + 1 + selectedCount * 2;
}

/** @param {"ABYS" | "ABYN"} format @param {number} jewelType @param {number} seedMinimum @param {number} seedMaximum @param {number} seedIncrement */
function encodeHeader(format, jewelType, seedMinimum, seedMaximum, seedIncrement) {
  return concatBytes([
    textEncoder.encode(format),
    Uint8Array.of(FORMAT_VERSION, jewelType),
    encodeUInt16(seedMinimum),
    encodeUInt16(seedMaximum),
    encodeUInt16(seedIncrement),
  ]);
}

/** @param {number} value */
function encodeUInt16(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Value ${String(value)} does not fit in an unsigned 16-bit field.`);
  }
  return Uint8Array.of(value & 0xff, value >>> 8);
}

/** @param {Uint8Array} bytes @param {number} offset */
function readUInt16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** @param {Uint8Array} bytes @param {number} offset @param {string} label */
function readUInt16At(bytes, offset, label) {
  ensureAvailable(bytes, offset, 2, label);
  return readUInt16(bytes, offset);
}

/** @param {Uint8Array} bytes @param {number} offset @param {number} length */
function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** @param {Uint8Array} bytes @param {number} offset */
function assertAtEnd(bytes, offset) {
  if (offset !== bytes.length) {
    throw new Error(`Abyss lookup parser stopped at ${offset} of ${bytes.length} bytes.`);
  }
}

/** @param {Uint8Array} bytes @param {number} offset @param {number} length @param {string} label */
function ensureAvailable(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`Truncated ${label} at byte ${String(offset)}.`);
  }
}

/** @param {unknown} input @returns {Uint8Array} */
function asBytes(input) {
  if (!(input instanceof Uint8Array)) {
    throw new Error("Abyss lookup input must be a Uint8Array.");
  }
  return input;
}

/** @param {RecordIndex} entry @param {number} start @param {number} count */
function sliceRecords(entry, start, count) {
  return [entry.data.subarray(entry.offsets[start], entry.offsets[start + count])];
}

/** @param {Uint8Array[]} chunks */
function concatBytes(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!Number.isSafeInteger(size)) {
    throw new Error("Abyss lookup output is too large.");
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
