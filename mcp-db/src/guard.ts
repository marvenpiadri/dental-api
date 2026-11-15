/** SQL guards. Defence in depth only: the real protection is a DB user whose grants cover just the test database. */
const stripTrailing = (s: string) => s.trim().replace(/;+\s*$/, '')
export function singleStatement(sql: string): string {
  const s = stripTrailing(sql)
  if (!s || s.length > 20_000) throw new Error('empty or too long')
  if (s.includes(';')) throw new Error('one statement per call')
  return s
}
const first = (s: string) => /^\s*(?:\/\*.*?\*\/\s*)*([a-z]+)/is.exec(s)?.[1]?.toLowerCase() ?? ''
export function readOnly(sql: string): string {
  const s = singleStatement(sql)
  if (!['select', 'show', 'describe', 'desc', 'explain'].includes(first(s))) throw new Error('read tool only accepts SELECT / SHOW / DESCRIBE / EXPLAIN')
  if (/\binto\s+(?:outfile|dumpfile)\b|\bfor\s+update\b/i.test(s)) throw new Error('not allowed in a read query')
  return s
}
const WRITE = ['insert', 'update', 'delete', 'replace', 'create', 'alter', 'truncate', 'drop']
export function writable(sql: string): string {
  const s = singleStatement(sql)
  if (!WRITE.includes(first(s))) throw new Error('write tool accepts INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/TRUNCATE/DROP TABLE only')
  if (/\bdrop\s+(?:database|schema|user)\b|\b(?:grant|revoke)\b|\bcreate\s+(?:user|database|schema)\b|\b(?:mysql|sys|information_schema|performance_schema)\s*\./i.test(s)) throw new Error('statement touches users, grants, databases or system schemas')
  return s
}
export function safeEqual(a: string, b: string): boolean {
  const e = new TextEncoder(), x = e.encode(a), y = e.encode(b)
  let d = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return d === 0
}
