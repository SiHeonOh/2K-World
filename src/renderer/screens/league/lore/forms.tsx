import type { LeagueSnapshot } from '@shared/league'
import {
  GM_TRAITS,
  HOOK_TRIGGERS,
  MEDIA_STYLES,
  MOOD_PARTS,
  NEGOTIATION_STYLES,
  PHILOSOPHIES,
  PLAYER_TRAITS,
  RELATIONSHIP_TYPES,
  VISIBILITIES,
  WORLD_TYPES,
  type GmLoreSettings,
  type LoreHook,
  type LoreKind,
  type LoreRelationship,
  type LoreSectionKey,
  type LoreSections,
  type MoodPartKey,
  type PlayerLoreSettings,
  type TeamLoreSettings,
  type WorldLoreSettings,
} from '@shared/lore'
import { Check, NumberInput, Segmented, Select } from '../../../components/ui'
import { t } from '../../../i18n'
import { AutoTextarea, Block, ChipList, ColorList, PersonPicker, Scale } from './controls'
import { resolvePlayer, type People } from './people'

const tl = t.lore
const SECTION_KEYS: LoreSectionKey[] = ['public', 'rumor', 'secret']
const options = <T extends string>(values: readonly T[], labels: Record<string, string>) => values.map((v) => ({ value: v, label: labels[v] ?? v }))

export interface LoreContext {
  league: LeagueSnapshot
  people: People
  firstTeams: Record<string, string>
  disabled: boolean
}

// ── 이야기 ───────────────────────────────────────────────────────────────

export function StoryTab({
  kind,
  sections,
  canon,
  split,
  disabled,
  onSection,
  onCanon,
}: {
  kind: LoreKind
  sections: LoreSections
  canon: boolean
  split: LoreSectionKey[]
  disabled: boolean
  onSection: (key: LoreSectionKey, text: string) => void
  onCanon: (canon: boolean) => void
}) {
  return (
    <div className="lore-tab">
      {SECTION_KEYS.map((key) => (
        <section key={key} className={`lore-section ${key}`}>
          <div className="lore-section-head">
            <h3>
              <span className="lore-section-dot" aria-hidden />
              {tl.sections[key]}
            </h3>
            <span className="lore-section-audience">{tl.audience[key]}</span>
            <span className="lore-section-count">{tl.chars(sections[key].length)}</span>
          </div>
          {split.includes(key) ? <p className="help">{tl.splitSection}</p> : null}
          <AutoTextarea
            value={sections[key]}
            ariaLabel={tl.sections[key]}
            placeholder={tl.placeholders[kind]?.[key]}
            readOnly={disabled || split.includes(key)}
            minRows={key === 'public' ? 6 : 4}
            onChange={(v) => onSection(key, v)}
          />
        </section>
      ))}
      <div className="lore-canon">
        <Check checked={!canon} onChange={(v) => !disabled && onCanon(!v)}>
          {tl.canon}
        </Check>
        <span className="help">{tl.canonHelp}</span>
      </div>
    </div>
  )
}

// ── 성격 / 성향 ──────────────────────────────────────────────────────────

function TraitRows<K extends string>({
  keys,
  info,
  values,
  disabled,
  onChange,
}: {
  keys: readonly K[]
  info: Record<string, { name: string; help: string; low: string; high: string }>
  values: Record<K, number>
  disabled: boolean
  onChange: (key: K, v: number) => void
}) {
  return (
    <div className="lore-traits">
      {keys.map((k) => (
        <div key={k} className="lore-trait">
          <div className="lore-trait-name">
            <b>{info[k]?.name ?? k}</b>
            <span className="help">{info[k]?.help}</span>
          </div>
          <Scale value={values[k]} low={info[k]?.low} high={info[k]?.high} ariaLabel={info[k]?.name ?? k} disabled={disabled} onChange={(v) => onChange(k, v)} />
        </div>
      ))}
    </div>
  )
}

export function PlayerTraitsTab({ value, edit, disabled }: { value: PlayerLoreSettings; edit: (f: (s: PlayerLoreSettings) => void) => void; disabled: boolean }) {
  return (
    <div className="lore-tab">
      <Block title={tl.tabs.traits} help={tl.traitsIntro}>
        <TraitRows keys={PLAYER_TRAITS} info={tl.playerTraits} values={value.traits} disabled={disabled} onChange={(k, v) => edit((s) => void (s.traits[k] = v))} />
      </Block>
      <Block title={tl.media} help={tl.mediaHelp}>
        <Segmented
          ariaLabel={tl.media}
          value={value.media}
          options={options(MEDIA_STYLES, tl.mediaStyles)}
          onChange={(v) => !disabled && edit((s) => void (s.media = v))}
        />
      </Block>
    </div>
  )
}

