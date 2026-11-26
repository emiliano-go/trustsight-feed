import { describe, expect, it } from 'vitest'
import catalog from '../src/rule-catalog.generated.json'
import plain from '../src/rule-plain.json'

// Words that only mean something to someone who already knows the tool.
const JARGON = /\b(anergic|B10|L9|A2|A8|weight[- ]?0|weighted|corpus|federated|ledger)\b/i

describe('the generated rule catalog', () => {
  it('explains every rule with prose, never with a page heading', () => {
    // The generator reads docs/rules/*.md. A rule followed by the page's
    // `## Interpretation` heading used to take that heading as its
    // description, and the feed rendered "## Interpretation" as the rule's
    // explanation (H073, 2026-11-26).
    const headingLike = Object.values(catalog)
      .filter((rule) => /^#{1,6}\s/.test(String(rule.description || '').trim()))
      .map((rule) => rule.id)
    expect(headingLike).toEqual([])
  })

  it('keeps H073 tied to its documented condition', () => {
    expect(catalog.h073.description).toMatch(/introduction rate/i)
    expect(catalog.h073.severity).toBe('MEDIUM')
  })

  it('carries the fields a chip needs, and says when a rule is not emitted', () => {
    for (const rule of Object.values(catalog)) {
      expect(rule.id).toBeTruthy()
      expect(rule.name).toBeTruthy()
      expect(rule.docsUrl).toBeTruthy()
      // A retired anchor has no severity; the chip renders "not emitted"
      // rather than an empty badge.
      expect(Boolean(rule.severity) || rule.emitted === false).toBe(true)
    }
  })

  it('keeps emitted rules out of the not-emitted bucket', () => {
    const silent = Object.values(catalog).filter((rule) => rule.emitted === false)
    expect(silent.map((rule) => rule.id).sort()).toEqual(
      ['H005', 'H006', 'H007', 'H008', 'H009', 'H010', 'H011', 'H012', 'H013', 'H014', 'H028'],
    )
  })
})

describe('the plain-language layer', () => {
  it('explains every rule the catalogue lists', () => {
    const missing = Object.values(catalog)
      .map((rule) => rule.id)
      .filter((id) => !plain[id])
    expect(missing).toEqual([])
  })

  it('keeps each line short enough to read at a glance', () => {
    const long = Object.entries(plain)
      .filter(([, text]) => text.length > 160)
      .map(([id]) => id)
    expect(long).toEqual([])
  })

  it('does not explain a public reader with internal vocabulary', () => {
    expect(Object.entries(plain).filter(([, text]) => JARGON.test(text)).map(([id]) => id)).toEqual([])
  })

  it('has no entry the catalogue cannot show', () => {
    const known = new Set(Object.values(catalog).map((rule) => rule.id))
    expect(Object.keys(plain).filter((id) => !known.has(id))).toEqual([])
  })
})
