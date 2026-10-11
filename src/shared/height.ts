/**
 * Heights as 2K and spreadsheets write them: 6'4", 6'4, 6-4, 6 ft 4 in,
 * 193cm, 193. Returns centimetres, or null when unreadable.
 */
export function parseHeightCm(text: string): number | null {
  const s = text.trim().replace(/[’′]/g, "'").replace(/[”″]/g, '"')
  if (s === '') return null

  const ftIn = s.match(/^(\d)\s*(?:'|ft|-|\s)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:"|in|'')?$/i)
  if (ftIn) {
    const feet = Number(ftIn[1])
    const inches = ftIn[2] === undefined ? 0 : Number(ftIn[2])
    if (inches >= 12) return null
    return round1((feet * 12 + inches) * 2.54)
  }

  const cm = s.match(/^(\d{2,3}(?:\.\d+)?)\s*(?:cm)?$/i)
  if (cm) {
    const value = Number(cm[1])
    return value >= 100 && value <= 260 ? round1(value) : null
  }
  return null
}

export function formatHeight(cm: number | null, unit: 'ft-in' | 'cm'): string {
  if (cm === null) return ''
  if (unit === 'cm') return `${Math.round(cm)}cm`
  const totalInches = Math.round(cm / 2.54)
  return `${Math.floor(totalInches / 12)}'${totalInches % 12}"`
}

const round1 = (n: number) => Math.round(n * 10) / 10
