/**
 * Bun's bundler resolves stylesheet imports; this tells the typecheck they
 * exist, while side-effect imports of anything else are still checked.
 */
declare module '*.css'
