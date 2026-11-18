// `scooter doctor`: checks what the runner needs, and changes nothing (8.4 of DESIGN.md).
//
// Natively it runs as the runner's user, `sudo -u scooter-runner scooter doctor`; in Docker, in the
// runner's container. It reports, each with its fix when it isn't as it should be:
// - which accelerator pi's VMs can use, and, without KVM, how to enable it in this setup (8.3, 8.5);
// - QEMU;
// - the VM image, and the pi version it holds against the one the build file pins (6.12);
// - `agents.yaml`, which the runner checks at its start (6.1);
// - the owners and modes of the data folder's folders (3.2), and of the two env files;
// - whether `openrouter.ai` can be reached from here;
// - with ZDR on, which of the configured model's endpoints keep no data (6.13).
//
// It sends OpenRouter no key and nothing of the owner's: it asks for OpenRouter's public list of
// the endpoints that keep no data, which also says whether OpenRouter can be reached.
//
// What it checks of the runner, the config, the image and the accelerator, is the runner's own code,
// which `src/cli.mjs` hands it as `runner` (`RUNNER_CHECKS`): `src/ops` imports only `src/common`
// (ARCHITECTURE.md 4.2).

import fs from 'node:fs'
import path from 'node:path'
import { limits } from '../common/limits.mjs'
import { createLog } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc, findProgram } from '../common/proc.mjs'
import { DEFAULT_ENV_DIR, ENV_DIR_VARIABLE } from '../common/settings.mjs'
import { USERS, dataFolders } from './setup.mjs'

// OpenRouter's public list of the endpoints that keep no prompts or responses (13.3).
export const ZDR_ENDPOINTS_URL = 'https://openrouter.ai/api/v1/endpoints/zdr'

// Whether this process is in a Docker container, where the fixes differ (8.3).
export const inDocker = () => fs.existsSync('/.dockerenv')

const octal = mode => `0${(mode & 0o7777).toString(8)}`

// How to make KVM usable, for an error code from `kvmProblem`, natively or in Docker.
export function kvmFix(problem, { docker = false, runnerUser = USERS.runner } = {}) {
  if (problem === 'ENOENT') {
    return docker
      ? "the runner's container has no /dev/kvm: give it `devices: [\"/dev/kvm:/dev/kvm\"]` in compose.yaml, on a host that has KVM"
      : "this machine has no /dev/kvm: turn on virtualization in its firmware, or nested virtualization if it is itself a VM, and load the kvm module (modprobe kvm_intel or kvm_amd)"
  }
  return docker
    ? `the runner can't open /dev/kvm (${problem}). With rootful Docker, run the runner as ${runnerUser} with group_add set to the host's kvm group id (getent group kvm); with rootless Docker, install the README's udev rule, and run the runner without user:`
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

// The checks of the data folder's folders against `dataFolders` (3.2), for the users' ids. The
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
  return docker ? `chown ${owner.uid}:${owner.gid} ${folder} && chmod ${octal(mode)} ${folder}, as root` : 'sudo scooter setup, which sets them'
}

// The check of the env files (3.2, 8.2): the runner's own is the runner's, mode 0600, and it can't
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
// reached, within `DOCTOR_TIMEOUT`.
export async function fetchZdrEndpoints({ fetch = globalThis.fetch } = {}) {
  const signal = AbortSignal.timeout(limits.DOCTOR_TIMEOUT)
  let response
  try {
    response = await fetch(ZDR_ENDPOINTS_URL, { signal, headers: { accept: 'application/json' } })
  } catch (error) {
    return { error: signal.aborted ? `no answer within ${limits.DOCTOR_TIMEOUT / 1000} seconds` : (error.cause?.code ?? error.code ?? error.message) }
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
// - `runner`: the runner's own checks (`RUNNER_CHECKS` in `src/cli.mjs`): `loadConfig`,
//   `ConfigError`, `readBuildFile`, `pinnedPiVersion`, `checkImage`, `qemuProgram` and
//   `kvmProblem`.
// - `proc`, `fetch`, `docker`, `envDir`, and `root`, root's `{ uid, gid }`: for tests.
export async function runChecks({ settings, runner, proc, fetch = globalThis.fetch, docker = inDocker(), envDir, root = { uid: 0, gid: 0 } }) {
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
    checks.push({ name: 'VM image', status: 'fail', text: error.message, fix: docker ? 'docker compose run --rm runner build-image' : 'sudo scooter build-image' })
  }

  const ids = { root }
  const missing = []
  for (const [part, name] of Object.entries(USERS)) {
    ids[part] = await proc.findUser(name)
    if (ids[part] === null) missing.push(name)
  }
  if (missing.length > 0) checks.push({ name: 'folders', status: 'fail', text: `there is no user ${missing.join(', ')} on this machine, so the owners of the folders can't be checked`, fix: 'sudo scooter setup, which makes them' })
  else checks.push(...folderChecks(paths, ids, { docker }))

  checks.push(envFileCheck(envDir))

  const zdr = await fetchZdrEndpoints({ fetch })
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

// `scooter doctor`: prints the checks. Exits with 0 when nothing failed, and 1 when something did.
// `runner` is what `src/cli.mjs` gives it.
export async function runDoctor({ settings, env = process.env, stdout = process.stdout, runner }) {
  const log = createLog({ component: 'doctor' })
  const proc = createProc({ log })
  const envDir = env[ENV_DIR_VARIABLE] || DEFAULT_ENV_DIR
  const checks = await runChecks({ settings, runner, proc, envDir })
  stdout.write(reportText(checks))
  return checks.some(check => check.status === 'fail') ? 1 : 0
}
