/** Storage port for private files. Production = R2; tests use an in-memory fake. */
export interface FileStore {
  put(key: string, body: ReadableStream<Uint8Array>, size: number, contentType: string): Promise<void>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>
  delete(key: string): Promise<void>
}
export const unconfiguredStore: FileStore = {
  put: async () => { throw new Error('FILES bucket is not configured') }, get: async () => { throw new Error('FILES bucket is not configured') }, delete: async () => { throw new Error('FILES bucket is not configured') },
}
/**
 * R2 needs a known length for a stream. FixedLengthStream makes the runtime enforce it EXACTLY: a body longer or shorter than the declared
 * Content-Length makes the put fail, so a lying header cannot smuggle extra bytes (our own counter caps the size before this as well).
 */
export function r2Store(bucket: R2Bucket | undefined): FileStore {
  if (!bucket) return unconfiguredStore
  return {
    put: async (key, body, size, contentType) => { await bucket.put(key, body.pipeThrough(new FixedLengthStream(size)), { httpMetadata: { contentType } }) },
    get: async (key) => { const o = await bucket.get(key); return o ? { body: o.body, size: o.size } : null },
    delete: (key) => bucket.delete(key),
  }
}
