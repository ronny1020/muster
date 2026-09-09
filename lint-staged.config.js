/**
 * What the husky pre-commit hook formats before a commit lands.
 *
 * Only staged files are touched, so a commit never quietly reformats work that
 * is still in progress elsewhere in the tree.
 */
export default {
  '*.{ts,tsx,js,mjs,cjs,css,json,md,html,yml,yaml}': 'prettier --write',
  // `rustfmt` per file cannot read Cargo.toml, so the edition has to be named.
  '*.rs': 'rustfmt --edition 2021',
}