export function GmTab({ value, edit, disabled }: { value: GmLoreSettings; edit: (f: (s: GmLoreSettings) => void) => void; disabled: boolean }) {
  return (
    <div className="lore-tab">
      <Block title={tl.gmName}>
        <input
          type="text"
          className="lore-input"
          value={value.name ?? ''}
          placeholder={tl.gmNamePlaceholder}
          maxLength={40}
          aria-label={tl.gmName}
          disabled={disabled}
          onChange={(e) => edit((s) => void (s.name = e.target.value.trim() === '' ? null : e.target.value))}
        />
      </Block>
      <Block title={tl.philosophy} help={tl.philosophyHelp[value.philosophy]}>
        <Segmented ariaLabel={tl.philosophy} value={value.philosophy} options={options(PHILOSOPHIES, tl.philosophies)} onChange={(v) => !disabled && edit((s) => void (s.philosophy = v))} />
      </Block>
      <Block title={tl.negotiation}>
        <Segmented
          ariaLabel={tl.negotiation}
          value={value.negotiation}
          options={options(NEGOTIATION_STYLES, tl.negotiationStyles)}
          onChange={(v) => !disabled && edit((s) => void (s.negotiation = v))}
        />
      </Block>
      <Block title={tl.tabs.gm} help={tl.gmTraitsIntro}>
        <TraitRows keys={GM_TRAITS} info={tl.gmTraits} values={value.traits} disabled={disabled} onChange={(k, v) => edit((s) => void (s.traits[k] = v))} />
      </Block>
    </div>
  )
}

// ── 학교 ─────────────────────────────────────────────────────────────────

export function TeamTab({ value, edit, ctx }: { value: TeamLoreSettings; edit: (f: (s: TeamLoreSettings) => void) => void; ctx: LoreContext }) {
  const others = ctx.people.schools.filter((s) => s.value !== value.id)
  return (
    <div className="lore-tab">
      <Block title={tl.colors} help={tl.colorsHelp}>
        <ColorList values={value.colors} addLabel={tl.addColor} onChange={(v) => !ctx.disabled && edit((s) => void (s.colors = v))} />
      </Block>
      <Block title={tl.fans} help={tl.fansHelp}>
        <TraitRows keys={['size', 'temperament', 'pride'] as const} info={tl.fanTraits} values={value.fans} disabled={ctx.disabled} onChange={(k, v) => edit((s) => void (s.fans[k] = v))} />
      </Block>
      <Block title={tl.rivals} help={tl.rivalsHelp}>
        <ChipList values={value.rivals} people={others} addLabel={tl.addRival} ariaLabel={tl.rivals} onChange={(v) => !ctx.disabled && edit((s) => void (s.rivals = v))} />
      </Block>
    </div>
  )
}

// ── 세계관 설정 ──────────────────────────────────────────────────────────

export function WorldTab({ value, edit, ctx }: { value: WorldLoreSettings; edit: (f: (s: WorldLoreSettings) => void) => void; ctx: LoreContext }) {
  return (
    <div className="lore-tab">
      <Block title={tl.worldType}>
        <Segmented ariaLabel={tl.worldType} value={value.type} options={options(WORLD_TYPES, tl.worldTypes)} onChange={(v) => !ctx.disabled && edit((s) => void (s.type = v))} />
      </Block>
      <Block title={tl.date} help={tl.dateHelp}>
        <input
          type="date"
          className="lore-input date"
          aria-label={tl.date}
          value={value.date && /^\d{4}-\d\d-\d\d$/.test(value.date) ? value.date : ''}
          disabled={ctx.disabled}
          onChange={(e) => edit((s) => void (s.date = e.target.value === '' ? null : e.target.value))}
        />
        {value.date && !/^\d{4}-\d\d-\d\d$/.test(value.date) ? <span className="help">{value.date}</span> : null}
      </Block>
      <Block title={tl.involves} help={tl.involvesHelp}>
        <ChipList
          values={value.involves}
          people={[...ctx.people.players, ...ctx.people.schools]}
          addLabel={tl.addInvolved}
          ariaLabel={tl.involves}
          onChange={(v) => !ctx.disabled && edit((s) => void (s.involves = v))}
        />
      </Block>
    </div>
  )
}

