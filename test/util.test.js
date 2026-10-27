import { describe, expect, it } from 'vitest'
import { chunk, flattenProse, lastNotification } from '../src/util.js'

describe('chunk', () => {
  it('keeps every item in bounded batches', () => {
    const items = Array.from({ length: 510 }, (_, i) => `pkg-${i}`)
    const batches = chunk(items, 100)
    expect(batches).toHaveLength(6)
    expect(batches[0]).toHaveLength(100)
    expect(batches[5]).toHaveLength(10)
    expect(batches.flat()).toEqual(items)
  })

  it('does not invent an empty batch', () => {
    expect(chunk([], 100)).toEqual([])
  })
})

describe('lastNotification', () => {
  it('uses whichever notification arrived last', () => {
    expect(lastNotification({ last_alert: 100, last_alive: 200 })).toBe(200)
    expect(lastNotification({ last_alert: 300, last_alive: 200 })).toBe(300)
    expect(lastNotification({ last: 400, last_alert: 300, last_alive: 200 })).toBe(400)
  })

  it('accepts one side and ignores absent timestamps', () => {
    expect(lastNotification({ last_alert: null, last_alive: 42 })).toBe(42)
    expect(lastNotification({ last_alert: 42 })).toBe(42)
    expect(lastNotification({ last_alert: null, last_alive: null })).toBeNull()
    expect(lastNotification(null)).toBeNull()
  })
})

describe('flattenProse', () => {
  it('collapses hard line breaks so the viewport decides where to wrap', () => {
    expect(flattenProse('A sentence\nthat was hand-wrapped.')).toBe('A sentence that was hand-wrapped.')
    expect(flattenProse('  first\r\n\r\nsecond  ')).toBe('first second')
  })

  it('handles absent text', () => {
    expect(flattenProse(null)).toBe('')
    expect(flattenProse(undefined)).toBe('')
  })
})

describe('parseDiff', () => {
  it('parses a stored diff that has no diff --git header', async () => {
    const { parseDiff } = await import('../src/Message.jsx')
    const files = parseDiff('--- a/PKGBUILD\n+++ b/PKGBUILD\n@@ -1,1 +1,1 @@\n-pkgver=1\n+pkgver=2\n')
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('PKGBUILD')
    expect(files[0].rows.filter((row) => row.type === 'add')).toHaveLength(1)
    expect(files[0].rows.filter((row) => row.type === 'del')).toHaveLength(1)
  })

  it('keeps multiple plain-diff files apart', async () => {
    const { parseDiff } = await import('../src/Message.jsx')
    const text = [
      '--- a/PKGBUILD', '+++ b/PKGBUILD', '@@ -1,1 +1,1 @@', '-a', '+b',
      '--- a/example.install', '+++ b/example.install', '@@ -1,1 +1,1 @@', '-c', '+d',
    ].join('\n')
    expect(parseDiff(text).map((file) => file.name)).toEqual(['PKGBUILD', 'example.install'])
  })
})
