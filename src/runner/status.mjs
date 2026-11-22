// The runner's `status.json`, and the notice about emulation.
// The format, and its reader for `scooter status`, are in `src/common/runnerstatus.mjs`.
//
// At startup the runner writes what `scooter status` needs to know about its settings: how its VMs
// run, whether ZDR and the agent's internet access are on, when the VM image was built, and each
// agent's model, timeout and sources. The file it replaces says how the VMs ran before, which is how the
// runner knows whether the accelerator has just changed to emulation.

import { writeFileAtomic } from '../common/files.mjs'
import { checkRunnerStatus } from '../common/runnerstatus.mjs'
import { isoSeconds } from '../common/time.mjs'

// What `status.json` says about this start. `sandbox` is the one the runner opened; `agents` the
// config's; `restarts`, what `openRestarts` returns, when the runner keeps its own waits between
// starts, which says whether this start waits before it goes on.
export function runnerStatus({ settings, agents, sandbox, now, restarts = null }) {
  const waits = restarts !== null && restarts.until !== null && restarts.until > now
  const status = {
    startedAt: isoSeconds(now),
    accel: sandbox.accel,
    zdr: settings.zdr,
    internet: settings.agentInternet,
    imageBuiltAt: sandbox.imageBuiltAt,
    agents: {},
    restart: waits ? { stops: restarts.record.stops, until: isoSeconds(restarts.until), reason: restarts.record.reason } : null,
  }
  for (const agent of agents) status.agents[agent.name] = { model: agent.model, timeoutMinutes: agent.timeoutMinutes, reads: [...agent.reads] }
  return status
}

// Writes `status.json`, atomically, mode 0600. Throws, before writing, if it isn't a status.
export function writeRunnerStatus(paths, status) {
  const problems = checkRunnerStatus(status)
  if (problems.length > 0) throw new Error(`not a runner status: ${problems.join('; ')}`)
  writeFileAtomic(paths.runnerStatus, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
}

export const EMULATION_NOTICE =
  "⚠️ My VMs run under emulation now, because KVM isn't available, so each batch takes much longer. Run `scooter doctor` on the runner to see how to enable KVM."

// The notice to send when `AGENT_ACCEL=auto` has fallen back to emulation and the runner's last
// start didn't run that way, or null. A runner that keeps restarting under emulation sends it once.
// One told to use emulation (`AGENT_ACCEL=emulation`) hasn't fallen back, and sends none.
// `previous` is the `status.json` of the last start, or null.
export function emulationNotice({ previous, status, accelSetting }) {
  if (accelSetting !== 'auto' || status.accel !== 'emulation' || previous?.accel === 'emulation') return null
  return { type: 'text', by: 'runner', text: EMULATION_NOTICE }
}
