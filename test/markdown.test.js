import { expect, test } from 'vitest'

import { splitInlineCode } from '../src/markdown.jsx'

// Reasons delimit code with single quotes; a lone apostrophe in prose must not.
test('quoted spans in a finding reason become inline code', () => {
  const segments = splitInlineCode("pre_install() invokes '/bin/sh'; a hook runs as root")
  expect(segments.filter((s) => s.code).map((s) => s.text)).toEqual(['/bin/sh'])
})

test('a lone apostrophe is not treated as code', () => {
  const segments = splitInlineCode("the built .INSTALL differs from the recipe's install= file")
  expect(segments.some((s) => s.code)).toBe(false)
})
