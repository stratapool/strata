export function eth(n: number, digits = 4): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function count(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Enough decimals to name the denomination exactly.
 *
 * A fixed one decimal place printed the deployed 0.01 pool as "0.0" — a size
 * the contract would reject, shown as if it were the one it accepts.
 */
export function denomLabel(d: number): string {
  if (Number.isInteger(d)) return String(d);
  return d.toString();
}

export function shortAddr(a: string): string {
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function pct(n: number, digits = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
