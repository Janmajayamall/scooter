// `scooter doctor`: checks what the runner needs, and changes nothing.
//
// Natively it runs as the runner's user, `sudo -u scooter-runner scooter doctor`; in Docker, in the
// runner's container. It reports, each with its fix when it isn't as it should be:
// - which accelerator pi's VMs can use, and, without KVM, how to enable it in this setup;
// - QEMU;
// - the VM image, and the pi version it holds against the one the build file pins;
// - that a VM boots from it, with that accelerator, and how long it took;
// - `agents.yaml`, which the runner checks at its start;
// - the owners and modes of the data folder's folders, and of the two env files;
// - whether `openrouter.ai` can be reached from here;
// - with ZDR on, which of the configured model's endpoints keep no data.
//
// It sends OpenRouter no key and nothing of the owner's: it asks for OpenRouter's public list of
// the endpoints that keep no data, which also says whether OpenRouter can be reached.
//
// It checks what the runner's user can reach, so it runs as that user, and refuses to run as another
// where that user is there.
//
// What it checks of the runner, the config, the image, the accelerator and the VM's boot is the
// runner's own code, which `src/cli.mjs` hands it as `runner`: `src/ops` imports only `src/common`.

import fs from 'node:fs'
import path from 'node:path'
import { limits } from '../common/limits.mjs'
import { createLog } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc, findProgram, inDocker } from '../common/proc.mjs'
import { DEFAULT_ENV_DIR, ENV_DIR_VARIABLE } from '../common/settings.mjs'
import { USERS, dataFolders } from './setup.mjs'

// OpenRouter's public list of the endpoints that keep no prompts or responses.
export const ZDR_ENDPOINTS_URL = 'https://openrouter.ai/api/v1/endpoints/zdr'

const octal = mode => `0${(mode & 0o7777).toString(8)}`

// How to make KVM usable, for an error code from `kvmProblem`, natively or in Docker, where the
// runner runs as scooter-runner in every case, and compose.yaml's two KVM files give it the device.
export function kvmFix(problem, { docker = false, runnerUser = USERS.runner } = {}) {
  if (problem === 'ENOENT') {
    return docker
      ? "the runner's container has no /dev/kvm: on a host that has KVM, add compose.kvm.yaml (rootful Docker) or compose.kvm-rootless.yaml (rootless Docker) to COMPOSE_FILE in .env, as each of them says, and start the runner again"
      : "this machine has no /dev/kvm: turn on virtualization in its firmware, or nested virtualization if it is itself a VM, and load the kvm module (modprobe kvm_intel or kvm_amd)"
  }
  return docker
    ? `${runnerUser} can't open /dev/kvm in its container (${problem}): with rootful Docker, compose.kvm.yaml gives it the host's kvm group, with KVM_GID in .env set to the group's id (getent group kvm); with rootless Docker, the udev rule compose.kvm-rootless.yaml gives lets the uid ${runnerUser} has on the host open it`
    : `${runnerUser} can't open /dev/kvm (${problem}): sudo scooter setup puts it in the kvm group, and the service gets the group from SupplementaryGroups=kvm; run doctor as sudo -u ${runnerUser} scooter doctor, which gives it the group too. /dev/kvm must be the kvm group's, mode 0660 (ls -l /dev/kvm)`
}

// The accelerator check, for `setting`, `AGENT_ACCEL`, and `problem`, from `kvmProblem`.
export function accelCheck(setting, problem, { docker = false } = {}) {
  const name = 'accelerator'
  if (setting === 'emulation') return { name, status: 'ok', text: 'emulation, as AGENT_ACCEL says: each batch is much slower than with KVM' }
  if (setting === 'hvf') return { name, status: 'fail', text: "AGENT_ACCEL=hvf is Apple's hypervisor, which only macOS has", fix: 'set AGENT_ACCEL to auto, kvm or emulation in runner.env' }
  if (problem === null) return { name, status: 'ok', text: 'KVM' }
  const fix = kvmFix(problem, { docker })
  if (setting === 'kvm') return { name, status: 'fail', text: "AGENT_ACCEL=kvm, and KVM can't be used", fix }
  return { name, status: 'warn', text: "emulation, since KVM can't be used: pi's VMs run, about ten times slower", fix }
}

// The QEMU check: the system emulator for this machine, and `qemu-img`, which Gondolin runs.
export function qemuCheck({ program, find = findProgram }) {
  const missing = [program, 'qemu-img'].filter(name => find(name) === null)
  if (missing.length === 0) return { name: 'QEMU', status: 'ok', text: `${program} and qemu-img` }
  const packages = program.endsWith('x86_64') ? 'qemu-system-x86 qemu-utils' : 'qemu-system-arm qemu-utils'
  return { name: 'QEMU', status: 'fail', text: `${missing.join(' and ')} ${missing.length === 1 ? "isn't" : "aren't"} on the PATH`, fix: `install QEMU, such as apt install ${packages}` }
}

