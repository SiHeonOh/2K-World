import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiErrorKind, RunUsage, TokenCounts } from '@shared/ai'
import { killTree, start, type Launch } from './launch'

/**
 * The AI engine's only link to Claude Code. Everything else asks for a job
 * through this interface and gets back validated data or a classified error.
 */

export interface JobRequest {
  /** Replaces Claude Code's own system prompt (written to a file in `workdir`). */
  systemPrompt: string
  /** The instruction, passed as the -p argument. */
  prompt: string
  /** League data for the job, piped in (stdin takes up to 10 MB). */
  stdin: string
  /** JSON Schema the answer must match (passed to --json-schema). */
  schema: object
  model: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Built-in tools Claude may use, e.g. ['Read'] for screenshots; [] for none. */
  tools: string[]
  /** The job's own folder: the working directory, and the only place Read can see. */
  workdir: string
  timeoutMs?: number
  /** Aborting ends the run (and the CLI's whole process tree). */
  signal?: AbortSignal
  /** The job kind and its stored input; the CLI ignores them (demo and test adapters use them). */
  kind?: string
  input?: unknown
}

/** See AiErrorKind for what each means and how the queue handles it. */
export type JobErrorKind = AiErrorKind

/** How long a run may take when its job kind doesn't say (the queue lengthens it for higher effort). */
export const DEFAULT_TIMEOUT_MS = 300_000

/** `usage`: which exact models answered and their tokens. A failed run reports them (and its cost) too when Claude Code did. */
export type JobResult =
  | { ok: true; data: unknown; costUsd: number | null; durationMs: number | null; raw: string; usage?: RunUsage | null }
  | { ok: false; error: JobErrorKind; message: string; retryAt?: string; raw?: string; costUsd?: number | null; usage?: RunUsage | null }

export interface AiAdapter {
  run(request: JobRequest): Promise<JobResult>
}

/** The flags every call passes; see ARCHITECTURE section 6. */
export function claudeArgs(req: JobRequest, systemPromptFile: string): string[] {
  const args = [
    '-p',
    req.prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.schema),
    '--system-prompt-file',
    systemPromptFile,
    '--model',
    req.model,
    // Skip the user's own Claude Code setup (hooks, plugins, CLAUDE.md) but keep the sign-in.
    '--safe-mode',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--tools',
    req.tools.join(','),
  ]
  if (req.effort) args.push('--effort', req.effort)
  return args
}

/** What `claude -p --output-format json` prints (the fields we use). */
interface ClaudeJson {
  is_error?: boolean
  subtype?: string
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  duration_ms?: number
  /** Per exact model id: inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD… */
  modelUsage?: unknown
  /** Totals for the main loop: input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens. */
  usage?: unknown
}

const objectOf = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
/** A token count: a finite non-negative number, or a string of digits (as some JSON writers send big numbers). */
const countOf = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? Math.round(v) : null
  return typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null
}
/**
 * Token counts from one usage object; null when it has none at all, or only
 * zeros (a crashed run reports zeroed usage: unknown, not "nothing spent").
 * A field that's missing or odd counts as 0.
 */
function tokensOf(o: Record<string, unknown>, keys: [input: string, output: string, cacheRead: string, cacheWrite: string]): TokenCounts | null {
  const [input, output, cacheRead, cacheWrite] = keys.map((k) => countOf(o[k]) ?? 0) as [number, number, number, number]
  if (input + output + cacheRead + cacheWrite === 0) return null
  return { input, output, cacheRead, cacheWrite }
}
/** Model ids as Claude Code names them (claude-sonnet-…, a Bedrock id, `…[1m]`); never an object key like __proto__. */
const MODEL_ID = /^[A-Za-z0-9][\w.:@/[\]-]{0,199}$/

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** The model that wrote the answer: the most output tokens, then the most input. */
export function mainModel(models: Record<string, TokenCounts>): string | null {
  let best: [string, TokenCounts] | null = null
  for (const entry of Object.entries(models)) {
    const [, t] = entry
    if (!best || t.output > best[1].output || (t.output === best[1].output && t.input > best[1].input)) best = entry
  }
  return best ? best[0] : null
}

/**
 * Which exact models answered and the tokens each used, from the result's
 * `modelUsage`; the top-level `usage` gives totals when that's missing.
 * Missing or odd fields mean unknown (null), never a failed job.
 */
