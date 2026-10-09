export type TooltipOperation = { name: 'AddLine' | 'AddSeparator'; args: (string | number | boolean)[] };
export type ItemComparisonJob = {
  identity: string;
  xml: string;
  uiBytes: number;
  item: { raw: string; id?: number };
  slot?: string;
  options: Record<string, string | number | boolean>;
};

// Only primitive tooltip operations cross the worker boundary. PoB owns the
// calculation, wording, ordering and number formatting.
export function isTooltipOperations(value: unknown): value is TooltipOperation[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(op =>
    op && (op.name === 'AddLine' || op.name === 'AddSeparator') && Array.isArray(op.args) &&
    op.args.length >= 1 && op.args.length <= 4 && op.args.every((arg: unknown) =>
      typeof arg === 'string' || typeof arg === 'boolean' || typeof arg === 'number' && Number.isFinite(arg)));
}
