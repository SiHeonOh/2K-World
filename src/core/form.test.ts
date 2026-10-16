import { describe, expect, it } from 'vitest'
import { FORM_GAMES, FORM_MAX, seasonForms, type FormInput } from './form'

/** Twelve players whose points a game follow their value (value 70 → 10 points, 90 → 26), ten games each. */
function league(): { lines: Map<string, FormInput>; values: Map<string, number> } {
  const values = new Map<string, number>()
  const lines = new Map<string, FormInput>()
  for (let k = 0; k < 12; k++) {
    const value = 70 + k * 2
    const ppg = 10 + (value - 70) * 0.8 + (k % 2 === 0 ? 0.6 : -0.6)
    values.set(`p${k}`, value)
    lines.set(`p${k}`, { games: 10, points: ppg * 10, shots: (ppg / 1.15) * 10 })
  }
  return { lines, values }
}

describe('season form', () => {
  it('nudges a player clearly above or below what his value predicts, up to ±3, and leaves the rest alone', () => {
    const { lines, values } = league()
    // One scores far more than his value says (and efficiently), one far less, one about as expected.
    values.set('hot', 76)
    lines.set('hot', { games: 8, points: 8 * 24, shots: 8 * 17 })
    values.set('cold', 88)
    lines.set('cold', { games: 8, points: 8 * 12, shots: 8 * 13 })
    values.set('fine', 80)
    lines.set('fine', { games: 8, points: 8 * 18, shots: 8 * 15.6 })
    const forms = seasonForms(lines, values)
    expect(forms.get('hot')!.delta).toBeGreaterThan(1)
    expect(forms.get('hot')!.delta).toBeLessThanOrEqual(FORM_MAX)
    expect(forms.get('cold')!.delta).toBeLessThan(-1)
    expect(forms.get('cold')!.delta).toBeGreaterThanOrEqual(-FORM_MAX)
    expect(forms.get('fine')!.delta).toBe(0)
    expect(forms.get('hot')!.expected).toBeLessThan(forms.get('hot')!.ppg)
    expect(forms.get('hot')!.ts).toBeCloseTo(24 / 34, 2)
  })

  it('says nothing before a player has five games, or while too few players have', () => {
    const { lines, values } = league()
    values.set('new', 80)
    lines.set('new', { games: FORM_GAMES - 1, points: 30 * (FORM_GAMES - 1), shots: null })
    expect(seasonForms(lines, values).has('new')).toBe(false)
    const few = new Map([...lines].slice(0, 5))
    expect(seasonForms(few, values).size).toBe(0)
  })
})
