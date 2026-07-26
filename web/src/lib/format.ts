export function eth(n: number, digits = 4): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Enough decimals that a non-zero amount never prints as zero.
 *
 * Fixed precision breaks at both ends of this pool's range. At one decimal a
 * pool holding 0.03 ETH rendered "0.0 ETH in pool" directly beside "3 unspent
 * notes" — the page contradicting itself, and reading as broken rather than as
 * small. At four decimals a pool holding twelve thousand would print digits
 * nobody needs.
 *
 * So: two significant figures for anything under 1, coarser above it, and a
 * non-zero balance is never rounded down to nothing.
 */
export function ethAuto(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000) return eth(n, 0);
  if (abs >= 1) return eth(n, 2);
  return eth(n, Math.min(8, Math.ceil(-Math.log10(abs)) + 1));
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
