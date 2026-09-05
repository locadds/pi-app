import { describe, expect, it } from 'vitest'

import {
  hasUnsafeDirectCodingCommandTextV1,
  isSafeDirectCodingDisplayLabelV1,
  sanitizeDirectCodingDisplayLabelV1,
} from './xiaogui-direct-coding'

const bidiControls = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']

describe('direct CODING display safety', () => {
  it.each(bidiControls)('rejects command direction control U+%s', (control) => {
    expect(hasUnsafeDirectCodingCommandTextV1(`echo before${control}after`)).toBe(true)
  })

  it('preserves ordinary multiline and tabbed commands', () => {
    expect(hasUnsafeDirectCodingCommandTextV1('echo first\necho second\t# visible')).toBe(false)
  })

  it.each(bidiControls)('removes direction controls from display-only labels', (control) => {
    const cleaned = sanitizeDirectCodingDisplayLabelV1(`项目${control}A`)
    expect(cleaned).toBe('项目 A')
    expect(isSafeDirectCodingDisplayLabelV1(cleaned)).toBe(true)
    expect(isSafeDirectCodingDisplayLabelV1(`项目${control}A`)).toBe(false)
  })
})
