import { describe, expect, it } from 'vitest'
import { chunk } from '../src/util.js'

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
