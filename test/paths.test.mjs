// Every path under the data folder and the config folder.

import assert from 'node:assert/strict'
import test from 'node:test'
import { dayOfDate, makePaths } from '../src/common/paths.mjs'

test('paths: the data folder\'s folders, as they are in Docker', () => {
  const paths = makePaths({ dataDir: '/data', configDir: '/config' })
  const lifelog = Object.fromEntries(
    Object.entries(paths).map(([name, value]) => [name, typeof value === 'function' ? value(name.startsWith('agent') ? 'lifelog' : name === 'networkLog' ? '2026-11-09' : '2026/11/09') : value]),
  )
  assert.deepEqual(lifelog, {
    dataDir: '/data',
    configDir: '/config',
    datastore: '/data/datastore',
    dayDir: '/data/datastore/2026/11/09',
    dayLog: '/data/datastore/2026/11/09/log.jsonl',
    agents: '/data/agents',
    agentDir: '/data/agents/lifelog',
    agentMemory: '/data/agents/lifelog/memory',
    agentSessions: '/data/agents/lifelog/sessions',
    agentRun: '/data/agents/lifelog/run',
    agentRunSystem: '/data/agents/lifelog/run/system.md',
    agentRunConfig: '/data/agents/lifelog/run/config',
    agentRunSession: '/data/agents/lifelog/run/session',
    agentRunIndex: '/data/agents/lifelog/run/index.txt',
    agentRunBin: '/data/agents/lifelog/run/bin',
    agentRunSkills: '/data/agents/lifelog/run/skills',
    agentState: '/data/agents/lifelog/state.json',
    agentDiscarded: '/data/agents/.discarded/lifelog',
    agentsDiscarded: '/data/agents/.discarded',
    exchange: '/data/exchange',
    outbox: '/data/exchange/outbox',
    locks: '/data/exchange/locks',
    runLock: '/data/exchange/locks/run.lock',
    backupLock: '/data/exchange/locks/backup.lock',
    runner: '/data/runner',
    runnerStatus: '/data/runner/status.json',
    runnerRestarts: '/data/runner/restarts.json',
    runnerSocket: '/data/runner/runner.sock',
    runnerImage: '/data/runner/image',
    runnerHome: '/data/runner/home',
    runnerTmp: '/data/runner/tmp',
    networkLogDir: '/data/runner/log',
    networkLog: '/data/runner/log/2026-11-09.jsonl',
    imageStaging: '/data/.image-build',
    bridge: '/data/bridge',
    bridgeState: '/data/bridge/state.json',
    bridgeStatusDir: '/data/bridge/status',
    bridgeStatus: '/data/bridge/status/status.json',
    bridgeSocket: '/data/bridge/bridge.sock',
    bridgeIncoming: '/data/bridge/incoming',
    backupCache: '/data/bridge/backup-cache',
    bridgeOutbox: '/data/bridge/outbox',
    bridgeSending: '/data/bridge/sending',
    wacli: '/data/wacli',
    wacliStore: '/data/wacli/store',
    wacliStaging: '/data/wacli/staging',
    wacliConfig: '/data/wacli/config',
    wacliState: '/data/wacli/state',
    wacliCache: '/data/wacli/cache',
    mail: '/data/mail',
    mailState: '/data/mail/state.json',
    mailSpool: '/data/mail/spool',
    config: '/config',
    agentsYaml: '/config/agents.yaml',
    imageBuild: '/config/image/build.json',
  })
})

test('paths: everything follows DATA_DIR and CONFIG_DIR', () => {
  // Natively the data is in /var/lib/scooter and the config in /etc/scooter/config.
  const paths = makePaths({ dataDir: '/var/lib/scooter', configDir: '/etc/scooter/config' })
  for (const [name, value] of Object.entries(paths)) {
    const resolved = typeof value === 'function' ? value('x') : value
    const root = ['config', 'configDir', 'agentsYaml', 'imageBuild'].includes(name) ? '/etc/scooter/config' : '/var/lib/scooter'
    assert.ok(resolved === root || resolved.startsWith(`${root}/`), `${name}: ${resolved}`)
  }
  assert.equal(paths.dayLog('2026/11/09'), '/var/lib/scooter/datastore/2026/11/09/log.jsonl')
})

test('paths: a day folder is named after a UTC date', () => {
  assert.equal(dayOfDate('2026-11-09'), '2026/11/09')
  assert.equal(dayOfDate('2027-01-01'), '2027/01/01')
})
