import 'i18next'

import type { source } from './resources'

/**
 * Types every `t` key against the American catalog, so a key that is not
 * there fails `tsc`. Whether the other catalogs carry it is `i18n.test.ts`'s
 * job, since JSON has no type to check them against.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof source
    strictKeyChecks: true
  }
}
