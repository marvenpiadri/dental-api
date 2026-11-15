export class PayloadTooLargeError extends Error { constructor() { super('payload too large') } }

/** Counts real bytes as they stream and errors the stream past `max`; Content-Length is never trusted. Returns the stream and a live byte counter. */
export function limitStream(max: number): { stream: TransformStream<Uint8Array, Uint8Array>; bytes: () => number; head: () => Uint8Array } {
  let n = 0
  const head = new Uint8Array(16); let h = 0 // first bytes, kept for content sniffing
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      if (h < 16) { const take = Math.min(16 - h, chunk.byteLength); head.set(chunk.subarray(0, take), h); h += take }
      n += chunk.byteLength
      if (n > max) { ctl.error(new PayloadTooLargeError()); return }
      ctl.enqueue(chunk)
    },
  })
  return { stream, bytes: () => n, head: () => head.slice(0, h) }
}
