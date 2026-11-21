/**
 * Chart storage and the only ways to change it (docs/postgres-architecture.md §4). A chart is one row per tooth (the whole tooth
 * record: odontogram and periodontal fields) per scope ('teeth' | 'plan'), plus 'globals' and 'case' sections. Every row has a
 * revision number; every change is checked against the revision the client saw and logged (before + after) in the same transaction.
 * The server never interprets clinical meaning: it stores what it is sent, or refuses it.
 */
import { ApiError } from '../http/errors'
import type { Db } from '../db/client'
import { newId } from '../lib/ids'
import { toDb } from '../lib/time'

export const FDI = /^(?:[1-4][1-8]|[5-8][1-5])$/
export const MAX_TOOTH_BYTES = 32_000, MAX_SECTION_BYTES = 64_000, MAX_CHANGES = 120, MAX_CHART_BYTES = 600_000
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (m: string) => new ApiError(422, 'bad_chart', m)
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export type Scope = 'teeth' | 'plan' | 'globals' | 'case'
export type Change = { scope: Scope; tooth?: string; expectedRev: number; set?: Record<string, unknown>; unset?: string[]; replace?: Record<string, unknown>; clear?: boolean }
export type Chart = { version: string; globals: Record<string, unknown>; teeth: Record<string, unknown>; plan?: Record<string, unknown>; case?: unknown }

const sizeOf = (v: unknown) => JSON.stringify(v).length
function obj(v: unknown, what: string, max: number): Record<string, unknown> {
  if (!isRec(v)) throw bad(`${what} must be an object`)
  for (const k of Object.keys(v)) if (!SAFE_KEY.test(k)) throw bad(`${what} has an invalid key`)
  if (sizeOf(v) > max) throw bad(`${what} is too large`)
  return v
}
export const versionOk = (v: unknown): string => { if (typeof v !== 'string' || !/^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(v)) throw bad('version must look like "2.22"'); return v }

/** Validates a full chart (initial import or an exam snapshot). Structural only. */
export function validateChart(raw: unknown): Chart {
  if (!isRec(raw)) throw bad('chart must be an object')
  if (sizeOf(raw) > MAX_CHART_BYTES) throw bad('chart is too large')
  const version = versionOk(raw.version)
  if (!isRec(raw.teeth)) throw bad('chart.teeth is required')
  const out: Chart = { version, teeth: {}, globals: {} }
  for (const s of ['teeth', 'plan'] as const) {
    const m = raw[s]; if (m === undefined) continue
    if (!isRec(m)) throw bad(`chart.${s} must be an object`)
    const dst: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(m)) { if (!FDI.test(k)) throw bad(`chart.${s}.${k} is not a valid tooth number`); dst[k] = obj(v, `chart.${s}.${k}`, MAX_TOOTH_BYTES) }
    if (s === 'teeth') out.teeth = dst; else out.plan = dst
  }
  if (raw.globals !== undefined) { if (!isRec(raw.globals) || Object.values(raw.globals).some((v) => typeof v !== 'boolean')) throw bad('chart.globals must hold booleans'); out.globals = raw.globals }
  if (raw.case !== undefined && raw.case !== null) { if (sizeOf(raw.case) > MAX_SECTION_BYTES) throw bad('chart.case is too large'); out.case = raw.case }
  return out
}

/** The current chart assembled from its rows, with the revision of every part (what a client sends back as expectedRev). */
export async function loadChart(db: Db, clinicId: string, patientId: string): Promise<{ chart: Chart; revs: { teeth: Record<string, number>; plan: Record<string, number>; globals: number; case: number } } | null> {
  const [h] = await db.rows<{ payload_version: string }>('SELECT payload_version FROM chart_head WHERE patient_id = $1 AND clinic_id = $2', [patientId, clinicId])
  if (!h) return null
  const teeth = await db.rows<{ scope: string; tooth: string; data: Record<string, unknown>; rev: number }>('SELECT scope, tooth, data, rev FROM chart_tooth WHERE patient_id = $1 ORDER BY scope, tooth LIMIT 200', [patientId])
  const sec = await db.rows<{ section: string; data: unknown; rev: number }>('SELECT section, data, rev FROM chart_section WHERE patient_id = $1 LIMIT 4', [patientId])
  const chart: Chart = { version: h.payload_version, globals: {}, teeth: {} }
  const revs = { teeth: {} as Record<string, number>, plan: {} as Record<string, number>, globals: 0, case: 0 }
  for (const t of teeth) { if (t.scope === 'plan') (chart.plan ??= {})[t.tooth] = t.data; else chart.teeth[t.tooth] = t.data; revs[t.scope as 'teeth' | 'plan'][t.tooth] = t.rev }
  for (const s of sec) { if (s.section === 'globals') chart.globals = s.data as Record<string, unknown>; else chart.case = s.data; revs[s.section as 'globals' | 'case'] = s.rev }
  return { chart, revs }
}

