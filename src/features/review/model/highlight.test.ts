import { describe, expect, test } from 'bun:test'

import { GRAMMAR_IDS, highlight, languageFor } from './highlight'

describe('languageFor', () => {
  test('every grammar the table names is one that can be loaded', () => {
    // A typo like `typescriptreact` would otherwise fail at click time, in a
    // catch that turns it into plain black text — silently.
    const named = [
      'a.ts',
      'a.tsx',
      'a.js',
      'a.jsx',
      'a.rs',
      'a.py',
      'a.go',
      'a.json',
      'a.yml',
      'a.toml',
      'a.md',
      'a.sh',
      'a.css',
      'a.scss',
      'a.html',
      'a.vue',
      'a.svelte',
      'a.java',
      'a.kt',
      'a.swift',
      'a.c',
      'a.cpp',
      'a.cs',
      'a.rb',
      'a.php',
      'a.sql',
      'a.lua',
      'a.xml',
      'a.diff',
      'Dockerfile',
      '.bashrc',
    ].map(languageFor)

    expect(named.filter((id) => id === null)).toEqual([])
    for (const id of named) expect(GRAMMAR_IDS).toContain(id!)
  })

  test('a file with no grammar asks for none', () => {
    expect(languageFor('archive.tar.gz')).toBeNull()
    expect(languageFor('LICENSE')).toBeNull()
  })

  test('a path is judged by its filename', () => {
    expect(languageFor('/code/app/src-tauri/src/pty.rs')).toBe('rust')
    expect(languageFor('C:\\code\\app\\src\\App.tsx')).toBe('tsx')
  })

  test('a Dockerfile is recognised however it is suffixed', () => {
    expect(languageFor('Dockerfile')).toBe('dockerfile')
    expect(languageFor('Dockerfile.dev')).toBe('dockerfile')
  })
})

describe('highlight', () => {
  test('a snippet comes back tokenised, one array per line', async () => {
    // Proves the JavaScript regex engine works: the WASM one would need a
    // content security policy this app deliberately does not grant.
    const lines = await highlight(
      "const a = 1\nconsole.log('hi')",
      'typescript',
    )

    expect(lines).toHaveLength(2)
    expect(lines![0]!.map((token) => token.content).join('')).toBe(
      'const a = 1',
    )
    expect(lines![0]![0]!.color).toMatch(/^#/)
  })

  test('a file with no grammar is not an error, it is just uncoloured', async () => {
    expect(await highlight('anything', null)).toBeNull()
  })

  test('nothing is tokenised past the size where it would stall the window', async () => {
    expect(await highlight('x\n'.repeat(300_000), 'typescript')).toBeNull()
  })
})