export function readUsage(result: unknown): RunUsage | null {
  const r = objectOf(result)
  if (!r) return null
  const models: Record<string, TokenCounts> = {}
  for (const [id, entry] of Object.entries(objectOf(r.modelUsage) ?? {}).slice(0, 20)) {
    const o = objectOf(entry)
    const tokens = o && MODEL_ID.test(id) ? tokensOf(o, ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) : null
    if (tokens) models[id] = tokens
  }
  const counted = Object.values(models)
  if (counted.length > 0) return { model: mainModel(models), models, total: counted.reduce(addTokens) }
  const usage = objectOf(r.usage)
  const total = usage ? tokensOf(usage, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) : null
  return total ? { model: null, models: {}, total } : null
}

/** What a run spent, as far as the result says. */
const spentOf = (parsed: ClaudeJson): { costUsd: number | null; usage: RunUsage | null } => {
  const usage = readUsage(parsed)
  const cost = typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd) && parsed.total_cost_usd >= 0 ? parsed.total_cost_usd : null
  // A crashed run reports zeroes: with no usage known, a cost of 0 is unknown too, not "nothing spent".
  return { costUsd: cost === 0 && usage === null ? null : cost, usage }
}

// Whole phrases only: a stack trace's "cli.js:1429" or a word like "assigning" must not pause or block the queue.
/** More than one run can take: this job's own problem, however it's worded. */
const TOO_LONG =
  /\b(prompt is too long|input is too long|context (window|length) (exceeded|is too)|context limit reached|maximum context length|too many (input )?tokens|request[ _]too[ _]large|payload too large)\b|\b(status|http|error)\W{0,3}413\b/i
const LIMIT =
  /\b(usage limit|rate[ _-]?limit(ed|_error)?|limit reached|limit will reset|too many requests|hit your( [\w-]+){0,2} limit)\b|\bresets? (at|in)\b|\bresets ([a-z]{3,9}\.? \d{1,2},? )?\d{1,2}(:\d{2})? ?[ap]m\b|\b(status|http|error)\W{0,3}429\b/i
const AUTH =
  /\b(not logged in|please (run )?\/login|log ?in again|sign ?in again|not signed in|authentication[ _](failed|error|required)|invalid (api key|credentials?)|unauthori[sz]ed|oauth token (has )?(expired|been revoked))\b|\b(status|http|error)\W{0,3}401\b/i
/** The model (or effort) a job asked for can't be used: an unknown alias, no access, an effort this version doesn't take. */
const MODEL =
  /\b(issue with the selected model|invalid model|unknown model)\b|\bnot available (with|on|for) (your|the|this)\b[^\n.]{0,30}\b(plan|subscription|account)\b|\bnot_found_error\b[^\n]{0,80}\bmodel\b|\bmodel\b[^\n]{0,80}\b(not_found_error|not found|not available|does not exist|deprecated|no longer (supported|available))\b|\boption\W{1,3}--(model|effort)\b[^\n]{0,80}\bis invalid\b/i
const OFFLINE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|fetch failed|network error|connection error|connection (refused|reset|closed|timed out)|unable to connect|failed to connect|could not connect|cannot connect|internet connection|getaddrinfo|request timed out|no internet)\b/i
const OVERLOADED = /\b(overloaded(_error)?|internal server error|service unavailable|bad gateway|gateway time-?out|api_error|temporarily unavailable)\b|\b(status|http|error)\W{0,3}5\d\d\b/i
/** An outdated or broken Claude Code: flags it doesn't know, a missing file of its own, a request to update. */
const CLI =
  /\b(unknown option|unrecognized option|unknown argument|invalid option|unknown command|cannot find module|MODULE_NOT_FOUND|is not recognized as an internal or external command|please update|run claude update|update claude code|newer version of claude code|requires? (a )?newer version|no longer supported)\b/i

/**
 * Sorts a failure into something the queue can act on, from Claude Code's
 * message (and the result's subtype). See AiErrorKind for what the queue
 * does with each. Order matters: a too-long prompt can mention a limit.
 */
