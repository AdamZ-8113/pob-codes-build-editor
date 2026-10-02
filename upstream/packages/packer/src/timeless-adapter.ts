/** Exact pinned-source adaptation; never edit the app-owned PoB checkout. */
export function sparseTimelessSeeds(source: string, helper: string): string {
  source = source.replaceAll("\r\n", "\n");
  helper = helper.replaceAll("\r\n", "\n");
  const once = (needle: string, replacement: string) => {
    if (source.split(needle).length !== 2) throw new Error("Timeless seed adapter: source interface changed");
    source = source.replace(needle, replacement);
  };
  const later = '\t\t\tlocal count = 0\n'
    + '\t\t\tfor seedOffset = 1, (seedSize + 1) do\n'
    + '\t\t\t\tlocal dataLength = data.timelessJewelLUTs[jewelType].sizes:byte(nodeIndex * seedSize + seedOffset)\n'
    + '\t\t\t\tdata.timelessJewelLUTs[jewelType].data[nodeIndex + 1][seedOffset] = jewelData:sub(count + 1, count + dataLength)\n'
    + '\t\t\t\tcount = count + dataLength\n\t\t\tend\n'
    + '\t\t\tdata.timelessJewelLUTs[jewelType].data[nodeIndex + 1].raw = nil';
  once(later, '\t\t\tdata.timelessJewelLUTs[jewelType].data[nodeIndex + 1] = desktopSparseTimelessSeeds(jewelData, data.timelessJewelLUTs[jewelType].sizes, nodeIndex, seedSize)');
  const first = '\t\t\t\t\tlocal seedOffset = 0\n'
    + '\t\t\t\t\tfor seedKey = 1, (seedSize + 1) do\n'
    + '\t\t\t\t\t\tlocal dataLength = data.timelessJewelLUTs[jewelType].sizes:byte(nodeIndex * seedSize + seedKey)\n'
    + '\t\t\t\t\t\tdata.timelessJewelLUTs[jewelType].data[nodeIndex + 1][seedKey] = jewelData2:sub(seedOffset + 1, seedOffset + dataLength)\n'
    + '\t\t\t\t\t\tseedOffset = seedOffset + dataLength\n\t\t\t\t\tend\n'
    + '\t\t\t\t\tdata.timelessJewelLUTs[jewelType].data[i].raw = nil';
  once(first, '\t\t\t\t\tdata.timelessJewelLUTs[jewelType].data[i] = desktopSparseTimelessSeeds(jewelData2, data.timelessJewelLUTs[jewelType].sizes, i - 1, seedSize)');
  if (!helper.trimEnd().endsWith("return desktopSparseTimelessSeeds")) throw new Error("Timeless seed helper contract changed");
  return `local desktopSparseTimelessSeeds = (function()\n${helper}\nend)()\n${source}`;
}

export function guardJewelInflate(source: string, helper: string): string {
  source = source.replaceAll("\r\n", "\n");
  const original = "\tlocal jewelData = Inflate(compressedData)\n";
  if (source.split(original).length !== 2 || source.includes("desktopInflateTimelessData")) {
    throw new Error("Timeless inflate adapter: source interface changed");
  }
  return `local desktopInflateTimelessData = (function()\n${helper}\nend)()\n`
    + source.replace(original, "\tlocal jewelData = desktopInflateTimelessData(compressedData)\n");
}
