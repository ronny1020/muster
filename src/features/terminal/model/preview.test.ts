import { expect, test } from 'bun:test'

import type { LinkMeta } from '../../../shared/ipc'
import { previewCache } from './preview'

const meta = (url: string): LinkMeta => ({
  url,
  title: url,
  description: null,
  siteName: null,
  imageDataUrl: null,
})

test('hovering the same link again does not fetch it again', async () => {
  let fetches = 0
  const preview = previewCache(async (url) => (fetches++, meta(url)))
  await preview('https://a.example')
  await preview('https://a.example')
  expect(fetches).toBe(1)
})

test('a failed preview is tried again on the next hover', async () => {
  let fetches = 0
  const preview = previewCache(async () => {
    fetches++
    throw new Error('offline')
  })
  await preview('https://a.example').catch(() => {})
  await preview('https://a.example').catch(() => {})
  expect(fetches).toBe(2)
})

test('the oldest preview is the one dropped once the cache is full', async () => {
  const fetched: string[] = []
  const preview = previewCache(async (url) => (fetched.push(url), meta(url)))
  await preview('https://first.example')
  for (let i = 0; i < 64; i++) await preview(`https://${i}.example`)
  await preview('https://first.example')
  expect(fetched.filter((url) => url === 'https://first.example')).toHaveLength(
    2,
  )
})
