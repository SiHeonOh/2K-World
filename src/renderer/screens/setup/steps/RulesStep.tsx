import { defaultDraft } from '@shared/config/defaults'
import type { CardSwapDraft, Phase } from '@shared/config/schema'
import { Badge, Check, Field, NumberInput, RowControls, Segmented, Select, move } from '../../../components/ui'
import { t } from '../../../i18n'
import { StepIssues } from '../StepIssues'
import type { Edit, StepProps, WizardState } from '../state'

// No playoffs: every player is locked then, whatever the league ticks.
const PHASES: Phase[] = ['preseason', 'regular', 'draft', 'offseason']
/** The draft systems the engine runs ('standard' never ran one: old settings with it read as none). */
const DRAFT_KINDS = ['none', 'card-swap'] as const

export function TradesCard({ state, edit }: { state: WizardState; edit: Edit }) {
  const { trades } = state.setup.config
  const r = t.wizard.rules
  return (
    <div className="card">
      <div className="card-head">
        <h2>{r.trades}</h2>
        <Check checked={trades.enabled} onChange={(v) => edit((s) => void (s.setup.config.trades.enabled = v))}>
          {r.tradesEnabled}
        </Check>
      </div>
      {trades.enabled ? (
        <>
          <Field label={r.phases} help={r.phasesHelp}>
            <div className="row">
              {PHASES.map((p) => (
                <Check
                  key={p}
                  checked={trades.phases.includes(p)}
                  onChange={(on) =>
                    edit((s) => {
                      const list: Phase[] = s.setup.config.trades.phases.filter((x) => x !== 'playoffs')
                      s.setup.config.trades.phases = on ? PHASES.filter((x) => x === p || list.includes(x)) : list.filter((x) => x !== p)
                    })
                  }
                >
                  {r.phaseNames[p]}
                </Check>
              ))}
            </div>
          </Field>
          <div className="row">
            <Check checked={trades.oncePerSeason.enabled} onChange={(v) => edit((s) => void (s.setup.config.trades.oncePerSeason.enabled = v))}>
              {r.oncePerSeason}
            </Check>
            {trades.oncePerSeason.enabled ? (
              <Select
                compact
                ariaLabel={r.until}
                value={trades.oncePerSeason.until}
                options={(['draft', 'season-end'] as const).map((v) => ({ value: v, label: r.untilOptions[v] }))}
                onChange={(v) => edit((s) => void (s.setup.config.trades.oncePerSeason.until = v))}
              />
            ) : null}
          </div>
          <Check checked={trades.equalPlayerCount} onChange={(v) => edit((s) => void (s.setup.config.trades.equalPlayerCount = v))}>
            {r.equalPlayerCount}
          </Check>
          <Check checked={trades.cardsWithPlayers} onChange={(v) => edit((s) => void (s.setup.config.trades.cardsWithPlayers = v))}>
            {r.cardsWithPlayers}
          </Check>
          <Field label={r.limits}>
            <div className="row">
              <span className="help">{r.perWindow}</span>
              <NumberInput
                nullable
                ariaLabel={r.perWindow}
                value={trades.limits.perWindow}
                min={1}
                onChange={(v) => edit((s) => void (s.setup.config.trades.limits.perWindow = v === null ? null : Math.max(1, v)))}
              />
              <span className="help">{r.maxValueGap}</span>
              <NumberInput
                nullable
                ariaLabel={r.maxValueGap}
                value={trades.limits.maxValueGap}
                min={0}
                onChange={(v) => edit((s) => void (s.setup.config.trades.limits.maxValueGap = v === null ? null : Math.max(0, v)))}
              />
            </div>
          </Field>
          <p className="help">{r.frozenNote}</p>
        </>
      ) : null}
    </div>
  )
}

/**
 * The draft: none, or the card swap with its settings. `kindLocked` (리그 설정
 * mid-season): the system itself can't change now, only its settings.
 */
export function DraftCard({ state, edit, kindLocked = false, note }: { state: WizardState; edit: Edit; kindLocked?: boolean; note?: string }) {
  const { draft } = state.setup.config
  const r = t.wizard.rules
  const kind = draft.kind === 'standard' ? 'none' : draft.kind
  return (
    <div className="card">
      <h2>{r.draft}</h2>
      <Field label={r.draftKind} help={kindLocked ? t.leagueSettings.draftKindLocked : undefined}>
        {kindLocked ? (
          <span>
            <Badge>{r.draftKinds[kind]}</Badge>
          </span>
        ) : (
          <Segmented
            value={kind}
            options={DRAFT_KINDS.map((v) => ({ value: v, label: r.draftKinds[v] }))}
            onChange={(v) =>
              edit((s) => {
                if (s.setup.config.draft.kind !== v) s.setup.config.draft = defaultDraft(v, s.setup.teams.length)
              })
            }
          />
        )}
      </Field>
      {note ? <p className="help">{note}</p> : null}
      {draft.kind === 'card-swap' ? <CardSwap draft={draft} edit={edit} /> : null}
    </div>
  )
}

