import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { basename, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSha256, sha256 } from "./release-common.mjs";

const MAX_FILES = 18_500;
const MAX_BYTES = 1_275 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_BYTES + 64 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = MAX_BYTES + MAX_FILES * 2048 + 2 * 1024 * 1024;

function safeRelativePath(value, { directory = false } = {}) {
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (!path || path.startsWith("/") || path.includes("\\") || /[\0-\x1f\x7f]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..") || posix.normalize(path) !== path) {
    throw new Error(`Unsafe candidate archive path: ${JSON.stringify(value)}`);
  }
  return path;
}

function tarString(block, offset, length) {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function tarNumber(block, offset, length, label) {
  const bytes = block.subarray(offset, offset + length);
  if (bytes[0] & 0x80) throw new Error(`Candidate archive uses unsupported base-256 ${label}`);
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`Candidate archive has invalid ${label}`);
  return text ? Number.parseInt(text, 8) : 0;
}

function tarHeader(block) {
  const expectedChecksum = tarNumber(block, 148, 8, "checksum");
  let actualChecksum = 0;
  for (let index = 0; index < block.length; index++) actualChecksum += index >= 148 && index < 156 ? 32 : block[index];
  if (expectedChecksum !== actualChecksum) throw new Error("Candidate archive header checksum mismatch");
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  return {
    path: prefix ? `${prefix}/${name}` : name,
    size: tarNumber(block, 124, 12, "entry size"),
    type: String.fromCharCode(block[156] || 48),
  };
}

