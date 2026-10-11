// Stands in for `claude -p` in tests. Behaviour comes from FAKE_CLAUDE_MODE.
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok'
  if (mode === 'hang') {
    setTimeout(() => {}, 60_000)
    return
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  if (mode === 'env') {
    const env = { apiKey: process.env.ANTHROPIC_API_KEY ?? null, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK ?? null }
    out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: env })
  } else if (mode === 'ok') {
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      structured_output: { args, stdin, cwd: process.cwd() },
      total_cost_usd: 0.01,
      duration_ms: 1200,
      usage: { input_tokens: 12, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 },
      modelUsage: { 'claude-sonnet-test': { inputTokens: 12, outputTokens: 80, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400, costUSD: 0.01 } },
    })
  } else if (mode === 'limit') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 2026-10-10T15:00:00Z.' })
    process.exitCode = 1
  } else if (mode === 'auth') {
    out({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })
    process.exitCode = 1
  } else if (mode === 'no-structured') {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'plain text' })
  } else if (mode === 'offline') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.' })
    process.exitCode = 1
  } else if (mode === 'overloaded') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })
    process.exitCode = 1
  } else if (mode === 'old-cli') {
    // An older claude refusing a flag: nothing on stdout, the reason on stderr.
    process.stderr.write("error: unknown option '--safe-mode'\n")
    process.exitCode = 1
  } else {
    process.stdout.write('oops, not json')
    process.exitCode = 2
  }
})