async function writeRevision(db: Db, o: { clinicId: string; patientId: string; groupId: string; scope: Scope; tooth: string | null; rev: number; op: string; before: unknown; after: unknown; reason: string | null; staffId: string | null; now: number }) {
  await db.run('INSERT INTO chart_revision (id, clinic_id, patient_id, group_id, scope, tooth, rev, op, before, after, reason, staff_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)',
    [newId(), o.clinicId, o.patientId, o.groupId, o.scope, o.tooth, o.rev, o.op, o.before === null ? null : JSON.stringify(o.before), JSON.stringify(o.after), o.reason, o.staffId, toDb(o.now)])
}

/** Parses the client's change list (shape only; the rules are applied against the stored rows in applyChanges). */
export function parseChanges(raw: unknown): Change[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CHANGES) throw new ApiError(400, 'bad_request', `changes must hold 1 to ${MAX_CHANGES} entries`)
  const seen = new Set<string>()
  return raw.map((c): Change => {
    if (!isRec(c)) throw new ApiError(400, 'bad_request', 'Invalid change')
    const scope = c.scope as Scope
    if (!['teeth', 'plan', 'globals', 'case'].includes(scope)) throw new ApiError(400, 'bad_request', 'Invalid scope')
    if (!Number.isInteger(c.expectedRev) || (c.expectedRev as number) < 0) throw new ApiError(400, 'bad_request', 'expectedRev must be an integer (0 = the part does not exist yet)')
    const tooth = scope === 'teeth' || scope === 'plan' ? String(c.tooth ?? '') : undefined
    if (tooth !== undefined && !FDI.test(tooth)) throw new ApiError(400, 'bad_request', 'Invalid tooth')
    const key = `${scope}:${tooth ?? ''}`; if (seen.has(key)) throw new ApiError(400, 'bad_request', 'Each tooth or section may appear once per request'); seen.add(key)
    const modes = ['set', 'unset', 'replace', 'clear'].filter((m) => c[m] !== undefined)
    if (modes.length !== 1) throw new ApiError(400, 'bad_request', 'Exactly one of set, unset, replace or clear is required')
    const max = tooth ? MAX_TOOTH_BYTES : MAX_SECTION_BYTES
    const ch: Change = { scope, tooth, expectedRev: c.expectedRev as number }
    if (c.set !== undefined) { ch.set = scope === 'case' ? (c.set as Record<string, unknown>) : obj(c.set, 'set', max); if (!isRec(ch.set) || !Object.keys(ch.set).length) throw bad('set must not be empty') }
    if (c.unset !== undefined) { if (!Array.isArray(c.unset) || !c.unset.length || c.unset.some((k) => typeof k !== 'string' || !SAFE_KEY.test(k))) throw bad('unset must list field names'); ch.unset = c.unset as string[] }
    if (c.replace !== undefined) { ch.replace = scope === 'case' ? (c.replace as Record<string, unknown>) : obj(c.replace, 'replace', max); if (!isRec(ch.replace) || !Object.keys(ch.replace).length) throw bad('replace must not be empty; to empty a tooth use clear with a reason') }
    if (c.clear !== undefined) { if (c.clear !== true) throw new ApiError(400, 'bad_request', 'clear must be true'); ch.clear = true }
    if (scope === 'globals') {
      const g = ch.set ?? ch.replace; if (g && Object.values(g).some((v) => typeof v !== 'boolean')) throw bad('globals must hold booleans'); if (ch.clear) throw bad('globals cannot be cleared')
    }
    if (ch.set && sizeOf(ch.set) > max) throw bad('set is too large')
    return ch
  })
}

type Ctx = { clinicId: string; patientId: string; staffId: string | null; now: number; reason: string | null; op?: 'restore' }
const stale = (what: string) => new ApiError(409, 'stale', `${what} was changed by someone else; reload the chart and try again`)