function parsePax(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("Candidate archive has malformed PAX metadata");
    const length = Number.parseInt(bytes.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new Error("Candidate archive has malformed PAX record length");
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("Candidate archive has malformed PAX field");
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

function validateInventory(inventory) {
  if (inventory?.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(inventory.generation ?? "") || !Array.isArray(inventory.files)) {
    throw new Error("Candidate inventory metadata is invalid");
  }
  if (inventory.files.length >= MAX_FILES) throw new Error("Candidate inventory exceeds the file-count limit");
  const expected = new Map();
  let bytes = 0;
  for (const file of inventory.files) {
    const path = safeRelativePath(file?.path ?? "");
    if (expected.has(path)) throw new Error(`Candidate inventory contains duplicate path: ${path}`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) {
      throw new Error(`Candidate inventory entry is invalid: ${path}`);
    }
    expected.set(path, file);
    bytes += file.bytes;
  }
  if (bytes > MAX_BYTES || inventory.totals?.files !== expected.size || inventory.totals?.bytes !== bytes) {
    throw new Error("Candidate inventory totals are invalid");
  }
  return expected;
}

async function verifyTar(archiveFile, inventoryBytes, inventory) {
  const expected = validateInventory(inventory);
  const seen = new Set();
  const archivePaths = new Set();
  let buffer = Buffer.alloc(0);
  let current = null;
  let pendingPax = null;
  let zeroBlocks = 0;
  let ended = false;
  let expandedBytes = 0;
  let entries = 0;

  const finishEntry = () => {
    if (current.kind === "pax") {
      const fields = parsePax(Buffer.concat(current.bytes));
      if (fields.linkpath || fields.size) throw new Error("Candidate archive PAX metadata changes a link or size");
      pendingPax = fields;
    } else if (current.kind === "file") {
      const digest = current.hash.digest("hex");
      if (current.embeddedInventory) {
        const bytes = Buffer.concat(current.bytes);
        if (!bytes.equals(inventoryBytes)) throw new Error("Candidate archive contains a different release inventory");
      } else if (digest !== current.expected.sha256 || current.size !== current.expected.bytes) {
        throw new Error(`Candidate archive file differs from inventory: ${current.inventoryPath}`);
      }
    }
    current = null;
  };

  const beginEntry = header => {
    entries++;
    if (entries > MAX_FILES * 3) throw new Error("Candidate archive contains too many entries");
    const path = pendingPax?.path ?? header.path;
    pendingPax = null;
    if (header.type === "x") {
      if (header.size > 64 * 1024) throw new Error("Candidate archive PAX metadata is too large");
      current = { kind: "pax", remaining: header.size, padding: (512 - header.size % 512) % 512, bytes: [] };
      return;
    }
    if (header.type === "g") throw new Error("Candidate archive contains unsupported global PAX metadata");
    if (header.type === "5") {
      const directory = safeRelativePath(path, { directory: true });
      if (directory !== "import2-release" && !directory.startsWith("import2-release/")) throw new Error(`Unexpected candidate archive directory: ${path}`);
      if (archivePaths.has(directory)) throw new Error(`Candidate archive contains duplicate path: ${directory}`);
      archivePaths.add(directory);
      current = { kind: "directory", remaining: header.size, padding: (512 - header.size % 512) % 512 };
      if (header.size !== 0) throw new Error(`Candidate archive directory has content: ${path}`);
      return;
    }
    if (header.type !== "0") throw new Error(`Candidate archive contains unsupported entry type ${header.type}: ${path}`);
    const safePath = safeRelativePath(path);
    if (archivePaths.has(safePath)) throw new Error(`Candidate archive contains duplicate path: ${safePath}`);
    archivePaths.add(safePath);
    seen.add(safePath);
    if (safePath === "release-inventory.json") {
      if (header.size !== inventoryBytes.length) throw new Error("Candidate archive inventory size mismatch");
      current = { kind: "file", embeddedInventory: true, bytes: [], hash: createHash("sha256"), size: header.size,
        remaining: header.size, padding: (512 - header.size % 512) % 512 };
      return;
    }
    if (!safePath.startsWith("import2-release/")) throw new Error(`Unexpected candidate archive file: ${safePath}`);
    const inventoryPath = safePath.slice("import2-release/".length);
    const expectedFile = expected.get(inventoryPath);
    if (!expectedFile) throw new Error(`Candidate archive file is absent from inventory: ${inventoryPath}`);
    if (header.size !== expectedFile.bytes) throw new Error(`Candidate archive file size differs from inventory: ${inventoryPath}`);
    current = { kind: "file", embeddedInventory: false, bytes: [], hash: createHash("sha256"), size: header.size,
      expected: expectedFile, inventoryPath, remaining: header.size, padding: (512 - header.size % 512) % 512 };
  };

  for await (const chunk of createReadStream(archiveFile).pipe(createGunzip())) {
    expandedBytes += chunk.length;
    if (expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES) throw new Error("Candidate archive exceeds its expanded size budget");
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length) {
      if (ended) {
        if (buffer.some(byte => byte !== 0)) throw new Error("Candidate archive contains data after its end marker");
        buffer = Buffer.alloc(0);
        continue;
      }
      if (!current) {
        if (buffer.length < 512) break;
        const block = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (block.every(byte => byte === 0)) {
          zeroBlocks++;
          if (zeroBlocks === 2) ended = true;
          continue;
        }
        if (zeroBlocks) throw new Error("Candidate archive has a malformed end marker");
        beginEntry(tarHeader(block));
        if (current.remaining === 0 && current.padding === 0) finishEntry();
        continue;
      }
      if (current.remaining) {
        const length = Math.min(current.remaining, buffer.length);
        const bytes = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        current.remaining -= length;
        if (current.kind === "file") {
          current.hash.update(bytes);
          if (current.embeddedInventory) current.bytes.push(bytes);
        } else if (current.kind === "pax") current.bytes.push(bytes);
        if (current.remaining) continue;
      }
      if (current.padding) {
        const length = Math.min(current.padding, buffer.length);
        const padding = buffer.subarray(0, length);
        if (padding.some(byte => byte !== 0)) throw new Error("Candidate archive contains non-zero entry padding");
        buffer = buffer.subarray(length);
        current.padding -= length;
        if (current.padding) continue;
      }
      finishEntry();
    }
  }
  if (current || buffer.length || !ended) throw new Error("Candidate archive is truncated");
  if (!seen.has("release-inventory.json")) throw new Error("Candidate archive is missing its embedded inventory");
  for (const path of expected.keys()) {
    if (!seen.has(`import2-release/${path}`)) throw new Error(`Candidate archive is missing inventory file: ${path}`);
  }
  return { files: expected.size, bytes: inventory.totals.bytes };
}

async function requireRegularFile(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Candidate path is not a regular file: ${path}`);
}

export async function discoverCandidateBundle(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map(entry => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["release-assets", "release-inventory.json", "release-record.json"])) {
    throw new Error("Candidate bundle must contain only release-assets, release-inventory.json, and release-record.json");
  }
  const assets = join(root, "release-assets");
  if (!entries.find(entry => entry.name === "release-assets")?.isDirectory()) throw new Error("Candidate release-assets path is not a directory");
  const assetEntries = await readdir(assets, { withFileTypes: true });
  if (assetEntries.length !== 1 || !assetEntries[0].isFile() || assetEntries[0].isSymbolicLink() || !assetEntries[0].name.endsWith(".tar.gz")) {
    throw new Error("Candidate release-assets must contain exactly one regular tar.gz archive");
  }
  return {
    recordFile: join(root, "release-record.json"),
    inventoryFile: join(root, "release-inventory.json"),
    archiveFile: join(assets, assetEntries[0].name),
  };
}

export async function verifyReleaseCandidate({ recordFile, inventoryFile, archiveFile, targetSha }) {
  await Promise.all([recordFile, inventoryFile, archiveFile].map(requireRegularFile));
  const archiveStat = await lstat(archiveFile);
  if (archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error("Candidate archive exceeds its compressed size budget");
  const [recordBytes, inventoryBytes] = await Promise.all([readFile(recordFile), readFile(inventoryFile)]);
  const record = JSON.parse(recordBytes);
  const inventory = JSON.parse(inventoryBytes);
  if (record?.schemaVersion !== 1 || record.contractVersion !== 2 || !/^[a-f0-9]{24}$/.test(record.generation ?? "") ||
      record.predecessor !== null || !/^[a-f0-9]{40}$/.test(record.publicCommit ?? "")) {
    throw new Error("Candidate release record identity is invalid");
  }
  if (targetSha && record.publicCommit !== targetSha) throw new Error("Candidate public commit does not match the requested SHA");
  if (inventory.generation !== record.generation || record.inventorySha256 !== sha256(inventoryBytes)) {
    throw new Error("Candidate inventory is not bound to the release record");
  }
  if (!record.archive || record.archive.filename !== basename(archiveFile) || !/^[a-f0-9]{64}$/.test(record.archive.sha256 ?? "") ||
      record.archive.sha256 !== await fileSha256(archiveFile)) {
    throw new Error("Candidate archive is not bound to the release record");
  }
  const measured = await verifyTar(archiveFile, inventoryBytes, inventory);
  return { record, inventory, ...measured, archiveBytes: archiveStat.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = value("bundle-root");
  const files = root ? await discoverCandidateBundle(resolve(root)) : {
    recordFile: resolve(value("record") ?? ".runtime/release-record.json"),
    inventoryFile: resolve(value("inventory") ?? ".runtime/release-inventory.json"),
    archiveFile: resolve(value("archive") ?? join(".runtime/release-assets", JSON.parse(await readFile(value("record") ?? ".runtime/release-record.json", "utf8")).archive.filename)),
  };
  const verified = await verifyReleaseCandidate({ ...files, targetSha: value("sha") || process.env.GITHUB_SHA });
  console.log(`Verified unchanged candidate ${verified.record.generation}: ${verified.files} files, ${verified.bytes} bytes, archive ${verified.record.archive.sha256}.`);
}
