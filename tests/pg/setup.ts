// Vitest global setup. TEST_DATABASE_URL (a local PostgreSQL or a Neon scratch branch; superuser or CREATEDB role) is used when set;
// otherwise a real embedded PostgreSQL is started for the run.
import { spawn } from 'node:child_process'

export default async function setup() {
  if (process.env.TEST_DATABASE_URL) return
  const script = new URL('./embedded.mjs', import.meta.url).pathname
  const root = process.getuid?.() === 0
  const child = spawn(root ? 'runuser' : process.execPath, root ? ['-u', 'pgtest', '--', 'env', `HOME=/home/pgtest`, process.execPath, script] : [script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const url = await new Promise<string>((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (d) => { buf += d; const m = /READY (\S+)/.exec(buf); if (m) resolve(m[1]) })
    child.on('exit', (code) => reject(new Error(`embedded postgres exited (${code})`)))
    setTimeout(() => reject(new Error('embedded postgres did not start in 90s')), 90_000)
  })
  process.env.TEST_DATABASE_URL = url
  return async () => { child.removeAllListeners('exit'); child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)) }
}
