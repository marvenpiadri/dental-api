// Bundles src/handler.ts into dist/index.mjs and zips it exactly as the Neon deploy endpoint expects (entry file index.mjs).
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
await build({ entryPoints: ['src/handler.ts'], bundle: true, minify: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/index.mjs',
  banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" } })
execFileSync('zip', ['-j', '-q', '-X', 'dist/function.zip', 'dist/index.mjs'])
console.log('built dist/function.zip')
