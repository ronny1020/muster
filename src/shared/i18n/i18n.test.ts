import { afterEach, expect, test } from 'bun:test'

import {
  currentLocale,
  i18n,
  isLanguageSetting,
  type Locale,
  LOCALES,
  loadSystemLocales,
  resolveLocale,
  setLanguage,
} from './i18n'
import { resources } from './resources'

const webviewLanguages = [...navigator.languages]

afterEach(async () => {
  await loadSystemLocales(() => Promise.resolve(webviewLanguages))
  setLanguage('en-US')
})

test('an explicit language wins over the OS preference', () => {
  expect(resolveLocale('ja', ['zh-TW'])).toBe('ja')
})

test('the first OS language with a catalog is the one used', () => {
  expect(resolveLocale('system', ['fr-FR', 'ja-JP', 'en-US'])).toBe('ja')
})

test('an OS with no language we carry falls back to American English', () => {
  expect(resolveLocale('system', ['fr-FR', 'de'])).toBe('en-US')
  expect(resolveLocale('system', [])).toBe('en-US')
})

test('British, Irish and Australian English spell the British way', () => {
  for (const tag of ['en-GB', 'en-IE', 'en-AU', 'en_NZ']) {
    expect(resolveLocale('system', [tag])).toBe('en-GB')
  }
  expect(resolveLocale('system', ['en'])).toBe('en-US')
  expect(resolveLocale('system', ['en-CA'])).toBe('en-US')
})

test('Match system follows the languages the OS reported', async () => {
  await loadSystemLocales(() => Promise.resolve(['zh-Hant-TW', 'en-TW']))
  setLanguage('system')
  expect(currentLocale()).toBe('zh-TW')
})

test('an empty or failed OS answer keeps the languages already held', async () => {
  await loadSystemLocales(() => Promise.resolve(['ja-JP']))
  await loadSystemLocales(() => Promise.resolve([]))
  await loadSystemLocales(() => Promise.reject(new Error('no backend')))
  setLanguage('system')
  expect(currentLocale()).toBe('ja')
})

test('the tags macOS reports, region and script together, resolve', () => {
  expect(resolveLocale('system', ['zh-Hant-TW', 'en-TW'])).toBe('zh-TW')
  expect(resolveLocale('system', ['ja-TW', 'zh-Hant-TW'])).toBe('ja')
  expect(resolveLocale('system', ['en-TW', 'zh-Hant-TW'])).toBe('en-US')
})

test('Chinese is split by script first, then by region', () => {
  expect(resolveLocale('system', ['zh-TW'])).toBe('zh-TW')
  expect(resolveLocale('system', ['zh-HK'])).toBe('zh-TW')
  expect(resolveLocale('system', ['zh-Hant'])).toBe('zh-TW')
  expect(resolveLocale('system', ['zh-Hans-TW'])).toBe('zh-CN')
  expect(resolveLocale('system', ['zh-CN'])).toBe('zh-CN')
  expect(resolveLocale('system', ['zh'])).toBe('zh-CN')
})

test('a stored language must be one we carry', () => {
  expect(isLanguageSetting('system')).toBe(true)
  expect(isLanguageSetting('zh-TW')).toBe(true)
  expect(isLanguageSetting('fr')).toBe(false)
  expect(isLanguageSetting(3)).toBe(false)
})

test('an inherited property name is not a language', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    expect(isLanguageSetting(name)).toBe(false)
  }
})

test('switching the language swaps the words at once, and the page language', () => {
  setLanguage('zh-TW')
  expect(currentLocale()).toBe('zh-TW')
  expect(i18n.t('common:justNow')).toBe('剛剛')
  expect(document.documentElement.lang).toBe('zh-TW')
})

test('British English borrows every word it does not respell', () => {
  setLanguage('en-GB')
  expect(i18n.t('chrome:window.minimize')).toBe('Minimise')
  expect(i18n.t('common:justNow')).toBe('just now')
})

test('a plural picks the form its language needs', () => {
  setLanguage('en-US')
  expect(i18n.t('settings:units.days', { count: 1 })).toBe('1 day')
  expect(i18n.t('settings:units.days', { count: 3 })).toBe('3 days')
  setLanguage('ja')
  expect(i18n.t('settings:units.days', { count: 1 })).toBe('1 日間')
})

/** Every message in a catalog, by its dotted path. */
function flatten(tree: object, prefix = ''): Map<string, string> {
  return new Map(
    Object.entries(tree).flatMap(([key, value]: [string, unknown]) => {
      if (typeof value === 'string') return [[`${prefix}${key}`, value]]
      if (typeof value === 'object' && value !== null) {
        return [...flatten(value, `${prefix}${key}.`)]
      }
      return []
    }),
  )
}

const PLURAL = /_(zero|one|two|few|many|other)$/

/** The `{{name}}`s a message interpolates, `$t` nesting excluded. */
const variables = (message: string) =>
  [...message.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort()

/**
 * One locale's messages keyed by base key: plural forms collapse into one
 * entry, since languages differ in how many forms they need.
 */
function messagesOf(locale: Locale) {
  const out = new Map<string, { forms: Set<string>; vars: Set<string> }>()
  for (const [ns, tree] of Object.entries(resources[locale])) {
    for (const [path, message] of flatten(tree)) {
      const form = path.match(PLURAL)?.[1]
      const key = `${ns}:${path.replace(PLURAL, '')}`
      const entry = out.get(key) ?? { forms: new Set(), vars: new Set() }
      if (form) entry.forms.add(form)
      for (const name of variables(message)) entry.vars.add(name)
      out.set(key, entry)
    }
  }
  return out
}

const american = messagesOf('en-US')

/** `en-GB` is an overlay, so only the complete catalogs must match. */
const complete = LOCALES.filter((locale) => locale !== 'en-GB')

test.each(complete)(
  '%s carries every message the American catalog has',
  (locale) => {
    const own = messagesOf(locale)
    expect([...american.keys()].filter((key) => !own.has(key))).toEqual([])
    expect([...own.keys()].filter((key) => !american.has(key))).toEqual([])
  },
)

test.each(complete)(
  '%s interpolates the same values as American English',
  (locale) => {
    const own = messagesOf(locale)
    const mismatched = [...american].flatMap(([key, { vars }]) => {
      const theirs = own.get(key)?.vars ?? new Set()
      const same =
        vars.size === theirs.size && [...vars].every((v) => theirs.has(v))
      return same
        ? []
        : [`${key}: ${[...vars].join()} vs ${[...theirs].join()}`]
    })
    expect(mismatched).toEqual([])
  },
)

test.each(complete)('%s has every plural form its language uses', (locale) => {
  const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
  const own = messagesOf(locale)
  const missing = [...american].flatMap(([key, { forms }]) => {
    if (forms.size === 0) return []
    const theirs = own.get(key)?.forms ?? new Set()
    return needed
      .filter((form) => !theirs.has(form))
      .map((form) => `${key}_${form}`)
  })
  expect(missing).toEqual([])
})

test('British English only respells messages American English has', () => {
  const british = messagesOf('en-GB')
  expect([...british.keys()].filter((key) => !american.has(key))).toEqual([])
})

test('no catalog leaves a message blank', () => {
  const blanks = LOCALES.flatMap((locale) =>
    Object.entries(resources[locale]).flatMap(([ns, tree]) =>
      [...flatten(tree)]
        .filter(([, message]) => message.trim() === '')
        .map(([path]) => `${locale} ${ns}:${path}`),
    ),
  )
  expect(blanks).toEqual([])
})