export function classifyFailure(text: string, now = Date.now()): { error: JobErrorKind; retryAt?: string } {
  if (TOO_LONG.test(text)) return { error: 'job' }
  if (LIMIT.test(text)) return { error: 'limit', ...resetTime(text, now) }
  if (AUTH.test(text)) return { error: 'auth' }
  if (MODEL.test(text)) return { error: 'model' }
  if (OFFLINE.test(text)) return { error: 'offline' }
  if (OVERLOADED.test(text)) return { error: 'overloaded' }
  if (CLI.test(text)) return { error: 'cli' }
  // Claude Code gave up on the format (--json-schema), or ran out of turns: the job's own answer.
  if (/\berror_max_structured_output_retries\b/.test(text)) return { error: 'invalid' }
  if (/\berror_max_turns\b/.test(text)) return { error: 'job' }
  return { error: 'failed' }
}

/** A failure starting the claude command: not there at all, or there but unusable (blocked, broken). */
function startFailure(e: NodeJS.ErrnoException): JobErrorKind {
  if (e.code === 'ENOENT') return 'missing'
  return e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOEXEC' ? 'cli' : 'failed'
}

/**
 * Finds when a limit resets in its message, if it says: an ISO timestamp,
 * epoch seconds, "resets in 3 hours", or a clock time as Claude Code writes
 * it ("resets 5pm (Asia/Seoul)", "resets 3pm", "resets Oct 14, 9am"). A
 * clock time without a zone is this PC's; without a date it's the next one
 * to come (today's, or tomorrow's once it has passed).
 */
function resetTime(text: string, now = Date.now()): { retryAt?: string } {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/)
  if (iso) {
    const d = new Date(iso[0])
    if (!Number.isNaN(d.getTime())) return { retryAt: d.toISOString() }
  }
  const epoch = text.match(/\b(1[7-9]\d{8})\b/)
  if (epoch) return { retryAt: new Date(Number(epoch[1]) * 1000).toISOString() }
  const after = text.match(/\bresets? in (\d{1,3}) ?(minutes?|mins?|hours?|hrs?|h|m)\b/i)
  if (after) return { retryAt: new Date(now + Number(after[1]) * (/^h/i.test(after[2]!) ? 3_600_000 : 60_000)).toISOString() }
  const at = text.match(/\bresets?(?: at| on)? (?:([a-z]{3})[a-z]*\.? (\d{1,2}),?(?: at)? )?(\d{1,2})(?::(\d{2}))? ?([ap]m)?(?: ?\(([\w/+-]+)\))?/i)
  if (!at || (!at[4] && !at[5])) return {}
  let hour = Number(at[3])
  const minute = Number(at[4] ?? 0)
  const half = at[5]?.toLowerCase()
  if (half ? hour < 1 || hour > 12 : hour > 23) return {}
  if (minute > 59) return {}
  if (half) hour = (hour % 12) + (half === 'pm' ? 12 : 0)
  const month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : null
  if (month === -1) return {}
  const zone = at[6] && validZone(at[6]) ? at[6] : null
  const today = wallClock(now, zone)
  if (month !== null) {
    // A date with no year: this year's, unless that was long ago (a reset in January read in December).
    const day = Number(at[2])
    let t = fromWallClock({ year: today.year, month, day, hour, minute }, zone)
    if (t < now - 180 * 86_400_000) t = fromWallClock({ year: today.year + 1, month, day, hour, minute }, zone)
    return { retryAt: new Date(t).toISOString() }
  }
  let t = fromWallClock({ ...today, hour, minute }, zone)
  if (t <= now) t = fromWallClock({ ...today, day: today.day + 1, hour, minute }, zone)
  return { retryAt: new Date(t).toISOString() }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

interface WallClock {
  year: number
  /** 0-based, as Date has it. */
  month: number
  day: number
  hour: number
  minute: number
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The date and time a clock shows at `t`: in `zone`, or this PC's. */
function wallClock(t: number, zone: string | null): WallClock {
  if (zone === null) {
    const d = new Date(t)
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() }
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(t)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: part('year'), month: part('month') - 1, day: part('day'), hour: part('hour') % 24, minute: part('minute') }
}

/** The moment a clock in `zone` (or this PC's) shows this date and time; overflowing days roll on. */
function fromWallClock(w: WallClock, zone: string | null): number {
  if (zone === null) return new Date(w.year, w.month, w.day, w.hour, w.minute).getTime()
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute)
  // The zone's offset at that moment, found from a first guess and checked once more (daylight saving).
  let t = asUtc
  for (let i = 0; i < 2; i++) {
    const seen = wallClock(t, zone)
    t = asUtc - (Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute) - t)
  }
  return t
}