// The checks of the data folder's folders against `dataFolders`, for the users' ids. The
// runner's user can look at each folder there, but into its own only. Each wrong one is a check.
export function folderChecks(paths, ids, { docker = false } = {}) {
  const checks = []
  for (const { path: folder, owner, mode } of dataFolders(paths, ids)) {
    let stat
    try {
      stat = folder === paths.dataDir ? fs.statSync(folder) : fs.lstatSync(folder)
    } catch (error) {
      if (error.code === 'EACCES') continue
      checks.push({ name: 'folders', status: 'fail', text: `${folder} can't be looked at (${error.code ?? error.name})`, fix: fixFolder(folder, owner, mode, docker) })
      continue
    }
    const wrong = !stat.isDirectory() ? 'is not a folder' : stat.uid !== owner.uid || stat.gid !== owner.gid || (stat.mode & 0o7777) !== mode ? `is ${stat.uid}:${stat.gid}, mode ${octal(stat.mode)}` : null
    if (wrong === null) continue
    checks.push({ name: 'folders', status: 'fail', text: `${folder} ${wrong}, where it must be ${owner.uid}:${owner.gid}, mode ${octal(mode)}`, fix: fixFolder(folder, owner, mode, docker) })
  }
  if (checks.length === 0) checks.push({ name: 'folders', status: 'ok', text: `${paths.dataDir} and its folders have their owners and modes` })
  return checks
}

function fixFolder(folder, owner, mode, docker) {
  return docker ? `docker compose run --rm --entrypoint sh bridge -c 'chown ${owner.uid}:${owner.gid} ${folder} && chmod ${octal(mode)} ${folder}'` : 'sudo scooter setup, which sets them'
}

// The check that a VM boots, for what `bootCheck` returned, or the error it threw, and the
// accelerator in use. Under nested virtualization `/dev/kvm` can open and a VM still not boot.
export function bootCheckResult({ booted = null, error = null, docker = false }) {
  const name = 'VM boot'
  if (error === null) return { name, status: 'ok', text: `a VM booted in ${booted.ms === null ? '?' : (booted.ms / 1000).toFixed(1)} seconds, with ${booted.accel === 'kvm' ? 'KVM' : 'emulation'}` }
  const env = docker ? 'runner.env beside compose.yaml' : 'runner.env'
  return {
    name,
    status: 'fail',
    text: `a VM didn't boot from the image: ${error.message}`,
    fix: `if KVM is in use, as on a machine that is itself a VM, enable nested virtualization for it, or set AGENT_ACCEL=emulation in ${env}; otherwise build the image again, with ${docker ? 'docker compose run --rm build-image' : 'sudo scooter build-image'}`,
  }
}

// The check of the env files: the runner's own is the runner's, mode 0600, and it can't
// read the bridge's. In Docker each service gets its settings in its environment, and the files
// aren't there.
export function envFileCheck(envDir, { uid = process.getuid?.() } = {}) {
  const name = 'env files'
  const problems = []
  const runnerEnv = path.join(envDir, 'runner.env')
  let present = 0
  try {
    const stat = fs.statSync(runnerEnv)
    present++
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) problems.push(`${runnerEnv} is ${stat.uid}, mode ${octal(stat.mode)}, where it must be the runner's, 0600`)
  } catch (error) {
    if (error.code !== 'ENOENT') problems.push(`${runnerEnv} can't be looked at (${error.code ?? error.name})`)
  }
  const bridgeEnv = path.join(envDir, 'bridge.env')
  try {
    fs.closeSync(fs.openSync(bridgeEnv, 'r'))
    problems.push(`the runner can read ${bridgeEnv}, which holds the bridge's secrets: it must be root's, 0600`)
  } catch (error) {
    if (error.code !== 'ENOENT') present++
  }
  if (problems.length > 0) return { name, status: 'fail', text: problems.join('; '), fix: 'sudo scooter setup, which sets them' }
  if (present === 0) return { name, status: 'ok', text: `none in ${envDir}: the settings come from the environment` }
  return { name, status: 'ok', text: "runner.env is the runner's, and bridge.env out of its reach" }
}

// Reads a response's body, at most `maxBytes`. Throws an error with the code `EFBIG` past it.
async function readBody(response, maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maxBytes) throw Object.assign(new Error(`the answer is over ${maxBytes} bytes`), { code: 'EFBIG' })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

