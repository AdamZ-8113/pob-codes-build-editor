// Acceptance only. PoB saves these named maps with Lua pairs(), whose order
// varies between fresh Lua states. All values and every ordered list survive.
// Source: Build:SaveDB, ConfigTab:Save, CalcsTab:Save, ItemsTab:Save, PassiveSpec:Save.
export function canonicalExportTree(node) {
  if (typeof node === 'string') return node;
  const [tag, attributes, children] = node;
  const result = children.map(canonicalExportTree);
  const key = child => {
    if (typeof child === 'string') return undefined;
    const attrs = Object.fromEntries(child[1]);
    if (tag === 'PathOfBuilding') return child[0];
    if (tag === 'ConfigSet' && ['Input','Placeholder'].includes(child[0])) return child[0] + ':' + attrs.name;
    if (tag === 'Calcs' && child[0] === 'Input') return child[0] + ':' + attrs.name;
    if (tag === 'ItemSet' && ['Slot','SocketIdURL'].includes(child[0])) return child[0] + ':' + attrs.name;
    if (tag === 'Sockets' && child[0] === 'Socket') return child[0] + ':' + attrs.nodeId;
  };
  const mapped = result.filter(child => key(child) !== undefined);
  const keys = mapped.map(key);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate exported map identity: ' + tag);
  mapped.sort((a,b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  let index = 0;
  return [tag, [...attributes].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0),
    result.map(child => key(child) === undefined ? child : mapped[index++])];
}
