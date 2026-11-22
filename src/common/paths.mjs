// Every path under the data folder and the config folder, in one place.
//
// `DATA_DIR` is `/data` in Docker and `/var/lib/scooter` natively; `CONFIG_DIR` is `/config` or
// `/etc/scooter/config`. Code takes the paths from here and doesn't build them by hand. What a
// module does build itself is the name of a file inside one of these folders, such as an
// attachment in a day folder.

import path from 'node:path'

// A day folder's name: the `YYYY/MM/DD` of a UTC date such as `2026-11-09`.
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

    // The datastore. `day` is a day folder's name, `YYYY/MM/DD`.
    datastore: data('datastore'),
    dayDir: day => data('datastore', day),
    dayLog: day => data('datastore', day, 'log.jsonl'),

    // The agents' folders.
    agents: data('agents'),
    agentDir: agent,
    agentSessions: name => path.join(agent(name), 'sessions'),
    agentRun: name => path.join(agent(name), 'run'),
    agentRunConfig: name => path.join(agent(name), 'run', 'config'),
    agentRunSession: name => path.join(agent(name), 'run', 'session'),
    // What `send` and `mark` leave for the runner, the run's two places in `run/` but its session
    // that it may write: a folder of the messages to send, and the file of the marks.
    agentRunSend: name => path.join(agent(name), 'run', 'send'),
    agentRunMarks: name => path.join(agent(name), 'run', 'marks.txt'),
    // The run's index file, the programs that ship with the runner, which the VM finds on its
    // `PATH`, the runner's own skill, and ICU's zone rules, which the VM's Node converts times with.
    agentRunIndex: name => path.join(agent(name), 'run', 'index.txt'),
    agentRunBin: name => path.join(agent(name), 'run', 'bin'),
    agentRunSkills: name => path.join(agent(name), 'run', 'skills'),
    agentRunIcuTz: name => path.join(agent(name), 'run', 'icu-tz'),
    agentState: name => path.join(agent(name), 'state.json'),
    // Where the clean-up sets aside what an agent's `writes` names in its folder before it removes it:
    // beside the agent's folder, so on the same file system, and outside everything pi's VM sees.
    // Backups leave the whole of `agents/.discarded/` out: it holds what is being removed.
    agentDiscarded: name => data('agents', '.discarded', name),
    agentsDiscarded: data('agents', '.discarded'),

    // The exchange.
    exchange: data('exchange'),
    outbox: data('exchange', 'outbox'),
    locks: data('exchange', 'locks'),
    runLock: data('exchange', 'locks', 'run.lock'),
    backupLock: data('exchange', 'locks', 'backup.lock'),

    // The runner's own folder, and the socket that keeps a second runner
    // from starting on the same data. `date` is a UTC date, `2026-11-09`.
    runner: data('runner'),
    runnerStatus: data('runner', 'status.json'),
    // How the runner's latest starts ended, for the waits it keeps between them where its service
    // manager doesn't.
    runnerRestarts: data('runner', 'restarts.json'),
    runnerSocket: data('runner', 'runner.sock'),
    runnerImage: data('runner', 'image'),
    runnerHome: data('runner', 'home'),
    runnerTmp: data('runner', 'tmp'),
    networkLogDir: data('runner', 'log'),
    networkLog: date => data('runner', 'log', `${date}.jsonl`),
    // Where `build-image` builds the VM image, and sets the old one aside, before and after it
    // renames the new one into `runner/image/`: beside `runner/`, so on the same file
    // system, and natively in a folder only root can write, not in the runner's own.
    imageStaging: data('.image-build'),

    // The bridge's own folder: its state; its status, which `scooter status` reads, in a folder of
    // its own, which backups leave out whole, with the temporary files its writes make; the socket
    // that keeps a second bridge from starting on the same data; where attachments wait between
    // their channel and the store; the cache of the backup program, which marks itself as a cache,
    // so backups leave it out; and delivery's two folders: the bridge's own outbox entries, and its
    // record of how much of each runner's entry it has sent, `<entry ID>.json`. Both are here, in a
    // folder only root can write, rather than in the runner's outbox, so the bridge writes nothing
    // there.
    bridge: data('bridge'),
    bridgeState: data('bridge', 'state.json'),
    bridgeStatusDir: data('bridge', 'status'),
    bridgeStatus: data('bridge', 'status', 'status.json'),
    bridgeSocket: data('bridge', 'bridge.sock'),
    bridgeIncoming: data('bridge', 'incoming'),
    backupCache: data('bridge', 'backup-cache'),
    bridgeOutbox: data('bridge', 'outbox'),
    bridgeSending: data('bridge', 'sending'),

    // wacli's folder: its home, its store, where it downloads media for the bridge, and
    // the XDG folders it is given.
    wacli: data('wacli'),
    wacliStore: data('wacli', 'store'),
    wacliStaging: data('wacli', 'staging'),
    wacliConfig: data('wacli', 'config'),
    wacliState: data('wacli', 'state'),
    wacliCache: data('wacli', 'cache'),

    // The email reader's folder.
    mail: data('mail'),
    mailState: data('mail', 'state.json'),
    mailSpool: data('mail', 'spool'),

    // The owner's configuration, which only the runner reads.
    config: configDir,
    agentsYaml: config('agents.yaml'),
    imageBuild: config('image', 'build.json'),
  }
}
