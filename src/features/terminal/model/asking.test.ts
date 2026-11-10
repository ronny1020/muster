import { expect, test } from 'bun:test'

import { isAsking } from './asking'

const claudePermission = [
  '⏺ Bash(rm -rf build)',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│   rm -rf build                           │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
  '  Esc to cancel · Tab to amend · ctrl+e to explain',
  '',
  '',
]

test("Claude Code's permission prompt is asking", () => {
  expect(isAsking('claude', claudePermission)).toBe(true)
})

test('a finished Claude Code turn at its prompt is not asking', () => {
  const idle = [
    '⏺ Done — the tests pass.',
    '',
    '╭──────────────────────────────────────────╮',
    '│ >                                        │',
    '╰──────────────────────────────────────────╯',
    '  ? for shortcuts',
  ]
  expect(isAsking('claude', idle)).toBe(false)
})

test('a dialog scrolled far above the bottom no longer counts', () => {
  const later = [...claudePermission, ...Array<string>(20).fill('⏺ more work')]
  expect(isAsking('claude', later)).toBe(false)
})

test('blank rows below the dialog do not push it out of reach', () => {
  const padded = [...claudePermission, ...Array<string>(30).fill('   ')]
  expect(isAsking('claude', padded)).toBe(true)
})

test('the footer matches whatever case the CLI draws it in', () => {
  expect(isAsking('claude', ['DO YOU WANT TO PROCEED?', 'ESC TO CANCEL'])).toBe(
    true,
  )
})

test('an agent nobody wrote a rule for is never asking', () => {
  expect(isAsking('goose', claudePermission)).toBe(false)
  expect(isAsking('shell', ['Do you want to proceed? [y/n]'])).toBe(false)
})

test("a footer word alone is not one agent's dialog", () => {
  expect(isAsking('claude', ['Esc to cancel'])).toBe(false)
  expect(isAsking('opencode', ['esc dismiss'])).toBe(false)
})

test("Codex's approval and aider's yes/no prompt are asking", () => {
  expect(
    isAsking('codex', [
      'Would you like to run the following command?',
      '  $ cargo test',
      '› 1. Yes, proceed (y)',
      '  2. No (esc)',
    ]),
  ).toBe(true)
  expect(
    isAsking('aider', ['Add src/main.rs to the chat? (Y)es/(N)o [Yes]:']),
  ).toBe(true)
})

test('a finished Codex turn that only mentions "yes" is not asking', () => {
  expect(
    isAsking('codex', [
      'Would you like to see the diff? If yes, I can print it.',
      '› ',
    ]),
  ).toBe(false)
})

test("Codex's title and trust dialog are asking", () => {
  expect(isAsking('codex', ['Action Required', '', ''])).toBe(true)
  expect(
    isAsking('codex', [
      '> You are in /work/api',
      'Do you trust the contents of this directory?',
    ]),
  ).toBe(true)
})

test("Gemini CLI's confirmation is asking", () => {
  expect(
    isAsking('gemini', [
      '╭───────────────────────────╮',
      '│ Allow execution of: rm?   │',
      '│ ● Yes, allow once         │',
      '╰───────────────────────────╯',
    ]),
  ).toBe(true)
})

test("OpenCode's permission dialog is asking", () => {
  expect(
    isAsking('opencode', ['△ Permission required', '  bash: rm -rf build']),
  ).toBe(true)
  expect(
    isAsking('opencode', ['  ↑↓ select  enter confirm  esc dismiss']),
  ).toBe(true)
})

test("Hermes's approval and questions are asking", () => {
  expect(
    isAsking('hermes', [
      '⚠ dangerous command: rm -rf /tmp/x',
      '▸ 1. Allow once',
      '  2. Deny',
      '↑/↓ to select · enter to confirm',
    ]),
  ).toBe(true)
  expect(isAsking('hermes', ['Hermes needs your input'])).toBe(true)
})

test("Antigravity's permission prompt is asking", () => {
  expect(
    isAsking('antigravity', [
      'Run command: cargo test',
      '↑/↓ navigate · enter accept · tab amend',
    ]),
  ).toBe(true)
})

test('a finished Codex turn that printed a y/n prompt in its output is not asking', () => {
  expect(isAsking('codex', ['  echo "Continue? [y/n]"', '› '])).toBe(false)
})

test("Hermes's sudo prompt asks only with its dialog footer", () => {
  expect(
    isAsking('hermes', ['🔑 sudo password for build:', 'enter to confirm']),
  ).toBe(true)
  expect(
    isAsking('hermes', [
      'This step needs your sudo password; run it yourself.',
    ]),
  ).toBe(false)
})
