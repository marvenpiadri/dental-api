export class PayloadTooLargeError extends Error { constructor() { super('payload too large') } }

/** Counts real bytes as they stream and errors the stream past `max`; Content-Length is never trusted. Returns the stream and a live byte counter. */
export function limitStream(max: number): { stream: TransformStream<Uint8Array, Uint8Array>; bytes: () => number } {
  let n = 0
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      n += chunk.byteLength
      if (n > max) { ctl.error(new PayloadTooLargeError()); return }
      ctl.enqueue(chunk)
    },
  })
  return { stream, bytes: () => n }
}
