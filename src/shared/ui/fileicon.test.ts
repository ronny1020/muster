import { describe, expect, test } from 'bun:test'

import { fileIcon, folderIcon } from './fileicon'
import { ICONS } from './icons'

describe('fileIcon', () => {
  test('a full path is judged by its filename, not its folders', () => {
    expect(fileIcon('src/features/review/ui/DiffView.tsx').name).toBe('code')
    expect(fileIcon('C:\\code\\app\\main.rs').name).toBe('code')
  })

  test('a name with no extension falls back to a plain document', () => {
    expect(fileIcon('LICENSE').name).toBe('description')
    expect(fileIcon('src/bin/muster').name).toBe('description')
  })

  test('a dotfile keeps its own name rather than borrowing an extension', () => {
    // `.gitignore` would otherwise read as a `gitignore` extension.
    expect(fileIcon('.gitignore').name).toBe('settings')
  })

  test('any lockfile reads as a lock, whatever it locks', () => {
    expect(fileIcon('bun.lock').name).toBe('lock')
    expect(fileIcon('src-tauri/Cargo.lock').name).toBe('lock')
  })

  test('an environment file keeps its meaning through a suffix', () => {
    // `.env.local` and `.env.production` are the same secret-shaped file.
    expect(fileIcon('.env').name).toBe('lock')
    expect(fileIcon('.env.local').name).toBe('lock')
  })

  test('case never decides the icon, because filesystems disagree about it', () => {
    expect(fileIcon('README.MD')).toEqual(fileIcon('readme.md'))
    expect(fileIcon('Dockerfile')).toEqual(fileIcon('dockerfile'))
  })

  test('every icon it can return is one the set actually holds', () => {
    // A typo in the table would otherwise render an empty `<path>`, which is
    // invisible rather than broken.
    const names = [
      'a.ts',
      'a.js',
      'a.json',
      'a.yml',
      'a.css',
      'a.html',
      'a.sh',
      'a.sql',
      'a.csv',
      'a.png',
      'a.md',
      'a.lock',
      '.env',
      '.gitignore',
      'Makefile',
      'unknown.zzz',
    ]
    for (const name of names) {
      expect(ICONS).toHaveProperty(fileIcon(name).name)
    }
  })
})

test('a folder shows whether it is open', () => {
  expect(folderIcon(true)).toBe('folder_open')
  expect(folderIcon(false)).toBe('folder')
})