/** Reads `claude -p` JSON output into a JobResult. */
export function parseClaudeOutput(stdout: string, stderr: string, exitCode: number | null): JobResult {
  const text = stdout.trim()
  let parsed: ClaudeJson | null = null
  // The JSON result is the last line that parses; anything before it is noise.
  for (const line of text.split(/\r?\n/).reverse()) {
    try {
      const v = JSON.parse(line) as unknown
      if (v && typeof v === 'object') {
        parsed = v as ClaudeJson
        break
      }
    } catch {
      // not JSON
    }
  }
  if (!parsed) {
    try {
      parsed = JSON.parse(text) as ClaudeJson
    } catch {
      parsed = null
    }
  }
  if (!parsed) {
    const message = (stderr || text || `exit ${exitCode}`).slice(0, 2000)
    return { ok: false, ...classifyFailure(message), message, raw: stdout }
  }
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    const message = String(parsed.result ?? parsed.subtype ?? 'error').slice(0, 2000)
    return { ok: false, ...classifyFailure(`${message}\n${parsed.subtype ?? ''}\n${stderr}`), message, raw: stdout, ...spentOf(parsed) }
  }
  if (parsed.structured_output === undefined) {
    return { ok: false, error: 'invalid', message: 'no structured_output in result', raw: stdout, ...spentOf(parsed) }
  }
  return {
    ok: true,
    data: parsed.structured_output,
    ...spentOf(parsed),
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
    raw: stdout,
  }
}

/**
 * Runs the official `claude` command, signed in to the user's own plan.
 * The launch is an executable started without a shell (see launch.ts).
 */
export class ClaudeCliAdapter implements AiAdapter {
  private readonly live = new Set<ChildProcess>()

  constructor(private readonly launch: Launch) {}

  /** Ends every run in progress (on quit, or when the data folder changes). */
  abortAll(): void {
    for (const child of this.live) killTree(child)
  }

  run(req: JobRequest): Promise<JobResult> {
    if (req.signal?.aborted) return Promise.resolve({ ok: false, error: 'failed', message: 'aborted' })
    const systemPromptFile = join(req.workdir, 'system-prompt.md')
    try {
      writeFileSync(systemPromptFile, req.systemPrompt, 'utf8')
    } catch (e) {
      // The job's own folder gone (screenshots deleted) is this job's problem; a full or locked disk isn't.
      const error: JobErrorKind = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'job' : 'failed'
      return Promise.resolve({ ok: false, error, message: `could not prepare the job folder: ${e instanceof Error ? e.message : String(e)}` })
    }
    const args = claudeArgs(req, systemPromptFile)
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let child: ChildProcess | null = null
      const done = (r: JobResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
        if (child) this.live.delete(child)
        resolve(r)
      }
      // Ends the process tree, then reports once it has really exited (or after 5 s), so a retry never overlaps it.
      let ending: JobResult | null = null
      const end = (r: JobResult) => {
        if (settled || ending) return
        ending = r
        if (!child || child.exitCode !== null || child.signalCode !== null) return done(r)
        killTree(child)
        setTimeout(() => done(r), 5000).unref()
      }
      const onAbort = () => end({ ok: false, error: 'failed', message: 'aborted' })
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => end({ ok: false, error: 'timeout', message: `timed out after ${timeoutMs} ms` }), timeoutMs)
      try {
        child = start(this.launch, args, { cwd: req.workdir, env: process.env })
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        done({ ok: false, error: startFailure(err), message: err.message })
        return
      }
      this.live.add(child)
      req.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d))
      child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d))
      child.on('error', (e: NodeJS.ErrnoException) => done({ ok: false, error: startFailure(e), message: e.message }))
      child.on('close', (code) => done(ending ?? parseClaudeOutput(stdout, stderr, code)))
      child.stdin?.on('error', () => {
        // The CLI may exit before reading stdin; the close handler reports why.
      })
      child.stdin?.end(req.stdin, 'utf8')
    })
  }
}

/** Plays back recorded answers, keyed by job kind or prompt, for tests and demos. */
export class ReplayAdapter implements AiAdapter {
  readonly calls: JobRequest[] = []

  constructor(private readonly answer: (req: JobRequest) => JobResult | Promise<JobResult>) {}

  async run(req: JobRequest): Promise<JobResult> {
    this.calls.push(req)
    return this.answer(req)
  }
}