// Asks OpenRouter for its list of the endpoints that keep no data. Returns `{ status, endpoints }`,
// `endpoints` being null when the answer isn't the list; or `{ error }` when OpenRouter can't be
// reached, within `DOCTOR_TIMEOUT`. `stop`, a signal, ends the wait sooner, as `doctor`'s stop does.
export async function fetchZdrEndpoints({ fetch = globalThis.fetch, stop = null } = {}) {
  const timeout = AbortSignal.timeout(limits.DOCTOR_TIMEOUT)
  const signal = stop === null ? timeout : AbortSignal.any([timeout, stop])
  let response
  try {
    response = await fetch(ZDR_ENDPOINTS_URL, { signal, headers: { accept: 'application/json' } })
  } catch (error) {
    if (stop?.aborted) return { error: 'doctor was stopped' }
    return { error: timeout.aborted ? `no answer within ${limits.DOCTOR_TIMEOUT / 1000} seconds` : (error.cause?.code ?? error.code ?? error.message) }
  }
  let endpoints = null
  try {
    const answer = JSON.parse(await readBody(response, limits.DOCTOR_RESPONSE_MAX_BYTES))
    if (Array.isArray(answer?.data)) endpoints = answer.data
  } catch {
    // not the list
  }
  return { status: response.status, endpoints }
}

// The checks of OpenRouter: whether it answers, and, with ZDR on, which of `model`'s endpoints keep
// no data. `zdr` is what `fetchZdrEndpoints` returned.
export function openRouterChecks(zdr, { model, zdrOn }) {
  if (zdr.error !== undefined) {
    return [{ name: 'OpenRouter', status: 'fail', text: `openrouter.ai can't be reached from here (${zdr.error})`, fix: "the runner sends pi's requests from this machine: check its network, DNS and firewall" }]
  }
  const checks = [{ name: 'OpenRouter', status: 'ok', text: `openrouter.ai answers (HTTP ${zdr.status})` }]
  if (!zdrOn) {
    checks.push({ name: 'ZDR', status: 'ok', text: 'off (OPENROUTER_ZDR=off), so not checked' })
  } else if (model === null) {
    checks.push({ name: 'ZDR', status: 'warn', text: "not checked: agents.yaml can't be read" })
  } else if (zdr.endpoints === null) {
    checks.push({ name: 'ZDR', status: 'warn', text: `not checked: OpenRouter's list of the endpoints that keep no data didn't come (HTTP ${zdr.status})` })
  } else {
    const found = zdr.endpoints.filter(endpoint => endpoint?.model_id === model)
    if (found.length === 0) {
      checks.push({
        name: 'ZDR',
        status: 'fail',
        text: `no endpoint of ${model} keeps no data, so OpenRouter would refuse every run`,
        fix: 'choose a model in agents.yaml that has one, or set OPENROUTER_ZDR=off in runner.env',
      })
    } else {
      const names = found.map(endpoint => `${endpoint.provider_name ?? '?'} (${endpoint.tag ?? '?'})${endpoint.safety_retention ? ', with safety retention' : ''}`)
      checks.push({ name: 'ZDR', status: 'ok', text: `${found.length} endpoint${found.length === 1 ? '' : 's'} of ${model} keep no data: ${names.join(', ')}` })
    }
  }
  return checks
}

