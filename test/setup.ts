/** In-memory `localStorage`, which Bun's test runtime does not provide. */
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
