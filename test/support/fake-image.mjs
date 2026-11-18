// A small VM image, as Gondolin's builder writes one, for the tests of `build-image` and of the
// runner's startup check: its `manifest.json`, stand-ins for the kernel and the initramfs, and a
// real ext4 root file system, a few megabytes, holding what Scooter reads out of one: pi's
// `package.json`, the time zones, Alpine's repositories and its record of the base packages.
//
// `mke2fs -d` fills the file system from a folder, with no root. The tests that use it skip
// themselves when e2fsprogs isn't installed. Those about where and how `build-image` builds, and
// not about what it reads out of the image, use a stand-in for the file system instead, so they run
// without e2fsprogs too, as root in the plan's root-test container among others.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { findProgram } from '../../src/common/proc.mjs'
import { debugfsProgram } from '../../src/runner/sandbox/image.mjs'

export function fakeImageSkipReason() {
  if (findProgram('mke2fs', `${process.env.PATH ?? ''}:/usr/sbin:/sbin`) === null) return 'mke2fs is not installed'
  if (debugfsProgram() === null) return 'debugfs is not installed'
  return false
}

// The base packages Alpine's minirootfs records, as `/lib/apk/db/installed` has them.
const INSTALLED = 'C:Q1a\nP:musl\nV:1.2.5-r24\n\nC:Q1b\nP:busybox\nV:1.37.0-r30\n\nC:Q1c\nP:ca-certificates-bundle\nV:20250911-r0\n\n'

export const FAKE_BUILD_TIME = '2026-11-16T00:56:54.329Z'

// Writes an image into `dir`. `pi` is the version in pi's `package.json`, or null for none; `zones`
// the files under the zoneinfo folder; `arch` and `packages` what the manifest says. With `ext4`
// false, the root file system is a stand-in, which needs no e2fsprogs, for a test that reads the
// image with `readFakeImage` instead.
export function makeFakeImage(dir, { pi = '1.5.2', zones = ['Asia/Kolkata', 'America/New_York', 'UTC'], arch = 'x86_64', packages = ['nodejs', 'git'], buildTime = FAKE_BUILD_TIME, ext4 = true } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (ext4) writeRootfs(dir, { pi, zones })
  else fs.writeFileSync(path.join(dir, 'rootfs.ext4'), JSON.stringify({ pi, zones }))
  fs.writeFileSync(path.join(dir, 'vmlinuz-virt'), 'kernel')
  fs.writeFileSync(path.join(dir, 'initramfs.cpio.lz4'), 'initramfs')
  const manifest = {
    version: 1,
    buildId: 'fake',
    config: { distro: 'alpine', alpine: { version: '3.23.8', rootfsPackages: packages }, arch },
    buildTime,
    assets: { kernel: 'vmlinuz-virt', initramfs: 'initramfs.cpio.lz4', rootfs: 'rootfs.ext4' },
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return dir
}

// What `build-image` reads out of an image made with `ext4` false, as `recordImage` reads it out
// of a real one: for the tests that build without e2fsprogs, such as the root tests.
export async function readFakeImage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const { pi, zones } = JSON.parse(fs.readFileSync(path.join(dir, 'rootfs.ext4'), 'utf8'))
  return {
    record: { builtAt: manifest.buildTime.replace(/\.\d+Z$/, 'Z'), pi, alpine: manifest.config.alpine.version, arch: manifest.config.arch, zones: [...zones].sort() },
    repositories: 'https://mirror.test/alpine/v3.23/main\nhttps://mirror.test/alpine/v3.23/community\n',
    installed: INSTALLED,
    requested: manifest.config.alpine.rootfsPackages,
  }
}

// A real ext4 root file system in `dir`, holding what Scooter reads out of one.
function writeRootfs(dir, { pi, zones }) {
  const tree = fs.mkdtempSync(path.join(path.dirname(dir), 'rootfs-'))
  try {
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
      fs.writeFileSync(path.join(tree, file), text)
    }
    if (pi !== null) write(`usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json`, `${JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: pi }, null, '\t')}\n`)
    for (const zone of zones) write(`usr/share/zoneinfo/${zone}`, 'TZif2\n')
    write('etc/apk/repositories', 'https://mirror.test/alpine/v3.23/main\nhttps://mirror.test/alpine/v3.23/community\n')
    write('lib/apk/db/installed', INSTALLED)
    execFileSync(findProgram('mke2fs', `${process.env.PATH ?? ''}:/usr/sbin:/sbin`), ['-q', '-t', 'ext4', '-F', '-d', tree, path.join(dir, 'rootfs.ext4'), '8M'], { stdio: 'ignore' })
  } finally {
    fs.rmSync(tree, { recursive: true, force: true })
  }
}

// A tar archive of `files`, a Map from name to text, without the blocks that end one: Alpine's
// APKINDEX.tar.gz is two such pieces, each gzipped, one after the other.
function tarPiece(files) {
  const blocks = []
  for (const [name, text] of files) {
    const body = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    header.write('0000644\0', 100)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('0', 156)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return Buffer.concat(blocks)
}

// An `APKINDEX.tar.gz` holding `index`, the text of an APKINDEX, after a signature, as Alpine signs one.
export function apkIndexArchive(index) {
  const signature = zlib.gzipSync(tarPiece(new Map([['.SIGN.RSA.alpine-devel.rsa.pub', 'signature']])))
  const content = zlib.gzipSync(Buffer.concat([tarPiece(new Map([['DESCRIPTION', 'v3.23'], ['APKINDEX', index]])), Buffer.alloc(1024)]))
  return Buffer.concat([signature, content])
}

// APKINDEX records, from `{ P, V, D, p }` objects.
export function apkIndexText(records) {
  return records.map(record => `${Object.entries(record).map(([key, value]) => `${key}:${value}`).join('\n')}\n`).join('\n')
}
