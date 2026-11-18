#!/usr/bin/env node
// The one entry point: `scooter <command>` (8.4 of DESIGN.md).
//
// Each command belongs to one side and loads only that side: its settings, from its own env file,
// and its code. So a bridge command never holds the runner's key, and a runner command never holds
// the bridge's secrets.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SettingsError, loadSettings } from './common/settings.mjs'

// The commands. For each:
// - `side`: whose settings it loads. `bridge` reads `bridge.env`, and `runner` reads `runner.env`.
//   `host` is for the two commands root runs on the machine itself, which load neither here.
// - `usage` and `summary`: for the help text.
// - `where`: where it runs, as 8.4 puts it. Natively a command runs as its service's user.
// - `load`: returns the function that carries the command out. It imports the command's code
//   only when the command is run. A command without one isn't built yet.
//
// The function gets `{ args, settings, env, stdout, stderr }` and returns the exit code, or
// nothing for 0. `settings` is null for a `host` command.
export const COMMANDS = {
  bridge: {
    side: 'bridge',
    usage: 'bridge',
    where: 'bridge',
    summary: 'Run the bridge',
    load: async () => (await import('./bridge/main.mjs')).runBridge,
  },
  runner: {
    side: 'runner',
    usage: 'runner',
    where: 'runner',
    summary: 'Run the runner',
    // The runner, with pi's runs in Gondolin VMs (6.6).
    load: async () => {
      const [{ runRunner }, { openGondolinSandbox }] = await Promise.all([import('./runner/main.mjs'), import('./runner/sandbox/gondolin.mjs')])
      return ({ settings, stderr }) => runRunner({ settings, stderr, openSandbox: openGondolinSandbox })
    },
  },
  setup: {
    side: 'host',
    usage: 'setup [--no-services]',
    where: 'the host, as root',
    summary: 'Create the users, folders, env files and services of a native install',
  },
  doctor: { side: 'runner', usage: 'doctor', where: 'runner', summary: 'Check what the runner needs, and change nothing' },
  'build-image': {
    side: 'host',
    usage: 'build-image',
    where: 'the host, as root; in Docker, the runner container',
    summary: 'Build the VM image that pi runs in',
    load: async () => (await import('./runner/sandbox/image.mjs')).runBuildImage,
  },
  pair: {
    side: 'bridge',
    usage: 'pair [--phone +91…]',
    where: 'bridge',
    summary: 'Link wacli to the bot\'s WhatsApp number, with a QR code or a pairing code',
  },
  'email-check': {
    side: 'bridge',
    usage: 'email-check',
    where: 'bridge',
    summary: 'List the mailbox\'s newest 5 messages and whether each would pass the sender check',
    load: async () => (await import('./bridge/channels/email.mjs')).runEmailCheck,
  },
  'backup-init': { side: 'bridge', usage: 'backup-init', where: 'bridge', summary: 'Create the backup repository' },
  snapshots: { side: 'bridge', usage: 'snapshots', where: 'bridge', summary: 'List the backups' },
  check: { side: 'bridge', usage: 'check', where: 'bridge', summary: 'Check the backup repository' },
  restore: {
    side: 'bridge',
    usage: 'restore [snapshot] [--force]',
    where: 'bridge',
    summary: 'Restore a backup',
  },
  rebuild: {
    side: 'runner',
    usage: 'rebuild <agent>',
    where: 'runner, with the runner stopped',
    summary: 'Rebuild an agent\'s views from the whole datastore',
    // Its batches run in Gondolin VMs, as the runner's do (6.10).
    load: async () => {
      const [{ runRebuild }, { openGondolinSandbox }] = await Promise.all([import('./runner/rebuild.mjs'), import('./runner/sandbox/gondolin.mjs')])
      return ({ args, settings, stdout, stderr }) => runRebuild({ args, settings, stdout, stderr, openSandbox: openGondolinSandbox })
    },
  },
}

// Exit codes: 0 for success, 1 when a command fails, and 2 when it can't start because of how it
// was called or how Scooter is configured.
const EXIT_FAILED = 1
const EXIT_USAGE = 2

function helpText(commands) {
  const width = Math.max(...Object.values(commands).map(command => command.usage.length))
  const lines = ['Usage: scooter <command>', '']
  for (const command of Object.values(commands)) {
    lines.push(`  ${command.usage.padEnd(width)}  ${command.summary} (${command.where})`)
  }
  return `${lines.join('\n')}\n`
}

// Runs one command and returns the exit code. `argv` is the command line after `scooter`.
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, commands = COMMANDS } = {}) {
  const [name, ...args] = argv
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    ;(name === undefined ? stderr : stdout).write(helpText(commands))
    return name === undefined ? EXIT_USAGE : 0
  }
  if (!Object.hasOwn(commands, name)) {
    stderr.write(`scooter: no such command: ${name}\n\n${helpText(commands)}`)
    return EXIT_USAGE
  }
  const command = commands[name]
  if (!command.load) {
    stderr.write(`scooter ${name}: this command isn't built yet\n`)
    return EXIT_FAILED
  }

  let settings = null
  if (command.side !== 'host') {
    try {
      settings = loadSettings(command.side, { env })
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error
      for (const problem of error.problems) stderr.write(`scooter ${name}: ${problem.message}\n`)
      return EXIT_USAGE
    }
  }
  const run = await command.load()
  return (await run({ args, settings, env, stdout, stderr })) ?? 0
}

// True when this file is what Node was started with, also through the `scooter` link that npm or
// `setup` makes to it.
function startedDirectly() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (startedDirectly()) {
  process.exitCode = await main(process.argv.slice(2))
}
