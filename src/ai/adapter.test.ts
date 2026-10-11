import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCliAdapter, classifyFailure, parseClaudeOutput, type JobRequest } from './adapter'
import { resolveLaunch } from './launch'

const fake = resolve(__dirname, 'testing', 'fake-claude.mjs')
const dirs: string[] = []
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE
  // A killed CLI can hold its folder for a moment on Windows.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function request(): JobRequest {
  const workdir = mkdtempSync(join(tmpdir(), '2kw-ai-'))
  dirs.push(workdir)
  return {
    systemPrompt: '너는 박스스코어를 읽는다.',
    prompt: 'Read the two screenshots in this folder.',
    stdin: '{"teams":["가람고","누리고"]}',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    model: 'sonnet',
    tools: ['Read'],
    workdir,
    timeoutMs: 20_000,
  }
}

describe('ClaudeCliAdapter', () => {
  const adapter = new ClaudeCliAdapter({ file: process.execPath, args: [fake] })

  it('passes the agreed flags, the system prompt file and stdin', async () => {
    const req = request()
    const r = await adapter.run(req)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const echo = r.data as { args: string[]; stdin: string; cwd: string }
    expect(echo.stdin).toBe(req.stdin)
    expect(echo.args).toEqual(
      expect.arrayContaining(['-p', req.prompt, '--output-format', 'json', '--safe-mode', '--no-session-persistence', '--model', 'sonnet']),
    )
    const at = (flag: string) => echo.args[echo.args.indexOf(flag) + 1]
    expect(at('--permission-mode')).toBe('dontAsk')
    expect(at('--tools')).toBe('Read')
    expect(JSON.parse(at('--json-schema')!)).toEqual(req.schema)
    expect(readFileSync(at('--system-prompt-file')!, 'utf8')).toBe(req.systemPrompt)
    expect(resolve(echo.cwd)).toBe(resolve(req.workdir))
    expect(r.costUsd).toBe(0.01)
    expect(r.usage).toEqual({
      model: 'claude-sonnet-test',
      models: { 'claude-sonnet-test': { input: 12, output: 80, cacheRead: 3000, cacheWrite: 400 } },
      total: { input: 12, output: 80, cacheRead: 3000, cacheWrite: 400 },
    })
  })

  it('classifies usage limits with the reset time, sign-in problems and garbage', async () => {
    process.env.FAKE_CLAUDE_MODE = 'limit'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'limit', retryAt: '2026-10-10T15:00:00.000Z' })
    process.env.FAKE_CLAUDE_MODE = 'auth'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'auth' })
    process.env.FAKE_CLAUDE_MODE = 'no-structured'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'invalid' })
    process.env.FAKE_CLAUDE_MODE = 'garbage'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'failed' })
  })

  it('classifies no internet, a busy Claude and an outdated Claude Code', async () => {
    process.env.FAKE_CLAUDE_MODE = 'offline'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'offline', message: 'API Error: Connection error.' })
    process.env.FAKE_CLAUDE_MODE = 'overloaded'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'overloaded' })
    process.env.FAKE_CLAUDE_MODE = 'old-cli'
    expect(await adapter.run(request())).toMatchObject({ ok: false, error: 'cli', message: expect.stringContaining("unknown option '--safe-mode'") })
  })

  it('reports a missing claude command', async () => {
    const missing = new ClaudeCliAdapter({ file: join(tmpdir(), 'no-such-claude.exe'), args: [] })
    expect(await missing.run(request())).toMatchObject({ ok: false, error: 'missing' })
  })

  it('passes shell characters through untouched, with no shell in between', async () => {
    const req = { ...request(), prompt: '" & echo PWNED>pwned.txt & " %PATH% ^ | <x>' }
    const r = await adapter.run(req)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.data as { args: string[] }).args).toContain(req.prompt)
    expect(existsSync(join(req.workdir, 'pwned.txt'))).toBe(false)
  })

  it('ends the run on abort and on timeout', async () => {
    process.env.FAKE_CLAUDE_MODE = 'hang'
    const controller = new AbortController()
    const run = adapter.run({ ...request(), signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    expect(await run).toMatchObject({ ok: false, message: 'aborted' })
    expect(await adapter.run({ ...request(), timeoutMs: 300 })).toMatchObject({ ok: false, error: 'timeout', message: expect.stringContaining('timed out') })
  })
})

