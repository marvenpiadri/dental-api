/**
 * Structural validation of a chart payload (the frontend's ChartPayload: { version, globals, teeth, plan?, case? }).
 * The server does not interpret clinical meaning and never rewrites the payload: it either stores it exactly as sent or refuses it.
 * It checks what a corrupt or hostile client could break: type, size, version format, tooth numbers, and that every tooth is an object.
 * UNVERIFIED against payloads from the real chart engine: add fixtures exported from the frontend (docs §13g).
 */
export const MAX_CHART_BYTES = 512_000
const FDI = /^(?:[1-4][1-8]|[5-8][1-5])$/ // permanent 11–48, primary 51–85
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export class ChartError extends Error {}
export function validateChart(raw: unknown): { json: string; version: string } {
  if (!isRec(raw)) throw new ChartError('chart must be an object')
  const json = JSON.stringify(raw)
  if (json.length > MAX_CHART_BYTES) throw new ChartError('chart is too large')
  if (typeof raw.version !== 'string' || !/^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(raw.version)) throw new ChartError('chart.version must look like "2.22"')
  if (!isRec(raw.teeth)) throw new ChartError('chart.teeth is required')
  for (const section of ['teeth', 'plan'] as const) {
    const s = raw[section]; if (s === undefined) continue
    if (!isRec(s)) throw new ChartError(`chart.${section} must be an object`)
    for (const [k, v] of Object.entries(s)) if (!FDI.test(k) || !isRec(v)) throw new ChartError(`chart.${section}.${k} is not a valid tooth record`)
  }
  if (raw.globals !== undefined) { if (!isRec(raw.globals) || Object.values(raw.globals).some((v) => typeof v !== 'boolean')) throw new ChartError('chart.globals must hold booleans') }
  return { json, version: raw.version }
}
