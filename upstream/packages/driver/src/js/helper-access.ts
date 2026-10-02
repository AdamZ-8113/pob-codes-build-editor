import type { RpcResult } from './rpc.ts';

// Each helper owns its descriptors. No user storage or host side effects.
export class HelperAccess {
  private descriptors = new Set<number>();
  private closed = false;
  constructor(private dispatch: (operation: string, args: unknown[], data?: Uint8Array) => Promise<RpcResult>) {}
  async handle(operation: string, args: unknown[], data?: Uint8Array): Promise<RpcResult> {
    if (this.closed) throw new Error('Helper port closed');
    const path = args[0];
    const root = typeof path === 'string' && (path === '/root' || path.startsWith('/root/')) &&
      !path.includes('\\') && !path.includes('\0') && !path.split('/').some(p => p === '.' || p === '..');
    if (operation === 'open') {
      if (!root || args[1] !== 'r') throw new Error('Helper access denied');
      const result = await this.dispatch(operation, args, data);
      if (this.closed) {
        await this.dispatch('close', [result.value]).catch(() => {});
        throw new Error('Helper port closed');
      }
      this.descriptors.add(result.value as number); return result;
    }
    if (['stat', 'lstat', 'readdir'].includes(operation) && root) return this.dispatch(operation, args, data);
    if (['read', 'fstat', 'close'].includes(operation) && this.descriptors.has(path as number)) {
      const result = await this.dispatch(operation, args, data);
      if (operation === 'close') this.descriptors.delete(path as number);
      return result;
    }
    throw new Error('Helper access denied');
  }
  async close() {
    this.closed = true;
    for (const fd of this.descriptors) await this.dispatch('close', [fd]).catch(() => {});
    this.descriptors.clear();
  }
}
