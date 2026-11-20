const enc = new TextEncoder()
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** UUIDv7: time-ordered ids (48-bit millisecond timestamp, then a per-millisecond counter, then random). Stored in native `uuid` columns; new rows land at the end of the index and ids sort by creation time. */
let lastMs = 0, counter = 0
export const newId = (): string => {
  const r = crypto.getRandomValues(new Uint8Array(16))
  let ms = Date.now()
  if (ms > lastMs) { lastMs = ms; counter = ((r[0] << 8) | r[1]) & 0x7ff } // start low so the counter has room within one millisecond
  else { counter++; if (counter > 0xfff) { lastMs++; counter = 0 }; ms = lastMs }
  for (let i = 5; i >= 0; i--) { r[i] = ms % 256; ms = Math.floor(ms / 256) }
  r[6] = 0x70 | (counter >> 8); r[7] = counter & 0xff; r[8] = 0x80 | (r[8] & 0x3f)
  const h = Array.from(r, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)))
export async function sha256Hex(s: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), (x) => x.toString(16).padStart(2, '0')).join('')
}
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
