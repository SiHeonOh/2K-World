import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupKind } from '@shared/backups'
import { backupsText } from '../renderer/i18n/ko-backups'
import { ko } from '../renderer/i18n/ko'

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8')

describe('what the screens say about backups', () => {
  it('names every reason a backup is made for', () => {
    const guarded = [...source('handlers.ts').matchAll(/guarded\(\s*\w+,\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!)
    expect(guarded.length).toBeGreaterThan(5)
    for (const reason of [...guarded, 'manual', 'open', 'upgrade-v17', 'before-restore']) {
      expect(backupsText.reasons[backupKind(reason)], reason).toBeDefined()
    }
  })

  it('explains every refusal of a restore', () => {
    const codes = ['backup.ts', 'loreSnapshots.ts', 'leagues.ts'].flatMap((f) => [...source(f).matchAll(/refuse\('([a-z-]+)'/g)].map((m) => m[1]!))
    expect(codes).toContain('lore-busy')
    for (const code of codes) expect((ko.rules as Record<string, unknown>)[code], code).toBeDefined()
  })

  it('asks before an award is taken back, naming it and its winner', () => {
    const text = ko.awards.confirmRemove('정규시즌 MVP', '가가가 (가람고)')
    expect(text).toContain('정규시즌 MVP')
    expect(text).toContain('가가가 (가람고)')
  })
})
