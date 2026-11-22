// A live check (milestone 8's "done when"): pi in a VM,
// through the runner and its network policy, against the real OpenRouter, with a dummy key. It is
// run by hand, since it needs the network, and isn't part of `npm test`. It needs QEMU, a built
// image and `debugfs`, as the sandbox tests do:
//
//   SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'node test/live/openrouter.mjs'
//
// For each of OpenRouter's two chat routes, with a model pi sends there, it runs the runner on one
// message, with the agent's instructions of the repository's `config/` (the plan's milestone 11)
// and a well-formed key OpenRouter doesn't know. pi's request must pass the policy and
// reach OpenRouter, which answers 401, and the runner must take that as a setup error: runs paused,
// no attempt counted, one notice. Then, in a VM of the same sandbox, `curl https://example.com/`
// must be refused by the policy. It prints what it found, and exits with 1 if anything wasn't so.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLog } from '../../src/common/log.mjs'
import { readNetworkLog } from '../../src/common/netlog.mjs'
import { makePaths } from '../../src/common/paths.mjs'
import { systemClock } from '../../src/common/time.mjs'
import { openRunner } from '../../src/runner/main.mjs'
import { loadConfig } from '../../src/runner/config.mjs'
import { piEnv, piFiles } from '../../src/runner/run.mjs'
import { openGondolinSandbox } from '../../src/runner/sandbox/gondolin.mjs'
import { line, writeDatastore } from '../support/runner.mjs'
import { linkTestImage, sandboxSkipReason } from '../support/sandbox.mjs'
import { runnerSettings } from '../support/test-runner.mjs'

const DUMMY_KEY = `sk-or-v1-${'0'.repeat(64)}`
const ROUTES = [
  ['messages', 'anthropic/claude-sonnet-5.5', '/api/v1/messages'],
  ['chat', 'google/gemini-2.5-flash', '/api/v1/chat/completions'],
]

const skip = sandboxSkipReason()
if (skip) {
  console.error(`can't run: ${skip}`)
  process.exit(2)
}

// The sandbox gives the runner a temporary folder of its own, in the data folder, which goes with it.
const TMP = fs.realpathSync(os.tmpdir())

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures += 1
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

for (const [route, model, routePath] of ROUTES) {
  console.log(`\n== ${route} route, ${model}`)
  const root = fs.mkdtempSync(path.join(TMP, 'scooter-live-'))
  try {
    const settings = runnerSettings(root, { openrouterApiKey: DUMMY_KEY, batchSeconds: 1 })
    const paths = makePaths(settings)
    // The repository's own config folder, as `setup` copies it, with the route's model.
    fs.cpSync(new URL('../../config', import.meta.url), paths.configDir, { recursive: true })
    const agentsYaml = path.join(paths.configDir, 'agents.yaml')
    fs.writeFileSync(agentsYaml, fs.readFileSync(agentsYaml, 'utf8').replace('model: anthropic/claude-sonnet-5.5', `model: ${model}`))
    fs.mkdirSync(paths.datastore, { recursive: true })
    writeDatastore(paths, [line.text(1, new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z'), 'coffee 150 at Blue Tokai')])
    await linkTestImage(paths)
    fs.mkdirSync(path.dirname(paths.imageBuild), { recursive: true })
    fs.copyFileSync(new URL('../../config/image/build.json', import.meta.url), paths.imageBuild)

    const logged = []
    const log = createLog({ component: 'runner', write: text => logged.push(JSON.parse(text)) })
    const runner = await openRunner({ settings, clock: systemClock, log, openSandbox: options => openGondolinSandbox(options) })
    try {
      const started = Date.now()
      let outcome
      for (let n = 0; n < 600 && outcome === undefined; n++) {
        outcome = (await runner.tick()).outcome
        if (outcome === undefined) await sleep(200)
      }
      console.log(`run: ${JSON.stringify(outcome)}, ${Date.now() - started} ms, VMs with ${runner.sandbox.accel}`)
      const state = JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))
      console.log(`paused: ${JSON.stringify(state.paused)}`)
      console.log(`retry: ${JSON.stringify(state.retry)}`)
      const all = () => readNetworkLog(paths, { from: started - 1000, to: Date.now() + 1000 }).entries
      const lines = all()
      for (const entry of lines) console.log(`log: ${JSON.stringify(entry)}`)

      check(outcome?.ok === false && outcome?.cause === 'setup', 'the runner took the run as a setup error')
      check(state.paused?.cause === 'setup', 'runs are paused')
      check(state.retry?.[0]?.attempts === 0, 'no attempt counted')
      const requests = lines.filter(entry => entry.event === 'request')
      check(requests.length > 0 && requests.every(entry => entry.host === 'openrouter.ai' && entry.method === 'POST' && entry.path === routePath), `pi's requests went to openrouter.ai${routePath}, through the policy`)
      check(!lines.some(entry => entry.event === 'refused'), 'the policy refused none of them')
      const statuses = lines.filter(entry => entry.event === 'response').map(entry => entry.status)
      check(statuses.length === requests.length && statuses.every(status => status === 401), 'OpenRouter answered each with 401')
      check(lines.filter(entry => entry.event === 'end').length === requests.length, 'each answer is followed to its end')

      // In a VM of the same sandbox: another host, refused.
      const agent = { model }
      const result = await runner.sandbox.run({
        argv: ['/bin/sh', '-c', 'curl -sS -f -m 20 https://example.com/ >/dev/null 2>&1; echo "curl: $?"'],
        cwd: paths.agentDir('lifelog'),
        env: piEnv({ timeZone: settings.timeZone, binDir: paths.agentRunBin('lifelog') }),
        files: piFiles(paths, loadConfig({ paths }).agents[0]),
        timeoutMs: 120_000,
        policy: { model: agent.model, internet: false, zdr: true, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: DUMMY_KEY } } },
      })
      console.log(`example.com: ${result.stdout.trim()}`)
      const after = all().slice(lines.length)
      for (const entry of after) console.log(`log: ${JSON.stringify(entry)}`)
      check(result.stdout.trim() !== 'curl: 0', 'curl https://example.com/ failed in the VM')
      check(after.length === 1 && after[0].event === 'refused' && after[0].host === 'example.com' && after[0].reason === 'host not allowed', 'the policy refused example.com, and nothing went out')
    } finally {
      await runner.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nall as it should be' : `\n${failures} not as it should be`)
process.exit(failures === 0 ? 0 : 1)
