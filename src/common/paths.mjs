// Every path under the data folder and the config folder, in one place (3.2, 4.1, 6.2 of
// DESIGN.md).
//
// `DATA_DIR` is `/data` in Docker and `/var/lib/scooter` natively; `CONFIG_DIR` is `/config` or
// `/etc/scooter/config`. Nothing else in the code builds these paths by hand.

import path from 'node:path'

// A day folder's name: the `YYYY/MM/DD` of a UTC date such as `2026-11-09` (4.1).
export function dayOfDate(date) {
  return date.replaceAll('-', '/')
}

export function makePaths({ dataDir, configDir }) {
  const data = (...parts) => path.join(dataDir, ...parts)
  const config = (...parts) => path.join(configDir, ...parts)
  const agent = name => data('agents', name)

  return {
    dataDir,
    configDir,

    // The datastore (4.1). `day` is a day folder's name, `YYYY/MM/DD`.
    datastore: data('datastore'),
    dayDir: day => data('datastore', day),
    dayLog: day => data('datastore', day, 'log.jsonl'),

    // The agents' folders (6.2).
    agents: data('agents'),
    agentDir: agent,
    agentViews: name => path.join(agent(name), 'views'),
    agentMemory: name => path.join(agent(name), 'memory'),
    agentSessions: name => path.join(agent(name), 'sessions'),
    agentRun: name => path.join(agent(name), 'run'),
    agentRunSystem: name => path.join(agent(name), 'run', 'system.md'),
    agentRunConfig: name => path.join(agent(name), 'run', 'config'),
    agentRunSession: name => path.join(agent(name), 'run', 'session'),
    agentState: name => path.join(agent(name), 'state.json'),

    // The exchange (5.3, 5.5, 6.4).
    exchange: data('exchange'),
    outbox: data('exchange', 'outbox'),
    locks: data('exchange', 'locks'),
    runLock: data('exchange', 'locks', 'run.lock'),
    backupLock: data('exchange', 'locks', 'backup.lock'),

    // The runner's own folder (6.3, 6.6, 6.12, 6.13). `date` is a UTC date, `2026-11-09`.
    runner: data('runner'),
    runnerStatus: data('runner', 'status.json'),
    runnerImage: data('runner', 'image'),
    runnerHome: data('runner', 'home'),
    runnerTmp: data('runner', 'tmp'),
    networkLogDir: data('runner', 'log'),
    networkLog: date => data('runner', 'log', `${date}.jsonl`),

    // The bridge's own state (5.1).
    bridge: data('bridge'),
    bridgeState: data('bridge', 'state.json'),

    // wacli's folder (5.1, 5.5).
    wacli: data('wacli'),
    wacliStore: data('wacli', 'store'),
    wacliStaging: data('wacli', 'staging'),
    wacliCache: data('wacli', 'cache'),

    // The email reader's folder (5.6).
    mail: data('mail'),
    mailState: data('mail', 'state.json'),
    mailSpool: data('mail', 'spool'),

    // The owner's configuration, which only the runner reads (6.1, 6.12).
    config: configDir,
    agentsYaml: config('agents.yaml'),
    imageBuild: config('image', 'build.json'),
  }
}