/**
 * Applies changes atomically (all or none). Rules: each row must still be at the revision the client saw; a change can add or alter
 * fields but cannot silently drop existing ones (replace/unset that removes data needs a reason; emptying a tooth needs clear + reason);
 * every applied change is logged with before and after. Returns the new revisions.
 */
export async function applyChanges(db: Db, ctx: Ctx, changes: Change[]): Promise<{ groupId: string; revs: { scope: Scope; tooth: string | null; rev: number }[] }> {
  const groupId = newId(), out: { scope: Scope; tooth: string | null; rev: number }[] = []
  const reason = ctx.reason && ctx.reason.trim().length >= 3 ? ctx.reason.trim() : null
  const ordered = [...changes].sort((a, b) => `${a.scope}:${a.tooth ?? ''}`.localeCompare(`${b.scope}:${b.tooth ?? ''}`)) // fixed lock order: no deadlocks between two saves
  for (const ch of ordered) {
    const isTooth = ch.scope === 'teeth' || ch.scope === 'plan'
    const label = isTooth ? `Tooth ${ch.tooth}${ch.scope === 'plan' ? ' (plan)' : ''}` : `Chart ${ch.scope}`
    const [cur] = isTooth
      ? await db.rows<{ data: unknown; rev: number }>('SELECT data, rev FROM chart_tooth WHERE patient_id = $1 AND scope = $2 AND tooth = $3 FOR UPDATE', [ctx.patientId, ch.scope, ch.tooth])
      : await db.rows<{ data: unknown; rev: number }>('SELECT data, rev FROM chart_section WHERE patient_id = $1 AND section = $2 FOR UPDATE', [ctx.patientId, ch.scope])
    if ((cur?.rev ?? 0) !== ch.expectedRev) throw stale(label)
    const before = cur ? (cur.data as Record<string, unknown>) : null
    let after: Record<string, unknown>, op: string
    if (ch.clear) { if (!reason) throw bad('clearing needs a reason'); after = {}; op = 'clear' }
    else if (ch.replace) { after = ch.replace; op = 'replace' }
    else if (ch.unset) { after = { ...(before ?? {}) }; for (const k of ch.unset) delete after[k]; op = 'patch' }
    else { after = { ...(before ?? {}), ...ch.set! }; op = 'patch' }
    if (ctx.op === 'restore') op = 'restore'
    if (!ch.clear && !Object.keys(after).length) throw bad('that change would leave the record empty')
    const dropped = before ? Object.keys(before).filter((k) => !(k in after)) : []
    if (dropped.length && !reason && op !== 'restore') throw new ApiError(422, 'destructive_update', `This change removes ${dropped.slice(0, 5).join(', ')}; a reason is required`)
    const rev = (cur?.rev ?? 0) + 1, json = JSON.stringify(after)
    if (isTooth) {
      if (cur) await db.run('UPDATE chart_tooth SET data = $1::jsonb, rev = $2, updated_at = $3, updated_by = $4 WHERE patient_id = $5 AND scope = $6 AND tooth = $7', [json, rev, toDb(ctx.now), ctx.staffId, ctx.patientId, ch.scope, ch.tooth])
      else await db.run('INSERT INTO chart_tooth (patient_id, scope, tooth, clinic_id, data, rev, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,1,$6,$7)', [ctx.patientId, ch.scope, ch.tooth, ctx.clinicId, json, toDb(ctx.now), ctx.staffId])
    } else {
      if (cur) await db.run('UPDATE chart_section SET data = $1::jsonb, rev = $2, updated_at = $3, updated_by = $4 WHERE patient_id = $5 AND section = $6', [json, rev, toDb(ctx.now), ctx.staffId, ctx.patientId, ch.scope])
      else await db.run('INSERT INTO chart_section (patient_id, section, clinic_id, data, rev, updated_at, updated_by) VALUES ($1,$2,$3,$4::jsonb,1,$5,$6)', [ctx.patientId, ch.scope, ctx.clinicId, json, toDb(ctx.now), ctx.staffId])
    }
    await writeRevision(db, { clinicId: ctx.clinicId, patientId: ctx.patientId, groupId, scope: ch.scope, tooth: ch.tooth ?? null, rev, op, before, after, reason, staffId: ctx.staffId, now: ctx.now })
    out.push({ scope: ch.scope, tooth: ch.tooth ?? null, rev })
  }
  return { groupId, revs: out }
}