export function RulesStep({ state, edit, issues }: StepProps) {
  return (
    <>
      <TradesCard state={state} edit={edit} />
      <DraftCard state={state} edit={edit} />
      <StepIssues issues={issues} sections={['trades', 'draft']} />
    </>
  )
}

function CardSwap({ draft, edit }: { draft: CardSwapDraft; edit: Edit }) {
  const r = t.wizard.rules
  const set = (change: (d: CardSwapDraft) => void) =>
    edit((s) => {
      if (s.setup.config.draft.kind === 'card-swap') change(s.setup.config.draft)
    })

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Field label={r.allocation} help={r.allocationHelp}>
        <div className="list-editor">
          {draft.allocation.map((tier, i) => (
            <div key={i} className="item">
              <NumberInput compact ariaLabel={r.fromRank} value={tier.fromRank} min={1} onChange={(v) => set((d) => void (d.allocation[i]!.fromRank = Math.max(1, v)))} />
              <span className="muted">{r.fromRank}</span>
              <NumberInput compact ariaLabel={r.toRank} value={tier.toRank} min={1} onChange={(v) => set((d) => void (d.allocation[i]!.toRank = Math.max(1, v)))} />
              <span className="muted">{r.toRank}</span>
              <NumberInput
                compact
                ariaLabel={r.cards}
                value={tier.cards}
                min={0}
                max={20}
                onChange={(v) => set((d) => void (d.allocation[i]!.cards = Math.max(0, v)))}
              />
              <span className="muted">{r.cards}</span>
              <RowControls
                index={i}
                count={draft.allocation.length}
                onMove={(from, to) => set((d) => move(d.allocation, from, to))}
                onRemove={draft.allocation.length > 1 ? () => set((d) => void d.allocation.splice(i, 1)) : undefined}
              />
            </div>
          ))}
        </div>
        <div>
          <button
            className="btn small"
            onClick={() =>
              set((d) => {
                const last = d.allocation[d.allocation.length - 1]
                const from = last ? last.toRank + 1 : 1
                d.allocation.push({ fromRank: from, toRank: from, cards: last?.cards ?? 3 })
              })
            }
          >
            {r.addTier}
          </button>
        </div>
      </Field>

      <Check checked={draft.protection} onChange={(v) => set((d) => void (d.protection = v))}>
        {r.protection}
      </Check>
      <div className="grid-2">
        <Field label={r.turns}>
          {(id) => (
            <Select
              id={id}
              value={draft.turns}
              options={(['one', 'all'] as const).map((v) => ({ value: v, label: r.turnOptions[v] }))}
              onChange={(v) => set((d) => void (d.turns = v))}
            />
          )}
        </Field>
        <Field label={r.slotRule}>
          {(id) => (
            <Select
              id={id}
              value={draft.slotRule}
              options={(['any', 'same-slot'] as const).map((v) => ({ value: v, label: r.slotRules[v] }))}
              onChange={(v) => set((d) => void (d.slotRule = v))}
            />
          )}
        </Field>
        <Field label={r.incomingSlot}>
          {(id) => (
            <Select
              id={id}
              value={draft.incomingSlot}
              options={(['replaced', 'own'] as const).map((v) => ({ value: v, label: r.incomingSlots[v] }))}
              onChange={(v) => set((d) => void (d.incomingSlot = v))}
            />
          )}
        </Field>
        <Field label={r.unusedCards}>
          {(id) => (
            <Select
              id={id}
              value={draft.unusedCards}
              options={(['expire', 'carry-over'] as const).map((v) => ({ value: v, label: r.unusedOptions[v] }))}
              onChange={(v) => set((d) => void (d.unusedCards = v))}
            />
          )}
        </Field>
      </div>
      {/* A league rule now, not a setting: a player moves at most once per draft, both ways. */}
      <p className="help">{r.movedProtected}</p>

      <Field label={r.cardTrades}>
        <div className="stack">
          <Check checked={draft.cardTrades.enabled} onChange={(v) => set((d) => void (d.cardTrades.enabled = v))}>
            {r.cardTradesEnabled}
          </Check>
          {draft.cardTrades.enabled ? (
            <>
              <Check checked={draft.cardTrades.unbalanced} onChange={(v) => set((d) => void (d.cardTrades.unbalanced = v))}>
                {r.unbalanced}
              </Check>
              <div className="row">
                <span className="help">{r.inSeasonCap}</span>
                <NumberInput
                  nullable
                  ariaLabel={r.inSeasonCap}
                  value={draft.cardTrades.inSeasonCap}
                  min={0}
                  max={50}
                  onChange={(v) => set((d) => void (d.cardTrades.inSeasonCap = v === null ? null : Math.max(0, v)))}
                />
                {draft.cardTrades.inSeasonCap !== null ? (
                  <Select
                    compact
                    ariaLabel={r.capCounts}
                    value={draft.cardTrades.capCounts}
                    options={(['given', 'received', 'trades'] as const).map((v) => ({ value: v, label: r.capCountOptions[v] }))}
                    onChange={(v) => set((d) => void (d.cardTrades.capCounts = v))}
                  />
                ) : null}
              </div>
            </>
          ) : null}
          <span className="help">{r.pickSlot}</span>
        </div>
      </Field>
    </div>
  )
}
