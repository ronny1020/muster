import { expect, test } from 'bun:test'

import { webHref } from './weburl'

test('a web page is a link the system may open', () => {
  expect(webHref('https://github.com/org/repo/pull/12')).toBe(
    'https://github.com/org/repo/pull/12',
  )
  expect(webHref('http://localhost:1420/')).toBe('http://localhost:1420/')
})

test('what is opened is the address as parsed, not as printed', () => {
  expect(webHref('  HTTPS://Example.com/a')).toBe('https://example.com/a')
})

test('mail, phone and every other scheme are refused', () => {
  expect(webHref('mailto:someone@example.com?subject=hi')).toBeNull()
  expect(webHref('tel:+15550100')).toBeNull()
  expect(webHref('file:///etc/passwd')).toBeNull()
  expect(webHref('javascript:alert(1)')).toBeNull()
  expect(webHref('x-apple.systempreferences:com.apple.preference')).toBeNull()
})

test('text that is not a URL at all is refused', () => {
  expect(webHref('github.com/org/repo')).toBeNull()
  expect(webHref('')).toBeNull()
})
