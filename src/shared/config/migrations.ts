import { CONFIG_VERSION } from './schema'

/**
 * Config migrations. Each step lifts a raw config one version up; the result
 * is validated by the schema afterwards. Add a step whenever CONFIG_VERSION
 * goes up, and never edit a step that has shipped.
 */
export interface MigrationStep {
  from: number
  up: (raw: Record<string, unknown>) => Record<string, unknown>
}

// Steps hold literal values, not calls to today's defaults, so they never change.
export const CONFIG_MIGRATIONS: MigrationStep[] = [
  // v1 → v2: box-score stat columns, as a 2K box score shows them.
  {
    from: 1,
    up: (c) => ({
      ...c,
      stats: {
        columns: [
          { id: 'pts', name: 'PTS', meaning: 'points', leader: true },
          { id: 'reb', name: 'REB', meaning: 'rebounds', leader: true },
          { id: 'ast', name: 'AST', meaning: 'assists', leader: true },
          { id: 'stl', name: 'STL', meaning: 'steals', leader: true },
          { id: 'blk', name: 'BLK', meaning: 'blocks', leader: true },
          { id: 'to', name: 'TO', meaning: 'turnovers', leader: false },
          { id: 'fgm', name: 'FGM', meaning: 'fgm', leader: false },
          { id: 'fga', name: 'FGA', meaning: 'fga', leader: false },
          { id: '3pm', name: '3PM', meaning: 'tpm', leader: true },
          { id: '3pa', name: '3PA', meaning: 'tpa', leader: false },
          { id: 'ftm', name: 'FTM', meaning: 'ftm', leader: false },
          { id: 'fta', name: 'FTA', meaning: 'fta', leader: false },
        ],
      },
    }),
  },
  // v2 → v3: the community (boards, personas, refresh and budget).
  {
    from: 2,
    up: (c) => {
      const league = (c.league ?? {}) as { name?: unknown; shortName?: unknown }
      const main = (typeof league.shortName === 'string' && league.shortName.trim()) || (typeof league.name === 'string' && league.name.trim()) || '메인'
      return {
        ...c,
        community: {
          enabled: true,
          myNick: '나',
          boards: [
            { id: 'main', name: main.slice(0, 40), role: 'main' },
            { id: 'games', name: '경기 결과/중계', role: 'games' },
            { id: 'trades', name: '트레이드·루머', role: 'trades' },
            { id: 'draft', name: '드래프트', role: 'draft' },
            { id: 'humor', name: '유머', role: 'humor' },
            { id: 'free', name: '자유', role: 'free' },
            { id: 'notice', name: '공지', role: 'notice' },
            { id: 'poten', name: '포텐', role: 'poten' },
          ],
          fans: 200,
          reporters: 5,
          maxSpice: 5,
          potenAt: 30,
          bestAt: 10,
          revealPerRefresh: 4,
          refillBelow: 8,
          chatterBatch: 30,
          dailyChatterJobs: 40,
          models: { thread: 'sonnet', reply: 'haiku', chatter: 'sonnet', article: 'sonnet' },
        },
      }
    },
  },
  // v3 → v4: one model and effort per AI job (편집실 → AI 모델). The models chosen per section carry
  // over; jobs that borrowed another's setting (wiki and players' words: article; live comments:
  // replies; the AI draft: GM answers) start from it. Effort starts at Claude Code's default.
  {
    from: 3,
    up: (c) => {
      const section = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
      const community = section(c.community)
      const gm = section(c.gm)
      const lore = section(c.lore)
      const pick = (s: Record<string, unknown> | undefined, key: string, fallback: string) => {
        const m = section(s?.models)?.[key]
        return typeof m === 'string' && ['haiku', 'sonnet', 'opus'].includes(m) ? m : fallback
      }
      const job = (model: string) => ({ model, effort: 'default' })
      const strip = (s: Record<string, unknown> | undefined) => {
        if (!s) return s
        const { models: _models, ...rest } = s
        return rest
      }
      return {
        ...c,
        community: strip(community),
        gm: strip(gm),
        lore: strip(lore),
        ai: {
          jobs: {
            gameThread: job(pick(community, 'thread', 'sonnet')),
            article: job(pick(community, 'article', 'sonnet')),
            reply: job(pick(community, 'reply', 'haiku')),
            live: job(pick(community, 'reply', 'haiku')),
            chatter: job(pick(community, 'chatter', 'sonnet')),
            wiki: job(pick(community, 'article', 'sonnet')),
            player: job(pick(community, 'article', 'sonnet')),
            loreDraft: job(pick(lore, 'draft', 'sonnet')),
            loreSweep: job(pick(lore, 'suggest', 'sonnet')),
            gmIntent: job(pick(gm, 'intent', 'sonnet')),
            gmRespond: job(pick(gm, 'respond', 'sonnet')),
            gmDraft: job(pick(gm, 'respond', 'sonnet')),
            screenshot: job('sonnet'),
          },
        },
      }
    },
  },
]

export class MigrationError extends Error {
  constructor(
    readonly code: 'not-an-object' | 'no-version' | 'too-new' | 'missing-step',
    readonly version?: number,
  ) {
    super(`config migration failed: ${code}${version === undefined ? '' : ` (v${version})`}`)
  }
}

export function migrateConfig(
  raw: unknown,
  steps: MigrationStep[] = CONFIG_MIGRATIONS,
  target: number = CONFIG_VERSION,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MigrationError('not-an-object')
  let current = structuredClone(raw) as Record<string, unknown>
  let version = current.version
  if (typeof version !== 'number' || !Number.isInteger(version)) throw new MigrationError('no-version')
  if (version > target) throw new MigrationError('too-new', version)
  while (version < target) {
    const step = steps.find((s) => s.from === version)
    if (!step) throw new MigrationError('missing-step', version)
    current = step.up(current)
    current.version = version + 1
    version += 1
  }
  return current
}
