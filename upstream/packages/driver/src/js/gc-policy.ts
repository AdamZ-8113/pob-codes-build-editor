// 400 restores PoB's unmodified policy; helpers already collect between chunks.
export function runtimeGcPause(search: string, role: 'ui' | 'helper'): number {
  const fallback = role === 'ui' ? 100 : 400;
  const value = new URLSearchParams(search).get(role === 'ui' ? 'gcPause' : 'helperGcPause');
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const pause = Number(value);
  return Number.isInteger(pause) && pause >= 100 && pause <= 400 ? pause : fallback;
}
