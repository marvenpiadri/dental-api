/** DB time format: UTC 'YYYY-MM-DD HH:MM:SS.mmm'. Times are always passed as parameters (never NOW()) so tests and SQL stay deterministic. */
export const toDb = (d: Date | number): string => new Date(d).toISOString().replace('T', ' ').replace('Z', '')
export const fromDb = (s: string): number => Date.parse(s.replace(' ', 'T') + 'Z')
