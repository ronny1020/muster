import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * A DOM for the component tests, registered before anything imports React.
 *
 * Bun's runtime has no DOM, so without this a component test fails on
 * `document` rather than on the behaviour it is checking. It also brings its own
 * `localStorage`, which is why the fallback below is conditional — the modules
 * that persist settings and tabs are tested without a DOM too.
 */
GlobalRegistrator.register()

/** In-memory `localStorage`, for the case where the DOM did not supply one. */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>()

  get length() {
    return this.entries.size
  }

  key(index: number) {
    return [...this.entries.keys()][index] ?? null
  }

  getItem(key: string) {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.entries.set(key, String(value))
  }

  removeItem(key: string) {
    this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }
}

globalThis.localStorage ??= new MemoryStorage()
