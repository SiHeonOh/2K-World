import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkLore, loadLoreFolder, loreBlock, relocateLore, type LeagueRefs } from './folder'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), '2kw-lore-'))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

const playerFile = (id: string, pub = '', secret = '') => `---\nid: ${id}\n---\n\n# ${id}\n\n## 공개\n${pub}\n\n## 소문\n\n## 비밀\n${secret}\n`

describe('lore folder', () => {
  it('loads teams and world, skips templates, and collects errors', () => {
    const dir = folder({
      'teams/가람고/가람고.md': '---\nid: 가람고\n---\n## 공개\n전통의 명문.\n',
      'teams/가람고/가람고 단장.md': '---\nid: 가람고 단장\nteam: 가람고\n---\n',
      'teams/가람고/허다솜.md': playerFile('허다솜', '슈터.', '이적 희망.'),
      'teams/가람고/김온유(누리고).md': playerFile('김온유(누리고)'),
      'teams/가람고/고장난.md': '---\nid: [\n---\n',
      'world/왕 논쟁.md': '---\nid: 왕 논쟁\ntype: topic\n---\n## 공개\n누가 진짜 왕인가.\n',
      '_templates/player.md': playerFile('선수이름'),
    })
    const { entries, errors } = loadLoreFolder(dir)
    expect(entries.map((e) => e.file).sort()).toEqual([
      'teams/가람고/가람고 단장.md',
      'teams/가람고/가람고.md',
      'teams/가람고/김온유(누리고).md',
      'teams/가람고/허다솜.md',
      'world/왕 논쟁.md',
    ])
    expect(errors.map((e) => [e.file, e.code])).toEqual([['teams/가람고/고장난.md', 'yaml']])

    const links = linkLore(entries, {
      teams: [{ id: 't1', shortName: '가람고' }],
      players: [
        { id: 'p1', name: '허다솜', teamId: 't1' },
        { id: 'p2', name: '김온유', teamId: 't1' },
        { id: 'p3', name: '강하늘', teamId: 't1' },
      ],
    })
    expect(links.team.get('t1')?.kind).toBe('team')
    expect(links.gm.get('t1')?.kind).toBe('gm')
    expect(links.player.get('p1')?.file).toBe('teams/가람고/허다솜.md')
    expect(links.player.get('p2')?.file).toBe('teams/가람고/김온유(누리고).md')
    expect(links.playersWithout).toEqual(['p3'])
    expect(links.world).toHaveLength(1)
  })

  it('never gives writers the secret section', () => {
    const dir = folder({ 'teams/가람고/허다솜.md': playerFile('허다솜', '슈터.', '이적 희망.') })
    const [entry] = loadLoreFolder(dir).entries
    expect(loreBlock(entry, '허다솜', 'public')).toBe('## 허다솜\n[공개]\n슈터.')
    expect(loreBlock(entry, '허다솜', 'rumor')).not.toContain('이적 희망')
    expect(loreBlock(entry, '허다솜', 'gm')).not.toContain('이적 희망')
    expect(loreBlock(entry, '허다솜', 'self')).toContain('[비밀 — 직접 말하지 말 것]\n이적 희망.')
    expect(loreBlock(undefined, 'x', 'public')).toBe('')
  })

  it('keeps a traded player linked and moves his file to his new team, never overwriting', () => {
    const dir = folder({
      'teams/가람고/허다솜.md': playerFile('허다솜', '슈터.'),
      'teams/가람고/강하늘.md': playerFile('강하늘'),
      'teams/누리고/누리고.md': '---\nid: 누리고\n---\n',
      // Someone already started a file under the same name at the new school.
      'teams/누리고/강하늘.md': playerFile('강하늘', '새로 쓴 글.'),
    })
    const refs: LeagueRefs = {
      teams: [
        { id: 't1', shortName: '가람고' },
        { id: 't2', shortName: '누리고' },
      ],
      players: [
        { id: 'p1', name: '허다솜', teamId: 't2', firstTeamId: 't1' },
        { id: 'p2', name: '강하늘', teamId: 't2', firstTeamId: 't1' },
      ],
    }
    const links = linkLore(loadLoreFolder(dir).entries, refs)
    // Still used before the move.
    expect(links.player.get('p1')?.sections.public).toBe('슈터.')
    // The file already in his team's folder wins; the old one waits for you.
    expect(links.player.get('p2')?.file).toBe('teams/누리고/강하늘.md')
    expect(links.orphanFiles).toEqual(['teams/가람고/강하늘.md'])
    expect(links.misplaced).toEqual([{ file: 'teams/가람고/허다솜.md', playerId: 'p1', to: 'teams/누리고/허다솜.md' }])

    expect(relocateLore(dir, links.misplaced)).toEqual({ moved: [{ from: 'teams/가람고/허다솜.md', to: 'teams/누리고/허다솜.md' }], skipped: [] })
    expect(existsSync(join(dir, 'teams/가람고/허다솜.md'))).toBe(false)
    const after = linkLore(loadLoreFolder(dir).entries, refs)
    expect(after.player.get('p1')?.file).toBe('teams/누리고/허다솜.md')
    expect(after.misplaced).toEqual([])

    // A name already taken at the destination is never overwritten.
    writeFileSync(join(dir, 'teams/가람고/허다솜.md'), playerFile('허다솜', '다른 파일.'))
    const result = relocateLore(dir, [{ file: 'teams/가람고/허다솜.md', playerId: 'p1', to: 'teams/누리고/허다솜.md' }])
    expect(result.skipped).toEqual([{ file: 'teams/가람고/허다솜.md', to: 'teams/누리고/허다솜.md', reason: 'taken', message: '' }])
    expect(readFileSync(join(dir, 'teams/누리고/허다솜.md'), 'utf8')).toContain('슈터.')
    expect(readFileSync(join(dir, 'teams/가람고/허다솜.md'), 'utf8')).toContain('다른 파일.')

    // Never anywhere but another team folder.
    for (const to of ['teams/누리고/허/다솜.md', 'teams/누리고/허\\다솜.md', 'world/허다솜.md', 'teams/누리고/nul.md']) {
      expect(relocateLore(dir, [{ file: 'teams/가람고/허다솜.md', playerId: 'p1', to }]).skipped[0]?.reason).toBe('failed')
    }
    expect(existsSync(join(dir, 'teams/가람고/허다솜.md'))).toBe(true)
  })

  it('tells same-name players apart by the first team in brackets, or by folder', () => {
    const teams = [
      { id: 't1', shortName: '가람고' },
      { id: 't2', shortName: '누리고' },
      { id: 't3', shortName: '다온고' },
    ]
    // Bracketed: both 김하람 end up at 누리고, and each file still finds its own.
    const bracketed = folder({
      'teams/가람고/김하람(가람고).md': playerFile('김하람(가람고)', '가람고 김하람.'),
      'teams/누리고/김하람(누리고).md': playerFile('김하람(누리고)', '누리고 김하람.'),
    })
    let links = linkLore(loadLoreFolder(bracketed).entries, {
      teams,
      players: [
        { id: 'a', name: '김하람', teamId: 't2', firstTeamId: 't1' },
        { id: 'b', name: '김하람', teamId: 't2', firstTeamId: 't2' },
      ],
    })
    expect(links.player.get('a')?.sections.public).toBe('가람고 김하람.')
    expect(links.player.get('b')?.sections.public).toBe('누리고 김하람.')
    expect(links.misplaced).toEqual([{ file: 'teams/가람고/김하람(가람고).md', playerId: 'a', to: 'teams/누리고/김하람(가람고).md' }])

    // No brackets, and the two swapped for each other: each folder keeps its first player,
    // and a moved file gains his first team in brackets so it stays his.
    const plain = folder({
      'teams/가람고/김하람.md': playerFile('김하람', '가람고 김하람.'),
      'teams/누리고/김하람.md': playerFile('김하람', '누리고 김하람.'),
    })
    const swapped: LeagueRefs = {
      teams,
      players: [
        { id: 'a', name: '김하람', teamId: 't2', firstTeamId: 't1' },
        { id: 'b', name: '김하람', teamId: 't1', firstTeamId: 't2' },
      ],
    }
    links = linkLore(loadLoreFolder(plain).entries, swapped)
    expect(links.player.get('a')?.sections.public).toBe('가람고 김하람.')
    expect(links.player.get('b')?.sections.public).toBe('누리고 김하람.')
    expect(links.misplaced.map((m) => m.to).sort()).toEqual(['teams/가람고/김하람(누리고).md', 'teams/누리고/김하람(가람고).md'])
    expect(relocateLore(plain, links.misplaced).moved).toHaveLength(2)
    links = linkLore(loadLoreFolder(plain).entries, swapped)
    expect(links.player.get('a')?.file).toBe('teams/누리고/김하람(가람고).md')
    expect(links.player.get('b')?.file).toBe('teams/가람고/김하람(누리고).md')
    expect(links.misplaced).toEqual([])

    // Later one of them moves on: the bracket still finds him, and the file keeps its name.
    links = linkLore(loadLoreFolder(plain).entries, {
      teams,
      players: [
        { id: 'a', name: '김하람', teamId: 't3', firstTeamId: 't1', teamIds: ['t1', 't2', 't3'] },
        { id: 'b', name: '김하람', teamId: 't1', firstTeamId: 't2', teamIds: ['t2', 't1'] },
      ],
    })
    expect(links.misplaced).toEqual([{ file: 'teams/누리고/김하람(가람고).md', playerId: 'a', to: 'teams/다온고/김하람(가람고).md' }])
  })

  it('never hands a file to the wrong same-name player, before or after a move', () => {
    const teams = [
      { id: 't1', shortName: '가람고' },
      { id: 't2', shortName: '누리고' },
      { id: 't3', shortName: '다온고' },
    ]
    // a was traded from 가람고 to 누리고, where b started. a's bracket isn't his first school.
    const traded: LeagueRefs = {
      teams,
      players: [
        { id: 'a', name: '김하람', teamId: 't2', firstTeamId: 't1', teamIds: ['t1', 't2'] },
        { id: 'b', name: '김하람', teamId: 't2', firstTeamId: 't2', teamIds: ['t2'] },
      ],
    }
    for (const bracket of ['가드', '다온고']) {
      const dir = folder({ [`teams/가람고/김하람(${bracket}).md`]: playerFile(`김하람(${bracket})`, 'a의 이야기.', 'a의 비밀.') })
      let links = linkLore(loadLoreFolder(dir).entries, traded)
      expect(links.player.get('a')?.sections.secret).toBe('a의 비밀.')
      // It moves under his first school's bracket, which still finds him at 누리고.
      expect(links.misplaced).toEqual([{ file: `teams/가람고/김하람(${bracket}).md`, playerId: 'a', to: 'teams/누리고/김하람(가람고).md' }])
      relocateLore(dir, links.misplaced)
      links = linkLore(loadLoreFolder(dir).entries, traded)
      expect(links.player.get('a')?.sections.secret).toBe('a의 비밀.')
      expect(links.player.has('b')).toBe(false)
    }

    // The bracket names b (he started at 누리고), but the file sits where only a has played.
    // Whose is it: b's file in the wrong folder, or a's under an older school? Nobody's, until you say.
    const fresh: LeagueRefs = {
      teams,
      players: [
        { id: 'a', name: '김하람', teamId: 't1' },
        { id: 'b', name: '김하람', teamId: 't2', firstTeamId: 't2', teamIds: ['t2', 't3'] },
      ],
    }
    let dir = folder({
      'teams/가람고/김하람(누리고).md': playerFile('김하람(누리고)', '누구의 이야기?'),
      'teams/다온고/김하람(가람고).md': playerFile('김하람(가람고)', '누구의 이야기?'),
    })
    let links = linkLore(loadLoreFolder(dir).entries, fresh)
    expect(links.player.size).toBe(0)
    expect(links.orphanFiles.sort()).toEqual(['teams/가람고/김하람(누리고).md', 'teams/다온고/김하람(가람고).md'])
    expect(links.misplaced).toEqual([])

    // Team folders match the way Windows matches them, so a move into `kgc/` still links.
    dir = folder({ 'teams/kgc/김하람.md': playerFile('김하람', 'c의 이야기.') })
    links = linkLore(loadLoreFolder(dir).entries, { teams: [{ id: 'k', shortName: 'KGC' }], players: [{ id: 'c', name: '김하람', teamId: 'k' }] })
    expect(links.player.get('c')?.sections.public).toBe('c의 이야기.')

    // A note about an old 가람고 player who shares a name with someone who never played there: not his, never moved.
    dir = folder({ 'teams/가람고/박지성.md': playerFile('박지성', '전설.') })
    links = linkLore(loadLoreFolder(dir).entries, { teams, players: [{ id: 'c', name: '박지성', teamId: 't3' }] })
    expect(links.player.size).toBe(0)
    expect(links.orphanFiles).toEqual(['teams/가람고/박지성.md'])
    expect(links.misplaced).toEqual([])
  })

  it('lists two files for one player, and matches names however Korean was typed', () => {
    const teams = [
      { id: 't1', shortName: '가람고' },
      { id: 't2', shortName: '누리고' },
    ]
    const refs: LeagueRefs = { teams, players: [{ id: 'p1', name: '허다솜', teamId: 't2', firstTeamId: 't1', teamIds: ['t1', 't2'] }] }
    // Saved again at the old path after the app moved it (an editor had it open).
    let dir = folder({
      'teams/가람고/허다솜.md': playerFile('허다솜', '새로 고친 글.'),
      'teams/누리고/허다솜.md': playerFile('허다솜', '옮겨진 글.'),
    })
    let links = linkLore(loadLoreFolder(dir).entries, refs)
    expect(links.player.get('p1')?.sections.public).toBe('옮겨진 글.')
    expect(links.duplicates).toEqual([{ playerId: 'p1', files: ['teams/가람고/허다솜.md', 'teams/누리고/허다솜.md'], kept: 'teams/누리고/허다솜.md' }])
    expect(links.misplaced).toEqual([])

    // A Mac-typed (NFD) file name links, and moves into the folder already there, spelled however it is.
    const nfd = (s: string) => s.normalize('NFD')
    dir = folder({ [`teams/가람고/${nfd('허다솜')}.md`]: playerFile('허다솜', '슈터.'), [`teams/${nfd('누리고')}/${nfd('누리고')}.md`]: '---\nid: 누리고\n---\n' })
    links = linkLore(loadLoreFolder(dir).entries, refs)
    expect(links.player.get('p1')?.sections.public).toBe('슈터.')
    expect(relocateLore(dir, links.misplaced).moved).toEqual([{ from: `teams/가람고/${nfd('허다솜')}.md`, to: `teams/${nfd('누리고')}/${nfd('허다솜')}.md` }])
    // No second 누리고 folder.
    expect(readdirSync(join(dir, 'teams'))).toHaveLength(2)
    // The same name in the other spelling counts as taken.
    writeFileSync(join(dir, 'teams/가람고/허다솜.md'), playerFile('허다솜', '또 다른 파일.'))
    expect(relocateLore(dir, [{ file: 'teams/가람고/허다솜.md', playerId: 'p1', to: 'teams/누리고/허다솜.md' }]).skipped[0]?.reason).toBe('taken')
  })
})
