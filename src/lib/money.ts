/** Money is DECIMAL(12,2) in the database and arrives as a string. All arithmetic is in BigInt minor units; no floats anywhere. */
export type Minor = bigint

export function parseMoney(s: string): Minor {
  const m = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) throw new RangeError('invalid money amount')
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -v : v
}
export function formatMoney(v: Minor): string {
  const neg = v < 0n, a = neg ? -v : v
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`
}
/** percent in basis points (1% = 100), half-up on the absolute value so credit notes mirror invoices. */
export function percentOf(v: Minor, basisPoints: number): Minor {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new RangeError('invalid rate')
  const neg = v < 0n, a = neg ? -v : v
  const r = (a * BigInt(basisPoints) + 5_000n) / 10_000n
  return neg ? -r : r
}
export const sum = (xs: readonly Minor[]): Minor => xs.reduce((a, b) => a + b, 0n)
/** The current frontend contract is whole units: only convert when the value is exactly whole, otherwise surface the fraction (never round silently). */
export function toWholeUnits(v: Minor): number {
  if (v % 100n !== 0n) throw new RangeError('amount has a fractional part; frontend contract is whole units')
  const n = v / 100n
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(-Number.MAX_SAFE_INTEGER)) throw new RangeError('amount too large')
  return Number(n)
}