describe('resolveLaunch', () => {
  const shim = (body: string, files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), '2kw-shim-'))
    dirs.push(dir)
    for (const f of files) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), '')
    }
    writeFileSync(join(dir, 'claude.cmd'), body)
    return dir
  }

  it('runs an exe as is and never a .cmd', () => {
    expect(resolveLaunch('C:\\x\\claude.exe')).toEqual({ file: 'C:\\x\\claude.exe', args: [] })
    expect(resolveLaunch(join(tmpdir(), 'missing.cmd'))).toBeNull()
  })

  it('reads an npm shim for the script it runs, with node', () => {
    const body = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n'
    const dir = shim(body, ['node_modules/@anthropic-ai/claude-code/cli.js'])
    expect(resolveLaunch(join(dir, 'claude.cmd'), () => 'C:\\node\\node.exe')).toEqual({
      file: 'C:\\node\\node.exe',
      args: [resolve(dir, 'node_modules/@anthropic-ai/claude-code/cli.js')],
    })
    expect(resolveLaunch(join(dir, 'claude.cmd'), () => null)).toBeNull()
  })

  it('prefers a native exe the shim points at', () => {
    const dir = shim('"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*', ['node_modules/@anthropic-ai/claude-code/bin/claude.exe'])
    expect(resolveLaunch(join(dir, 'claude.cmd'))?.file).toBe(resolve(dir, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'))
  })
})

