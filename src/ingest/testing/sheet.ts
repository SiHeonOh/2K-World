import * as XLSX from 'xlsx'

/**
 * Builds a made-up roster workbook shaped like a typical league sheet:
 * merged nickname/notes columns, a slot column whose order differs per team,
 * a trailing space in one name, a name shared by two teams, and a stray
 * half-row far below the table.
 */
export function makeRosterWorkbook(): Uint8Array {
  const header = [
    'Division', 'Team', 'Name', 'Height', 'Position', 'Ovrl Rating',
    'Shooting', 'Defense', 'Nicknames', null, null, 'Notes',
  ]
  const slots = ['PG', 'SG', 'SF', 'PF', 'C', '6th Man']
  const teams = [
    { div: '북부', team: '가람고등학교' },
    { div: '북부', team: '누리고등학교' },
    { div: '남부', team: '다솜고등학교' },
    { div: '남부', team: '마루중학교' },
  ]
  const grades = ['A+', 'A', 'B+', 'B-', 'C', 'D+']
  const rows: (string | number | null)[][] = [header]
  teams.forEach((t, ti) => {
    const order = ti === 1 ? ['SG', '6th Man', 'SF', 'PF', 'C', 'PG'] : slots
    order.forEach((slot, si) => {
      let name = `${'가나다마'[ti]}선수${si + 1}`
      if (ti === 0 && si === 3) name = '동명이'
      if (ti === 2 && si === 0) name = '동명이 '
      rows.push([
        t.div, t.team, name, `6'${si + 2}`, slot, 70 + ti * 5 + si,
        grades[(ti + si) % grades.length]!, grades[si % grades.length]!.toLowerCase(),
        si === 0 ? '별명1, 별명2' : null, null, null, si === 1 ? '메모' : null,
      ])
    })
  })
  // A stray copy of part of a row, shifted right and far below (as in real sheets).
  while (rows.length < 40) rows.push([])
  rows.push([null, null, null, null, null, null, '가선수1', `6'2`, 'PG', 70])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [
    { s: { r: 0, c: 8 }, e: { r: 0, c: 10 } },
    ...rows.slice(1, 25).map((_, i) => ({ s: { r: i + 1, c: 8 }, e: { r: i + 1, c: 10 } })),
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Roster')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['memo only']]), 'Other')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

/** A one-sheet .xlsx from rows, with merges given as A1 ranges (e.g. 'A2:A4'). */
export function makeWorkbook(rows: (string | number | null)[][], merges: string[] = []): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges.map((m) => XLSX.utils.decode_range(m))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

let eucKr: Map<string, number[]> | undefined

/** EUC-KR (CP949) bytes for test text. Node decodes EUC-KR but can't encode it, so the table is built by decoding. */
export function encodeEucKr(text: string): Uint8Array {
  if (!eucKr) {
    eucKr = new Map()
    const decoder = new TextDecoder('euc-kr')
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x41; trail <= 0xfe; trail++) {
        const ch = decoder.decode(new Uint8Array([lead, trail]))
        if (ch.length === 1 && ch !== '�' && !eucKr.has(ch)) eucKr.set(ch, [lead, trail])
      }
    }
  }
  const bytes: number[] = []
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const pair = eucKr.get(ch)
    if (!pair) throw new Error(`not in EUC-KR: ${ch}`)
    bytes.push(...pair)
  }
  return new Uint8Array(bytes)
}
