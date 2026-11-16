// Builds the VM image from config/image/build.json, for the tests that need SCOOTER_TEST_IMAGE.
//
//   node test/support/build-test-image.mjs <output folder>
//
// It uses Gondolin's container build, which needs Docker or Podman and no root. The build file
// says what goes into the image. The two things Gondolin also wants are settled here, at build
// time: the architecture, which is this machine's, and where the build runs.
//
// The build downloads Alpine's packages and pi, so it needs the network. It takes about 15 seconds
// and the image is about 530 MB.

import path from 'node:path'
import { buildAssets } from '@earendil-works/gondolin'
import { BUILD_FILE, readBuildFile } from './image.mjs'

const [output] = process.argv.slice(2)
if (!output) {
  console.error('usage: node test/support/build-test-image.mjs <output folder>')
  process.exit(2)
}

const config = readBuildFile()
config.arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
config.container = { force: true }

const result = await buildAssets(config, {
  outputDir: path.resolve(output),
  configDir: path.dirname(BUILD_FILE),
  verbose: true,
})
console.log(`Built ${result.manifest.buildId} in ${result.outputDir}`)
