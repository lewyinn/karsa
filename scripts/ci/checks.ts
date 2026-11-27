// Runs every small CI check at once and reports every failure, not just the first.
//   bun scripts/ci/checks.ts            run all checks
//   bun scripts/ci/checks.ts biome tsc  run the named checks
const CHECKS: Record<string, string> = {
  biome: 'bun run ci',
  'tsc:node': 'bun run typecheck:node',
  'tsc:web': 'bun run typecheck:web',
  'tsc:test': 'bun run typecheck:test',
  shell: 'bun run test:shell',
  'build:web': 'bun run build:web && test -s dist-web/index.html',
  'build:tauri': 'bun run build:frontend:tauri'
}

type Result = { name: string; ok: boolean; ms: number; output: string }

async function run(name: string, command: string): Promise<Result> {
  const start = performance.now()
  const proc = Bun.spawn(['bash', '-o', 'pipefail', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '1' }
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { name, ok: code === 0, ms: performance.now() - start, output: stdout + stderr }
}

const requested = process.argv.slice(2)
const unknown = requested.filter((name) => !(name in CHECKS))
if (unknown.length > 0) {
  console.error(`unknown check: ${unknown.join(', ')}. Known: ${Object.keys(CHECKS).join(', ')}`)
  process.exit(2)
}
const names = requested.length > 0 ? requested : Object.keys(CHECKS)
const ci = process.env.GITHUB_ACTIONS === 'true'

const results = await Promise.all(names.map((name) => run(name, CHECKS[name])))

for (const result of results) {
  console.log(ci ? `::group::${result.name}` : `\n── ${result.name}`)
  console.log(result.output.trimEnd())
  if (ci) console.log('::endgroup::')
}

console.log('')
for (const result of results) {
  console.log(
    `${result.ok ? 'pass' : 'FAIL'}  ${(result.ms / 1000).toFixed(1).padStart(6)}s  ${result.name}`
  )
}
const failed = results.filter((result) => !result.ok)
for (const result of failed) {
  if (ci) console.log(`::error title=${result.name} failed::${CHECKS[result.name]}`)
}
if (failed.length > 0) {
  console.log(
    `\n${failed.length} of ${results.length} checks failed: ${failed.map((r) => r.name).join(', ')}`
  )
  process.exit(1)
}
