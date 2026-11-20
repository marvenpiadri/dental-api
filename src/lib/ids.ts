const enc = new TextEncoder()
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const newId = (): string => crypto.randomUUID()
export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)))
export async function sha256Hex(s: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), (x) => x.toString(16).padStart(2, '0')).join('')
}
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
