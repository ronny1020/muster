import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import { resources } from './resources'

export type Locale = keyof typeof resources

/** What the user picked: a locale, or whatever the OS prefers. */
export type LanguageSetting = 'system' | Locale

/** Object.keys widens to string[]; `resources` is a literal with exactly these keys. */
export const LOCALES = Object.keys(resources) as Locale[]

/**
 * Each language named in itself, so a user who cannot read the current one
 * can still find their own.
 */
export const LOCALE_NAMES: Record<Locale, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'zh-TW': '繁體中文',
  'zh-CN': '简体中文',
  ja: '日本語',
}

/**
 * Own keys only: a stored `"constructor"` passes an `in` check, and a
 * language that resolves to no catalog would throw on the first render.
 */
export const isLanguageSetting = (value: unknown): value is LanguageSetting =>
  value === 'system' ||
  (typeof value === 'string' && Object.hasOwn(resources, value))

/** English varieties that spell the British way rather than the American. */
const BRITISH = new Set(['GB', 'UK', 'IE', 'AU', 'NZ', 'ZA', 'IN'])

/** Chinese regions and scripts that read Traditional characters. */
const TRADITIONAL = new Set(['TW', 'HK', 'MO', 'HANT'])

/**
 * The catalog for one BCP 47 tag, or `null` when none fits. Chinese is told
 * apart by script first, since `zh-Hant-CN` is Traditional wherever it is read.
 */
function catalogFor(tag: string): Locale | null {
  const [language, ...rest] = tag.toUpperCase().split(/[-_]/)
  if (language === 'EN') {
    return rest.some((part) => BRITISH.has(part)) ? 'en-GB' : 'en-US'
  }
  if (language === 'ZH') {
    if (rest.includes('HANS')) return 'zh-CN'
    return rest.some((part) => TRADITIONAL.has(part)) ? 'zh-TW' : 'zh-CN'
  }
  if (language === 'JA') return 'ja'
  return null
}

/** The locale a setting means, given the OS's preferred languages in order. */
export function resolveLocale(
  setting: LanguageSetting,
  preferred: readonly string[],
): Locale {
  if (setting !== 'system') return setting
  for (const tag of preferred) {
    const match = catalogFor(tag)
    if (match) return match
  }
  return 'en-US'
}

/**
 * The one instance, initialised synchronously from bundled catalogs so the
 * first render already has its words. `en-GB` holds only what British
 * spelling changes and falls back to `en-US` for the rest.
 */
export const i18n = i18next.createInstance()
void i18n.use(initReactI18next).init({
  resources,
  lng: 'en-US',
  fallbackLng: 'en-US',
  supportedLngs: LOCALES,
  load: 'currentOnly',
  ns: Object.keys(resources['en-US']),
  defaultNS: 'common',
  initAsync: false,
  // React escapes what it renders; escaping here as well would show `&amp;`.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

/**
 * Switches every component that reads through `useTranslation`, in place.
 *
 * Nothing is remounted to apply it: panes must stay mounted, and a remount
 * would end every session in the window.
 */
export function setLanguage(setting: LanguageSetting) {
  const next = resolveLocale(setting, navigator.languages)
  document.documentElement.lang = next
  if (next !== i18n.language) void i18n.changeLanguage(next)
}

/** The language in use, as a BCP 47 tag for `Intl`. */
export const currentLocale = () => i18n.language