// Runs every check. Returns them, in order, each `{ name, status, text, fix }`, `status` being
// `ok`, `warn` or `fail`.
//
// - `settings`: the runner's, from `loadSettings('runner')`.
// - `runner`: the runner's own checks, which `src/cli.mjs` gives it: `loadConfig`, `ConfigError`,
//   `readBuildFile`, `pinnedPiVersion`, `checkImage`, `qemuProgram`, `kvmProblem` and `bootCheck`,
//   which tests may leave out.
// - `signal`: stops the checks; the VM the boot check started is closed first.
// - `proc`, `fetch`, `docker`, `envDir`, and `root`, root's `{ uid, gid }`: for tests.
export async function runChecks({ settings, runner, proc, fetch = globalThis.fetch, docker = inDocker(), envDir, root = { uid: 0, gid: 0 }, signal = null }) {
  const paths = makePaths(settings)
  const checks = []

  let model = null
  try {
    const { agents } = runner.loadConfig({ paths })
    model = agents[0].model
    checks.push({ name: 'config', status: 'ok', text: `${paths.agentsYaml} is valid; the agent's model is ${model}` })
  } catch (error) {
    if (!(error instanceof runner.ConfigError)) throw error
    checks.push({ name: 'config', status: 'fail', text: error.problems.map(problem => problem.message).join('; '), fix: `correct ${paths.agentsYaml}` })
  }

  checks.push(accelCheck(settings.agentAccel, settings.agentAccel === 'emulation' || settings.agentAccel === 'hvf' ? null : runner.kvmProblem(), { docker }))
  checks.push(qemuCheck({ program: runner.qemuProgram() }))

  try {
    const pinned = runner.pinnedPiVersion(runner.readBuildFile(paths.imageBuild), paths.imageBuild)
    const image = runner.checkImage({ dir: paths.runnerImage, pinned, timeZone: settings.timeZone })
    checks.push({ name: 'VM image', status: 'ok', text: `built ${image.builtAt}, with pi ${pinned}, which config/image/build.json pins` })
  } catch (error) {
    checks.push({ name: 'VM image', status: 'fail', text: error.message, fix: docker ? 'docker compose run --rm build-image, with the runner stopped' : 'sudo scooter build-image' })
  }
  // A VM boots from the image, when everything it needs is there.
  if (runner.bootCheck && checks.every(check => check.status !== 'fail' || check.name === 'config')) {
    try {
      checks.push(bootCheckResult({ booted: await runner.bootCheck({ paths, settings, signal }), docker }))
    } catch (error) {
      if (signal?.aborted) return checks
      checks.push(bootCheckResult({ error, docker }))
    }
  }
  if (signal?.aborted) return checks

  const ids = { root }
  const missing = []
  for (const [part, name] of Object.entries(USERS)) {
    ids[part] = await proc.findUser(name)
    if (ids[part] === null) missing.push(name)
  }
  if (missing.length > 0) checks.push({ name: 'folders', status: 'fail', text: `there is no user ${missing.join(', ')} on this machine, so the owners of the folders can't be checked`, fix: 'sudo scooter setup, which makes them' })
  else checks.push(...folderChecks(paths, ids, { docker }))

  checks.push(envFileCheck(envDir))

  // A stop while it waits for OpenRouter, up to `DOCTOR_TIMEOUT`, ends the wait too:
  // `runDoctor`'s handlers have taken the signals' own ending away.
  const zdr = await fetchZdrEndpoints({ fetch, stop: signal })
  if (signal?.aborted) return checks
  checks.push(...openRouterChecks(zdr, { model, zdrOn: settings.zdr }))
  return checks
}

// The report, one check a line, with its fix below when it has one.
export function reportText(checks) {
  const lines = []
  for (const { name, status, text, fix } of checks) {
    lines.push(`${status.padEnd(4)}  ${name}: ${text}`)
    if (fix && status !== 'ok') lines.push(`      fix: ${fix}`)
  }
  const failed = checks.filter(check => check.status === 'fail').length
  lines.push('', failed === 0 ? 'The runner has what it needs.' : `${failed} ${failed === 1 ? 'thing' : 'things'} to fix.`)
  return `${lines.join('\n')}\n`
}

// Why `doctor` doesn't run as the user it runs as, or null: it checks what the runner's user can
// reach, the accelerator, the folders and the env files, which another user, root above all, sees
// otherwise. Where that user isn't there, as in
// development, it runs as whoever runs it.
export async function wrongUser({ proc, uid = process.getuid?.(), docker = inDocker() }) {
  const runnerUser = await proc.findUser(USERS.runner)
  if (runnerUser === null || runnerUser.uid === uid) return null
  const how = docker ? 'docker compose run --rm runner doctor' : `sudo -u ${USERS.runner} scooter doctor`
  return `doctor checks what the runner can reach, so it runs as ${USERS.runner}, not as uid ${uid}: ${how}`
}

// `scooter doctor`: prints the checks. Exits with 0 when nothing failed, 1 when something did, and 2
// when it runs as another user than the runner's. `runner` is what `src/cli.mjs` gives it.
export async function runDoctor({ settings, env = process.env, stdout = process.stdout, stderr = process.stderr, runner }) {
  const log = createLog({ component: 'doctor' })
  const proc = createProc({ log })
  const wrong = await wrongUser({ proc })
  if (wrong !== null) {
    stderr.write(`scooter doctor: ${wrong}\n`)
    return 2
  }
  const envDir = env[ENV_DIR_VARIABLE] || DEFAULT_ENV_DIR
  // Stopped, by a signal of the terminal's or a `kill`, it closes the VM its boot check started
  // before it ends: nothing else stops a VM of Gondolin's whose starter was killed.
  const stopping = new AbortController()
  let stoppedBy = null
  const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(name => {
    const handler = () => {
      stoppedBy ??= name
      stopping.abort()
    }
    process.on(name, handler)
    return [name, handler]
  })
  try {
    const checks = await runChecks({ settings, runner, proc, envDir, signal: stopping.signal })
    stdout.write(reportText(checks))
    if (stoppedBy !== null) {
      stderr.write(`scooter doctor: stopped by ${stoppedBy}, before every check was made\n`)
      return 1
    }
    return checks.some(check => check.status === 'fail') ? 1 : 0
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler)
  }
}
