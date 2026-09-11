/** Production bundle for the Tauri webview: index.html -> dist/. */
import tailwind from 'bun-plugin-tailwind'

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  target: 'browser',
  // Without it every dynamic import is inlined, and the review panel's thirty
  // syntax grammars plus mermaid make an 8 MB bundle the webview has to parse
  // before drawing a window. Split, they are fetched when a file needs them.
  splitting: true,
  minify: true,
  sourcemap: 'linked',
  plugins: [tailwind],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`bundled ${result.outputs.length} files -> dist/`)
