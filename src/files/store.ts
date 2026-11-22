import { AwsClient } from 'aws4fetch'

/** Storage port for private files. Production = Cloudflare R2 through its S3 API; tests use an in-memory fake or a local S3 server. */
export interface FileStore {
  /** Short-lived URL the BROWSER PUTs the bytes to, so large files never pass through the Worker. The Content-Type is part of the signature. */
  presignPut(key: string, contentType: string, ttlSeconds: number): Promise<string>
  /** Short-lived URL to read the object. `filename` is only used when the response should download (`attachment`). */
  presignGet(key: string, o: { contentType: string; filename: string; inline: boolean }, ttlSeconds: number): Promise<string>
  head(key: string): Promise<{ size: number; contentType: string | null } | null>
  /** The first `n` bytes (or fewer), for content checks. Never the whole object. */
  peek(key: string, n: number): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}
const missing = async (): Promise<never> => { throw new Error('R2 storage is not configured') }
export const unconfiguredStore: FileStore = { presignPut: missing, presignGet: missing, head: missing, peek: missing, delete: missing }

export type S3Env = { R2_ENDPOINT?: string; R2_BUCKET?: string; R2_ACCESS_KEY_ID?: string; R2_SECRET_ACCESS_KEY?: string }

/** R2_ENDPOINT is the S3 endpoint, with or without the bucket as its path (`https://<account>.r2.cloudflarestorage.com[/<bucket>]`). */
export function s3Store(env: S3Env, fetcher: typeof fetch = fetch): FileStore {
  if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return unconfiguredStore
  const ep = new URL(env.R2_ENDPOINT), bucket = env.R2_BUCKET?.trim() || ep.pathname.split('/').filter(Boolean)[0]
  if (!bucket) throw new Error('R2_BUCKET (or a bucket in R2_ENDPOINT) is required')
  const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' })
  const objectUrl = (key: string) => new URL(`${ep.origin}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`)
  const presign = async (method: string, key: string, query: Record<string, string>, headers: Record<string, string>, ttl: number) => {
    const u = objectUrl(key)
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    u.searchParams.set('X-Amz-Expires', String(ttl))
    return (await aws.sign(new Request(u, { method, headers }), { aws: { signQuery: true, allHeaders: true } })).url
  }
  const call = (method: string, key: string, headers?: Record<string, string>) => aws.sign(objectUrl(key), { method, headers }).then((r) => fetcher(r))
  return {
    presignPut: (key, type, ttl) => presign('PUT', key, {}, { 'Content-Type': type }, ttl),
    presignGet: (key, o, ttl) => presign('GET', key, {
      'response-content-type': o.contentType,
      'response-content-disposition': `${o.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(o.filename)}`,
    }, {}, ttl),
    head: async (key) => {
      const r = await call('HEAD', key)
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`storage HEAD ${r.status}`)
      return { size: Number(r.headers.get('content-length')), contentType: r.headers.get('content-type') }
    },
    peek: async (key, n) => {
      const r = await call('GET', key, { Range: `bytes=0-${n - 1}` })
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`storage GET ${r.status}`)
      return new Uint8Array(await r.arrayBuffer()).subarray(0, n) // a server that ignores Range would send everything: the slice keeps memory use to what we read
    },
    delete: async (key) => { const r = await call('DELETE', key); if (!r.ok && r.status !== 404) throw new Error(`storage DELETE ${r.status}`) },
  }
}
