// Real-bucket check, run by the owner:  npm run r2-smoke     (reads R2_* from .dev.vars; prints no secrets; leaves nothing behind)
// Does what the browser and API do: signed PUT, HEAD, Range read, signed GET, CORS preflight, DELETE.
import { s3Store } from '../src/files/store.ts'

const store = s3Store(process.env), origin = process.env.APP_ORIGIN ?? 'http://localhost:4200'
const key = `smoke/${crypto.randomUUID()}`, png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4])
const step = async (name: string, f: () => Promise<unknown>) => { try { await f(); console.log('ok   ', name) } catch (e) { console.log('FAIL ', name, '-', e instanceof Error ? e.message : e); process.exitCode = 1 } }
const must = (c: boolean, m: string) => { if (!c) throw new Error(m) }
try {
  await step('signed PUT (the browser upload)', async () => { const r = await fetch(await store.presignPut(key, 'image/png', 60), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png }); must(r.ok, `HTTP ${r.status}`) })
  await step('HEAD size and type', async () => { const h = await store.head(key); must(h?.size === png.length && h.contentType === 'image/png', JSON.stringify(h)) })
  await step('Range read of the first bytes', async () => { const b = await store.peek(key, 4); must(b?.length === 4 && b[0] === 0x89, `got ${b?.length} bytes`) })
  await step('signed GET', async () => { const r = await fetch(await store.presignGet(key, { contentType: 'image/png', filename: 'a b.png', inline: true }, 60)); must(r.ok && (await r.arrayBuffer()).byteLength === png.length, `HTTP ${r.status}`); console.log('     content-disposition:', r.headers.get('content-disposition') ?? '(not set: R2 ignored response-content-disposition)') })
  await step('unsigned access is refused (the bucket is private)', async () => { const u = new URL(await store.presignGet(key, { contentType: 'image/png', filename: 'a.png', inline: true }, 60)); u.search = ''; must((await fetch(u)).status === 403, 'unsigned GET was not refused') })
  await step(`CORS preflight for ${origin}`, async () => { const r = await fetch(await store.presignPut(key, 'image/png', 60), { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } }); must(r.ok && r.headers.get('access-control-allow-origin') !== null, `HTTP ${r.status}; add the CORS rule from docs/r2-storage.md`) })
} finally { await step('DELETE', async () => { await store.delete(key); must((await store.head(key)) === null, 'object still there') }) }
console.log(process.exitCode ? 'R2 CHECK FAILED' : 'R2 CHECK OK')