describe('parsing', () => {
  it('takes the last JSON line', () => {
    const out = 'warning: something\n{"is_error":false,"subtype":"success","structured_output":{"a":1}}\n'
    expect(parseClaudeOutput(out, '', 0)).toMatchObject({ ok: true, data: { a: 1 } })
  })

  // The result's fields as Claude Code documents them (headless and Agent SDK cost tracking): modelUsage per model id, usage for the main loop.
  const result = (extra: object) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { a: 1 }, total_cost_usd: 0.0123, ...extra })

  it('reads which exact models answered and their tokens; the most output tokens is the main one', () => {
    const r = parseClaudeOutput(
      result({
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
        modelUsage: {
          'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.001 },
          'claude-sonnet-4-6': { inputTokens: 12, outputTokens: 800, cacheReadInputTokens: 11000, cacheCreationInputTokens: 988, webSearchRequests: 0, costUSD: 0.0113, contextWindow: 200000 },
        },
      }),
      '',
      0,
    )
    expect(r).toMatchObject({ ok: true, costUsd: 0.0123 })
    expect(r.usage).toEqual({
      model: 'claude-sonnet-4-6',
      models: {
        'claude-haiku-4-5-20251001': { input: 900, output: 40, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-6': { input: 12, output: 800, cacheRead: 11000, cacheWrite: 988 },
      },
      // modelUsage wins over the main-loop totals.
      total: { input: 912, output: 840, cacheRead: 11000, cacheWrite: 988 },
    })
  })

  it('reads what it can from a partial modelUsage, and never fails the job over it', () => {
    const r = parseClaudeOutput(
      result({
        modelUsage: {
          'claude-opus-4-1': { outputTokens: 50, inputTokens: '12', cacheReadInputTokens: -3, cacheCreationInputTokens: Number.MAX_VALUE * 10 },
          'claude-sonnet-4-6[1m]': { inputTokens: 7.6, outputTokens: 60 },
          'claude-no-counts': { costUSD: 0.5 },
          'not an id': { inputTokens: 1, outputTokens: 999 },
          'not-an-object': 42,
          // An own "__proto__" key, as JSON.parse makes it.
          ...(JSON.parse('{"__proto__": {"inputTokens": 1, "outputTokens": 999}}') as object),
        },
      }),
      '',
      0,
    )
    expect(r.ok).toBe(true)
    expect(r.usage).toEqual({
      model: 'claude-sonnet-4-6[1m]',
      models: {
        // A count written as a string of digits still counts.
        'claude-opus-4-1': { input: 12, output: 50, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-6[1m]': { input: 8, output: 60, cacheRead: 0, cacheWrite: 0 },
      },
      total: { input: 20, output: 110, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('reads zeroed usage (a crashed run) as unknown, never a random "main" model', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    const crashed = parseClaudeOutput(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, modelUsage: { 'claude-haiku-4-5': zero, 'claude-opus-4-1': zero }, usage: { input_tokens: 0, output_tokens: 0 } }),
      '',
      1,
    )
    expect(crashed).toMatchObject({ ok: false, usage: null, costUsd: null })
  })

  it('falls back to the totals without modelUsage, and to unknown without either', () => {
    const totals = { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
    expect(parseClaudeOutput(result({ usage: totals }), '', 0).usage).toEqual({ model: null, models: {}, total: { input: 30, output: 5, cacheRead: 100, cacheWrite: 0 } })
    expect(parseClaudeOutput(result({ usage: totals, modelUsage: ['claude-sonnet-4-6'] }), '', 0).usage).toMatchObject({ model: null, total: { input: 30 } })
    for (const odd of [{}, { modelUsage: null, usage: 'lots' }, { modelUsage: { 'claude-sonnet-4-6': null }, usage: {} }]) {
      expect(parseClaudeOutput(result(odd), '', 0)).toMatchObject({ ok: true, data: { a: 1 }, usage: null })
    }
    expect(parseClaudeOutput(result({ total_cost_usd: 'free' }), '', 0)).toMatchObject({ ok: true, costUsd: null, usage: null })
  })

  it('keeps what a failed run spent when the result says', () => {
    const modelUsage = { 'claude-haiku-4-5-20251001': { inputTokens: 40, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
    const failed = parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'stopped', total_cost_usd: 0.002, modelUsage }), '', 1)
    // Out of turns: the job's own problem (the subtype counts, not only the result text).
    expect(failed).toMatchObject({ ok: false, error: 'job', costUsd: 0.002, usage: { model: 'claude-haiku-4-5-20251001', total: { input: 40, output: 2 } } })
    const noOutput = parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'plain', modelUsage }), '', 0)
    expect(noOutput).toMatchObject({ ok: false, error: 'invalid', costUsd: null, usage: { model: 'claude-haiku-4-5-20251001' } })
    expect(parseClaudeOutput('not json', '', 2)).not.toHaveProperty('usage')
  })

  it('classifies failure text', () => {
    expect(classifyFailure('Rate limit exceeded, try again later').error).toBe('limit')
    expect(classifyFailure('Claude usage limit reached').error).toBe('limit')
    expect(classifyFailure('API Error: 429 {"type":"rate_limit_error"}').error).toBe('limit')
    expect(classifyFailure('Invalid API key · Please run /login').error).toBe('auth')
    expect(classifyFailure('Not logged in · Please run /login').error).toBe('auth')
    expect(classifyFailure('something else broke').error).toBe('failed')
    // Stack traces and ordinary words don't count.
    expect(classifyFailure('TypeError: x is undefined\n    at cli.js:1429:12\n    at cli.js:401:3').error).toBe('failed')
    expect(classifyFailure('error while assigning the login form handler').error).toBe('failed')
  })

  it('reads every way Claude Code words the usage limit, and when it resets', () => {
    // 2026-10-10 09:00 in Seoul (00:00 UTC).
    const now = Date.parse('2026-10-10T00:00:00Z')
    expect(classifyFailure("You've hit your limit · resets 5pm (Asia/Seoul)", now)).toEqual({ error: 'limit', retryAt: '2026-10-10T08:00:00.000Z' })
    expect(classifyFailure("You've hit your session limit · resets 5:30pm (Asia/Seoul)", now)).toEqual({ error: 'limit', retryAt: '2026-10-10T08:30:00.000Z' })
    // The time has passed today there: it's tomorrow's.
    expect(classifyFailure("You've hit your limit · resets 8am (Asia/Seoul)", now)).toEqual({ error: 'limit', retryAt: '2026-10-10T23:00:00.000Z' })
    expect(classifyFailure('5-hour limit reached ∙ resets 3pm (UTC)', now)).toEqual({ error: 'limit', retryAt: '2026-10-10T15:00:00.000Z' })
    expect(classifyFailure('Opus weekly limit reached ∙ resets Oct 14, 9am (America/New_York)', now)).toEqual({ error: 'limit', retryAt: '2026-10-14T13:00:00.000Z' })
    expect(classifyFailure('Claude usage limit reached. Your limit will reset in 2 hours.', now)).toEqual({ error: 'limit', retryAt: '2026-10-10T02:00:00.000Z' })
    // No zone: this PC's clock.
    const local = new Date(2026, 9, 10, 12, 0).getTime()
    expect(classifyFailure('5-hour limit reached ∙ resets 3pm', local)).toEqual({ error: 'limit', retryAt: new Date(2026, 9, 10, 15, 0).toISOString() })
    expect(classifyFailure('Session limit reached ∙ resets 9am', local)).toEqual({ error: 'limit', retryAt: new Date(2026, 9, 11, 9, 0).toISOString() })
    expect(classifyFailure('Opus weekly limit reached ∙ resets Oct 14, 9am', local)).toEqual({ error: 'limit', retryAt: new Date(2026, 9, 14, 9, 0).toISOString() })
    // A date early next year read late this year.
    expect(classifyFailure('Weekly limit reached ∙ resets Jan 2, 9am', new Date(2026, 11, 30, 12, 0).getTime()).retryAt).toBe(new Date(2027, 0, 2, 9, 0).toISOString())
    // An unknown zone reads as this PC's; a time that can't be one gives no reset (the queue waits its default).
    expect(classifyFailure('limit reached ∙ resets 3pm (Mars/Olympus)', local).retryAt).toBe(new Date(2026, 9, 10, 15, 0).toISOString())
    expect(classifyFailure('Session limit reached ∙ resets 13pm', local)).toEqual({ error: 'limit' })
    expect(classifyFailure('Usage limit reached', local)).toEqual({ error: 'limit' })
  })

  it('tells problems that pass from ones that need you, and from this job’s own', () => {
    const kind = (text: string) => classifyFailure(text).error
    // No internet: the queue waits and tries the same job again.
    for (const offline of [
      'API Error: Connection error.',
      'Unable to connect to Anthropic services. Failed to connect to api.anthropic.com: ENOTFOUND',
      'getaddrinfo EAI_AGAIN api.anthropic.com',
      'Error: socket hang up',
      'TypeError: fetch failed',
      'read ECONNRESET',
      'API Error (Request timed out.)',
    ]) {
      expect(kind(offline)).toBe('offline')
    }
    // Claude busy or failing on its side.
    for (const busy of [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'Repeated 529 Overloaded errors',
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      '503 Service Unavailable',
      'HTTP 502 Bad Gateway',
    ]) {
      expect(kind(busy)).toBe('overloaded')
    }
    // An outdated or broken Claude Code.
    for (const cli of ["error: unknown option '--safe-mode'", "Error: Cannot find module './cli.js'", 'Please update Claude Code to continue', 'claude is not recognized as an internal or external command']) {
      expect(kind(cli)).toBe('cli')
    }
    // A model (or effort) that can't be used: just the jobs asking for it.
    for (const model of [
      "There's an issue with the selected model (fable). It may not exist or you may not have access to it.",
      'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-9"}}',
      "error: option '--effort <level>' argument 'xhigh' is invalid. Allowed choices are low, medium, high, max.",
      'Claude Opus is not available with the Claude Pro plan',
      'The model claude-3-opus is no longer supported',
    ]) {
      expect(kind(model)).toBe('model')
    }
    // Too much for one run, or out of turns: this job's own problem, even worded like a limit.
    for (const job of ['Prompt is too long', 'API Error: 400 prompt is too long: 210000 tokens > 200000 maximum', 'Context limit reached', 'API Error: 413 request_too_large', 'error_max_turns']) {
      expect(kind(job)).toBe('job')
    }
    expect(kind('error_max_structured_output_retries')).toBe('invalid')
    // The usage limit and sign-in still win over the rest.
    expect(kind('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBe('limit')
    expect(kind('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}')).toBe('auth')
    // Numbers and words inside a trace don't count: a line number like 500 isn't a server error.
    expect(kind('TypeError: x\n    at cli.js:500:12')).toBe('failed')
    expect(kind('the model answered in prose')).toBe('failed')
  })

  it('never passes per-use credentials to claude', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.FAKE_CLAUDE_MODE = 'env'
    try {
      const r = await new ClaudeCliAdapter({ file: process.execPath, args: [fake] }).run(request())
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual({ apiKey: null, bedrock: null })
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_USE_BEDROCK
    }
  })
})
