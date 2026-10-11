import { ApiError } from '../../api'
import { ErrorBox, IssueList, Notice } from '../../components/ui'
import { t } from '../../i18n'

type Params = Record<string, string | number>

/** Translates a League engine refusal (code + params) into a sentence. */
export function ruleText(code: string, params: Params): string {
  const fn = (t.rules as Record<string, ((p: Params) => string) | undefined>)[code]
  return fn ? fn(params) : code
}

/** A params formatter that shows team names for a `teams` param (ids joined by ', '). */
export const withTeamNames =
  (teamName: (id: string) => string) =>
  (params: Params): Params =>
    typeof params.teams === 'string' ? { ...params, teams: params.teams.split(/,\s*/).map(teamName).join(', ') } : params

/** Shows why the engine refused a move, or any other error. `format` rewrites params (ids → names) before translating. */
export function RuleErrors({ error, format, onRetry }: { error: unknown; format?: (params: Params) => Params; onRetry?: () => void }) {
  if (error instanceof ApiError && error.code === 'rule' && error.shape.rules) {
    return (
      <Notice tone="err">
        <IssueList
          items={error.shape.rules.map((r) => ({ level: 'error' as const, text: ruleText(r.code, format ? format(r.params) : r.params) }))}
        />
      </Notice>
    )
  }
  return <ErrorBox error={error} onRetry={onRetry} />
}
