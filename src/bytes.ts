/** Bytes as a person reads them. Decimal units, because disk vendors and `df` both use them. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