// ── 관계 ─────────────────────────────────────────────────────────────────

export function RelationshipsTab({
  kind,
  value,
  onChange,
  ctx,
}: {
  kind: 'player' | 'gm'
  value: LoreRelationship[]
  onChange: (v: LoreRelationship[]) => void
  ctx: LoreContext
}) {
  const set = (i: number, change: Partial<LoreRelationship>) => onChange(value.map((r, j) => (j === i ? { ...r, ...change } : r)))
  const statusOf = (text: string) => {
    if (kind === 'gm') {
      const gm = ctx.people.gms.find((g) => g.value === text.trim())
      return text.trim() === '' ? null : gm ? { tone: 'ok' as const, text: tl.resolved(`${gm.name} · ${gm.detail}`) } : { tone: 'warn' as const, text: tl.notInLeague }
    }
    return playerStatus(text, ctx)
  }
  return (
    <div className="lore-tab">
      <Block
        title={tl.tabs.relationships}
        help={kind === 'gm' ? tl.gmRelationshipsIntro : tl.relationshipsIntro}
        aside={
          <button
            type="button"
            className="btn small"
            disabled={ctx.disabled}
            onClick={() => onChange([...value, { with: '', type: 'friend', strength: 3, visibility: 'public' }])}
          >
            + {tl.addRelationship}
          </button>
        }
      >
        {value.length === 0 ? <p className="lore-empty">{tl.noRelationships}</p> : null}
        <div className="lore-rows">
          {value.map((r, i) => (
            <div key={i} className="lore-row">
              <div className="lore-row-main">
                <label className="lore-row-field grow">
                  <span className="label">{tl.with}</span>
                  <PersonPicker
                    value={r.with}
                    people={kind === 'gm' ? ctx.people.gms : ctx.people.players}
                    placeholder={tl.withPlaceholder}
                    ariaLabel={tl.with}
                    status={statusOf(r.with)}
                    disabled={ctx.disabled}
                    onChange={(v) => set(i, { with: v })}
                  />
                </label>
                <label className="lore-row-field">
                  <span className="label">{tl.relationType}</span>
                  <Select value={r.type} options={options(RELATIONSHIP_TYPES, tl.relationTypes)} ariaLabel={tl.relationType} disabled={ctx.disabled} onChange={(v) => set(i, { type: v })} />
                </label>
                <div className="lore-row-field">
                  <span className="label">{tl.strength}</span>
                  <Scale small value={r.strength} ariaLabel={tl.strength} disabled={ctx.disabled} onChange={(v) => set(i, { strength: v })} />
                </div>
                <label className="lore-row-field">
                  <span className="label">{tl.visibility}</span>
                  <Select
                    value={r.visibility}
                    options={VISIBILITIES.map((v) => ({ value: v, label: `${tl.visibilities[v]} · ${tl.visibilityHelp[v]}` }))}
                    ariaLabel={tl.visibility}
                    disabled={ctx.disabled}
                    onChange={(v) => set(i, { visibility: v })}
                  />
                </label>
              </div>
              <button type="button" className="btn ghost small icon danger" title={tl.removeRow} aria-label={tl.removeRow} disabled={ctx.disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      </Block>
    </div>
  )
}

/** What a written player reference resolves to, as a line under the picker. */
function playerStatus(text: string, ctx: LoreContext): { tone: 'ok' | 'warn'; text: string } | null {
  const r = resolvePlayer(text, ctx.league, ctx.firstTeams, ctx.people)
  if (r.status === 'ok') return { tone: 'ok', text: tl.resolved(`${r.person.name} · ${r.person.detail}`) }
  if (r.status === 'ambiguous') return { tone: 'warn', text: tl.ambiguous }
  if (r.status === 'missing') return { tone: 'warn', text: tl.notInLeague }
  return null
}

// ── 기분 규칙 ────────────────────────────────────────────────────────────

export function HooksTab({ value, onChange, rivals, ctx }: { value: LoreHook[]; onChange: (v: LoreHook[]) => void; rivals: string[]; ctx: LoreContext }) {
  const set = (i: number, h: LoreHook) => onChange(value.map((x, j) => (j === i ? h : x)))
  const known = (when: string) => (HOOK_TRIGGERS as readonly string[]).includes(when)
  // The rivals named in his relationships come first in the picker.
  const rivalPeople = [...ctx.people.players].sort((a, b) => Number(rivals.includes(b.value)) - Number(rivals.includes(a.value)))
  return (
    <div className="lore-tab">
      <Block
        title={tl.tabs.hooks}
        help={tl.hooksIntro}
        aside={
          <button type="button" className="btn small" disabled={ctx.disabled} onClick={() => onChange([...value, { when: 'traded', mood: { stability: -20 } }])}>
            + {tl.addHook}
          </button>
        }
      >
        {value.length === 0 ? <p className="lore-empty">{tl.noHooks}</p> : null}
        <div className="lore-rows">
          {value.map((h, i) => {
            const parts = Object.entries(h.mood) as [MoodPartKey, number][]
            const unused = MOOD_PARTS.filter((p) => !(p in h.mood))
            const setPart = (from: MoodPartKey, to: MoodPartKey, amount: number) => {
              const mood: LoreHook['mood'] = {}
              for (const [k, v] of parts) if (k !== from) mood[k] = v
              mood[to] = amount
              set(i, { ...h, mood })
            }
            return (
              <div key={i} className="lore-row hook">
                <div className="lore-row-main column">
                  <label className="lore-row-field">
                    <span className="label">{tl.when}</span>
                    <Select
                      value={h.when}
                      options={[
                        ...options(HOOK_TRIGGERS, tl.triggers),
                        ...(known(h.when) ? [] : [{ value: h.when, label: h.when }]),
                      ]}
                      ariaLabel={tl.when}
                      disabled={ctx.disabled}
                      onChange={(v) => set(i, { ...h, when: v, ...(v === 'rival_award' ? {} : { rival: undefined }) })}
                    />
                  </label>
                  {!known(h.when) ? <span className="lore-picker-status warn">{tl.unknownTrigger(h.when)}</span> : null}
                  {h.when === 'rival_award' ? (
                    <label className="lore-row-field">
                      <span className="label">{tl.rival}</span>
                      <PersonPicker
                        value={h.rival ?? ''}
                        people={rivalPeople}
                        placeholder={tl.anyRival}
                        ariaLabel={tl.rival}
                        status={playerStatus(h.rival ?? '', ctx)}
                        disabled={ctx.disabled}
                        onChange={(v) => set(i, { ...h, rival: v.trim() === '' ? undefined : v })}
                      />
                    </label>
                  ) : null}
                  <div className="lore-row-field">
                    <span className="label">{tl.effects}</span>
                    <div className="lore-effects">
                      {parts.map(([part, amount]) => (
                        <div key={part} className="lore-effect">
                          <Select
                            compact
                            value={part}
                            options={[part, ...unused].map((p) => ({ value: p, label: tl.moodParts[p] ?? p }))}
                            ariaLabel={tl.effects}
                            disabled={ctx.disabled}
                            onChange={(to) => setPart(part, to, amount)}
                          />
                          <NumberInput compact value={amount} min={-100} max={100} step={5} ariaLabel={tl.moodParts[part]} disabled={ctx.disabled} onChange={(v) => setPart(part, part, v)} />
                          <span className={`lore-effect-sign ${amount < 0 ? 'down' : amount > 0 ? 'up' : ''}`}>{amount > 0 ? '▲' : amount < 0 ? '▼' : '–'}</span>
                          {parts.length > 1 ? (
                            <button
                              type="button"
                              className="btn ghost small icon"
                              aria-label={tl.removeRow}
                              disabled={ctx.disabled}
                              onClick={() => set(i, { ...h, mood: Object.fromEntries(parts.filter(([k]) => k !== part)) })}
                            >
                              ✕
                            </button>
                          ) : null}
                        </div>
                      ))}
                      {unused.length > 0 ? (
                        <button type="button" className="btn ghost small" disabled={ctx.disabled} onClick={() => setPart(unused[0]!, unused[0]!, -10)}>
                          + {tl.addEffect}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <button type="button" className="btn ghost small icon danger" title={tl.removeRow} aria-label={tl.removeRow} disabled={ctx.disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      </Block>
    </div>
  )
}
