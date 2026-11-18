// Every path under the data folder and the config folder, in one place (3.2, 4.1, 6.2 of
// DESIGN.md).
//
// `DATA_DIR` is `/data` in Docker and `/var/lib/scooter` natively; `CONFIG_DIR` is `/config` or
// `/etc/scooter/config`. Code takes the paths from here and doesn't build them by hand. What a
// module does build itself is the name of a file inside one of these folders, such as an
// attachment in a day folder.

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
    // Where the clean-up sets an agent's `views/` and `memory/` aside before it removes them (6.9):
    // beside the agent's folder, so on the same file system, and outside everything pi's VM sees.
    // Backups leave the whole of `agents/.discarded/` out: it holds what is being removed.
    agentDiscarded: name => data('agents', '.discarded', name),
    agentsDiscarded: data('agents', '.discarded'),

    // The exchange (5.3, 5.5, 6.4).
    exchange: data('exchange'),
    outbox: data('exchange', 'outbox'),
    locks: data('exchange', 'locks'),
    runLock: data('exchange', 'locks', 'run.lock'),
    backupLock: data('exchange', 'locks', 'backup.lock'),

    // The runner's own folder (6.3, 6.6, 6.12, 6.13), and the socket that keeps a second runner
    // from starting on the same data. `date` is a UTC date, `2026-11-09`.
    runner: data('runner'),
    runnerStatus: data('runner', 'status.json'),
    runnerSocket: data('runner', 'runner.sock'),
    runnerImage: data('runner', 'image'),
    runnerHome: data('runner', 'home'),
    runnerTmp: data('runner', 'tmp'),
    networkLogDir: data('runner', 'log'),
    networkLog: date => data('runner', 'log', `${date}.jsonl`),
    // Where `build-image` builds the VM image, and sets the old one aside, before and after it
    // renames the new one into `runner/image/` (6.12): beside `runner/`, so on the same file
    // system, and natively in a folder only root can write, not in the runner's own.
    imageStaging: data('.image-build'),

    // The bridge's own folder (5.1): its state; the socket that keeps a second bridge from
    // starting on the same data; where attachments wait between their channel and the store; and
    // the cache of the backup program (5.5), which marks itself as a cache, so backups leave it out.
    bridge: data('bridge'),
    bridgeState: data('bridge', 'state.json'),
    bridgeSocket: data('bridge', 'bridge.sock'),
    bridgeIncoming: data('bridge', 'incoming'),
    backupCache: data('bridge', 'backup-cache'),

    // wacli's folder (5.1, 5.5): its home, its store, where it downloads media for the bridge, and
    // the XDG folders it is given.
    wacli: data('wacli'),
    wacliStore: data('wacli', 'store'),
    wacliStaging: data('wacli', 'staging'),
    wacliConfig: data('wacli', 'config'),
    wacliState: data('wacli', 'state'),
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
