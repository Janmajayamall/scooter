// The VM image's build file, as the tests read it.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const BUILD_FILE = fileURLToPath(new URL('../../config/image/build.json', import.meta.url))

export function readBuildFile() {
  return JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'))
}

// pi's version. The build file pins it in the command that installs pi.
export function pinnedPiVersion() {
  const install = readBuildFile().postBuild.commands.join('\n')
  return install.match(/@earendil-works\/pi-coding-agent@(\d+\.\d+\.\d+)/)[1]
}
