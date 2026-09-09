/** Production bundle for the Tauri webview: index.html -> dist/. */
import tailwind from 'bun-plugin-tailwind'

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  target: 'browser',
  minify: true,
  sourcemap: 'linked',
  plugins: [tailwind],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`bundled ${result.outputs.length} files -> dist/`)
