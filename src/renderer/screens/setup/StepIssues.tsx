import type { SetupIssue, SetupSection } from '@shared/setup'
import { IssueList } from '../../components/ui'
import { t } from '../../i18n'

export function issueText(issue: SetupIssue): string {
  const text = t.wizard.issues[issue.code](issue.params)
  return issue.code === 'schema' ? `${text} (${issue.path.join('.')})` : text
}

/** Errors and warnings for the given sections, shown under a step. */
export function StepIssues({ issues, sections, limit = 12 }: { issues: SetupIssue[]; sections: SetupSection[]; limit?: number }) {
  const mine = issues.filter((i) => sections.includes(i.section))
  if (mine.length === 0) return null
  const sorted = [...mine.filter((i) => i.level === 'error'), ...mine.filter((i) => i.level === 'warning')]
  const shown = sorted.slice(0, limit)
  return (
    <div className="card">
      <IssueList items={shown.map((i) => ({ level: i.level, text: issueText(i) }))} />
      {sorted.length > limit ? <span className="muted">… +{sorted.length - limit}</span> : null}
    </div>
  )
}