/** Creates the chart once. Later changes go through applyChanges only. */
export async function initChart(db: Db, ctx: Ctx, chart: Chart): Promise<{ groupId: string }> {
  const n = await db.run('INSERT INTO chart_head (patient_id, clinic_id, payload_version, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (patient_id) DO NOTHING', [ctx.patientId, ctx.clinicId, chart.version, toDb(ctx.now)])
  if (n !== 1) throw new ApiError(409, 'chart_exists', 'This patient already has a chart; change it with PATCH')
  const groupId = newId()
  const parts: { scope: Scope; tooth?: string; data: unknown }[] = [
    ...Object.entries(chart.teeth).map(([tooth, data]) => ({ scope: 'teeth' as const, tooth, data })), ...Object.entries(chart.plan ?? {}).map(([tooth, data]) => ({ scope: 'plan' as const, tooth, data })),
    { scope: 'globals' as const, data: chart.globals }, ...(chart.case !== undefined ? [{ scope: 'case' as const, data: chart.case }] : [])]
  for (const p of parts) {
    if (p.tooth) await db.run('INSERT INTO chart_tooth (patient_id, scope, tooth, clinic_id, data, rev, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,1,$6,$7)', [ctx.patientId, p.scope, p.tooth, ctx.clinicId, JSON.stringify(p.data), toDb(ctx.now), ctx.staffId])
    else await db.run('INSERT INTO chart_section (patient_id, section, clinic_id, data, rev, updated_at, updated_by) VALUES ($1,$2,$3,$4::jsonb,1,$5,$6)', [ctx.patientId, p.scope, ctx.clinicId, JSON.stringify(p.data), toDb(ctx.now), ctx.staffId])
    await writeRevision(db, { clinicId: ctx.clinicId, patientId: ctx.patientId, groupId, scope: p.scope, tooth: p.tooth ?? null, rev: 1, op: 'init', before: null, after: p.data, reason: ctx.reason, staffId: ctx.staffId, now: ctx.now })
  }
  return { groupId }
}

/** Restore: sets the current chart (or one part) back to an earlier state, as NEW revisions. Never deletes history. */
export async function restoreTo(db: Db, ctx: Ctx, target: Chart | { scope: Scope; tooth: string | null; data: Record<string, unknown> }): Promise<{ groupId: string; changed: number }> {
  const cur = await loadChart(db, ctx.clinicId, ctx.patientId); if (!cur) throw new ApiError(404, 'not_found', 'No chart')
  const changes: Change[] = []
  const diff = (scope: Scope, tooth: string | undefined, now: unknown, want: Record<string, unknown> | undefined, rev: number) => {
    if (want === undefined && now === undefined) return
    if (JSON.stringify(now ?? null) === JSON.stringify(want ?? {}) ) return
    if (want === undefined || !Object.keys(want).length) changes.push({ scope, tooth, expectedRev: rev, clear: true })
    else changes.push({ scope, tooth, expectedRev: rev, replace: want })
  }
  if ('scope' in target) {
    const t = target, nowV = t.tooth ? ((t.scope === 'plan' ? cur.chart.plan : cur.chart.teeth) ?? {})[t.tooth] : (cur.chart as unknown as Record<string, unknown>)[t.scope]
    const rev = t.tooth ? (t.scope === 'plan' ? cur.revs.plan : cur.revs.teeth)[t.tooth] ?? 0 : cur.revs[t.scope as 'globals' | 'case']
    diff(t.scope, t.tooth ?? undefined, nowV, t.data, rev)
  } else {
    for (const s of ['teeth', 'plan'] as const) {
      const have = (s === 'teeth' ? cur.chart.teeth : cur.chart.plan ?? {}) as Record<string, unknown>, want = (s === 'teeth' ? target.teeth : target.plan ?? {}) as Record<string, unknown>
      for (const tooth of new Set([...Object.keys(have), ...Object.keys(want)])) diff(s, tooth, have[tooth], want[tooth] as Record<string, unknown> | undefined, cur.revs[s][tooth] ?? 0)
    }
    diff('globals', undefined, cur.chart.globals, target.globals, cur.revs.globals)
    if (target.case !== undefined) diff('case', undefined, cur.chart.case, target.case as Record<string, unknown>, cur.revs.case)
  }
  if (!changes.length) return { groupId: newId(), changed: 0 }
  const restoreCtx = { ...ctx, op: 'restore' as const }
  const r = await applyChanges(db, { ...restoreCtx, reason: ctx.reason }, changes.map((c) => (c.clear ? { ...c, clear: true } : c)))
  return { groupId: r.groupId, changed: changes.length }
}
