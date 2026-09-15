import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { blockedHint } from './blocked'

test('macOS says the answer is remembered, because retrying is the obvious move', () => {
  // The whole reason this hint exists: a "Don't Allow" is recorded per app, so
  // the app is never allowed to ask again and starting the session once more
  // hits the same wall with no new prompt.
  const hint = blockedHint('macos')
  expect(hint.reason).toContain('remembered')
  expect(hint.remedy).toContain('cannot ask again')
})

test('only macOS blames a permission prompt', () => {
  // Windows and Linux never asked, so telling someone there to "allow it
  // again" sends them looking for a dialog that never existed. Asserted on a
  // phrase the macOS branch actually uses, so it discriminates.
  const remembered = blockedHint('macos')
  expect(remembered.reason).toContain('your permission')
  expect(remembered.remedy).toContain('cannot ask again')
  for (const os of ['windows', 'linux'] as const) {
    const hint = blockedHint(os)
    expect(hint.reason).not.toContain('your permission')
    expect(hint.remedy).not.toContain('cannot ask again')
  }
})

test('each host is sent to a settings page that exists on it', () => {
  expect(blockedHint('macos').settings?.url).toStartWith(
    'x-apple.systempreferences:',
  )
  expect(blockedHint('windows').settings?.url).toStartWith('windowsdefender:')
})

test('Linux gets no button rather than a guessed one', () => {
  // There is no settings URL every desktop honours, and a button that opens
  // nothing is worse than prose that says what to check.
  expect(blockedHint('linux').settings).toBeUndefined()
})

test('every host says something actionable', () => {
  for (const os of ['macos', 'windows', 'linux'] as const) {
    const hint = blockedHint(os)
    expect(hint.reason.length).toBeGreaterThan(0)
    expect(hint.remedy.length).toBeGreaterThan(0)
  }
})

/** The `opener:allow-open-url` entry of the app's capability file. */
function openerScope(): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dir,
        '../../../../src-tauri/capabilities/default.json',
      ),
      'utf8',
    ),
  )
  // Narrowed rather than asserted: the file crossed a serialisation boundary,
  // and `JSON.parse(x) as T` is the assertion AGENTS.md names as the common
  // wrong one. A malformed file has to fail as a bad shape, not as a
  // `TypeError` thrown from `.find` three lines later.
  if (typeof raw !== 'object' || raw === null || !('permissions' in raw)) {
    throw new Error('capability file has no permissions array')
  }
  const { permissions } = raw as { permissions: unknown }
  if (!Array.isArray(permissions)) {
    throw new Error('capability permissions is not an array')
  }
  for (const entry of permissions) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'identifier' in entry &&
      entry.identifier === 'opener:allow-open-url' &&
      'allow' in entry &&
      Array.isArray(entry.allow)
    ) {
      return (entry.allow as unknown[]).flatMap((rule) =>
        typeof rule === 'object' && rule !== null && 'url' in rule
          ? [String(rule.url)]
          : [],
      )
    }
  }
  throw new Error('no scoped opener:allow-open-url permission found')
}

test('every settings URL this can return is one the opener is allowed to open', () => {
  // The scope is an allowlist, so a hint whose URL drifts by one character
  // makes `open_url` answer `ForbiddenUrl` and the button do nothing at all,
  // silently, on the one platform that has it.
  const allowed = openerScope()
  for (const os of ['macos', 'windows', 'linux'] as const) {
    const url = blockedHint(os).settings?.url
    if (url) expect(allowed).toContain(url)
  }
})

test('the opener scope holds nothing but those two settings URLs', () => {
  // Containment, which availability alone cannot give: the same `openUrl` is
  // reachable from a preview card whose URL an agent-authored markdown link
  // chooses, so a `*` added to this array has to fail here.
  //
  // `opener:allow-default-urls` sits beside it and contributes `http://*`,
  // `https://*`, `mailto:*` and `tel:*` to the same effective scope.
  const expected = (['macos', 'windows'] as const).map(
    (os) => blockedHint(os).settings?.url,
  )
  expect(openerScope().sort()).toEqual(
    expected.filter((url): url is string => url !== undefined).sort(),
  )
})
