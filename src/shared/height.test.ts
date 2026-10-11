import { describe, expect, it } from 'vitest'
import { formatHeight, parseHeightCm } from './height'

describe('parseHeightCm', () => {
  it.each([
    [`6'4`, 193],
    [`6'4"`, 193],
    [`6' 10"`, 208.3],
    [`7'0`, 213.4],
    [`5'5`, 165.1],
    [`6-4`, 193],
    [`6ft 4in`, 193],
    [`6'`, 182.9],
    ['193cm', 193],
    ['193', 193],
    [' 201.5 cm ', 201.5],
  ])('%s → %s', (input, cm) => {
    expect(parseHeightCm(input)).toBe(cm)
  })

  it.each(['', 'tall', `6'13`, '45', '999'])('rejects %j', (input) => {
    expect(parseHeightCm(input)).toBeNull()
  })
})

describe('formatHeight', () => {
  it('formats both units', () => {
    expect(formatHeight(193, 'ft-in')).toBe(`6'4"`)
    expect(formatHeight(208.3, 'ft-in')).toBe(`6'10"`)
    expect(formatHeight(193.04, 'cm')).toBe('193cm')
    expect(formatHeight(null, 'cm')).toBe('')
  })
})
