import type { TFunction } from 'i18next'

import { i18n } from '../shared/i18n/i18n'
import { type CloseWords, sendCloseWords } from '../shared/ipc'

/**
 * Delimiters nothing in a catalog uses, so `{{count}}` survives into the
 * template: the plural form is picked here, the number is filled in by Rust,
 * which is the side that counts the sessions when the close happens.
 */
const KEEP_PLACEHOLDERS = { prefix: '\u0000', suffix: '\u0000' }

/** The close dialog's words in the language `t` speaks. */
export function closeWords(t: TFunction<'chrome'>): CloseWords {
  const template = (
    key: 'closeDialog.quitBody' | 'closeDialog.closeBody',
    count: number,
  ) => t(key, { count, interpolation: KEEP_PLACEHOLDERS })
  return {
    quitTitle: t('closeDialog.quitTitle'),
    closeTitle: t('closeDialog.closeTitle'),
    quit: t('closeDialog.quit'),
    close: t('closeDialog.close'),
    cancel: t('closeDialog.cancel'),
    quitBodyOne: template('closeDialog.quitBody', 1),
    quitBodyOther: template('closeDialog.quitBody', 2),
    closeBodyOne: template('closeDialog.closeBody', 1),
    closeBodyOther: template('closeDialog.closeBody', 2),
  }
}

const send = () =>
  sendCloseWords(closeWords(i18n.getFixedT(null, 'chrome'))).catch(() => {
    // The backend keeps its English words, which still ask the question.
  })

/**
 * Keeps the native close dialog in the interface language. The dialog is
 * drawn by Rust, which has no catalogs, so the words go over on every language
 * change, and only then: Rust starts with the American words, which are what
 * an unchanged language would send.
 */
export function syncCloseWords() {
  i18n.on('languageChanged', () => void send())
}
