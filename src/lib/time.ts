/** Instants cross the SQL boundary as Date (timestamptz) and come back as ISO strings (see db/client.ts). */
export const toDb = (d: Date | number): Date => new Date(d)
export const fromDb = (s: string): number => Date.parse(s)
