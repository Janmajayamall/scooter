// The import rules of section 4.2 of ARCHITECTURE.md, checked over everything under `src/`.
//
// The first test is the check itself. The others give the checker small made-up trees, to show
// that each rule is one it would catch.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkImportRules, importsOf, scanSource } from './support/imports.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Every file under `src/`, as a Map from `src/…` to its text.
function sourceTree() {
  const files = new Map()
  for (const entry of fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    files.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))
  }
  return files
}

// A made-up tree: the files given, plus an empty file for each path they import or the rules name.
function tree(files) {
  const all = new Map([
    ['src/common/files.mjs', ''],
    ['src/common/limits.mjs', ''],
    ['src/common/log.mjs', ''],
    ['src/common/proc.mjs', "import { spawn } from 'node:child_process'"],
    ['src/common/settings.mjs', ''],
    ['src/common/datastore/line.mjs', 'export function encodeLine() {}'],
  ])
  for (const [file, text] of Object.entries(files)) all.set(file, text)
  return all
}

const violations = files => checkImportRules(tree(files))

test('imports: the code under src/ keeps the import rules', () => {
  const files = sourceTree()
  assert.ok(files.has('src/cli.mjs') && files.has('src/bridge/store.mjs') && files.has('src/common/limits.mjs'))
  assert.deepEqual(checkImportRules(files), [])
})

test('imports: what a file imports is read from its code, not its comments or strings', () => {
  const { imports, problems } = importsOf(`#!/usr/bin/env node
    // import fake from './comment.mjs'
    /* import other from './block-comment.mjs' */
    import fs from 'node:fs'
    import { a, b as c } from "./named.mjs"
    import * as all from './star.mjs'
    import def, { d } from './both.mjs'
    import './side-effect.mjs'
    export { e } from './re-export.mjs'
    export * from './re-export-all.mjs'
    const text = "import x from './in-a-string.mjs'"
    const template = \`import y from './in-a-template.mjs' \${await import('./inside-template.mjs')}\`
    const pattern = /import z from '.\\/in-a-regex.mjs'/
    const quote = /'/.test(text) ? 1 / 2 : 3
    const lazy = await import('./dynamic.mjs')
    const from = 'not an import'
  `)
  assert.deepEqual(problems, [])
  assert.deepEqual(
    imports.map(entry => [entry.specifier, entry.dynamic]).sort(),
    [
      ['./both.mjs', false],
      ['./dynamic.mjs', true],
      ['./inside-template.mjs', true],
      ['./named.mjs', false],
      ['./re-export-all.mjs', false],
      ['./re-export.mjs', false],
      ['./side-effect.mjs', false],
      ['./star.mjs', false],
      ['node:fs', false],
    ].sort(),
  )
  assert.deepEqual(imports.find(entry => entry.specifier === './named.mjs').names, ['a', 'b'])
  assert.deepEqual(imports.find(entry => entry.specifier === './both.mjs').names, ['d'])

  assert.deepEqual(importsOf('const name = "x"; await import(name)').problems, ['a dynamic import whose target is not a plain string'])
  assert.deepEqual(importsOf('await import(`./${name}.mjs`)').problems, ['a dynamic import whose target is not a plain string'])
  assert.deepEqual(importsOf("const fs = require('fs')").problems, ['require(), where the code is ES modules'])
  // Strings are told apart from code that holds a quote character.
  assert.deepEqual(scanSource("const a = 'wacli' // 'restic'\nconst b = /['\"]/g, c = `restic`").strings, ['wacli', 'restic'])
})

test('imports: src/common imports nothing from the other folders, and no library', () => {
  assert.deepEqual(violations({ 'src/common/a.mjs': "import './log.mjs'\nimport './datastore/line.mjs'\nimport fs from 'node:fs'" }), [])
  assert.match(violations({ 'src/common/a.mjs': "import '../bridge/store.mjs'", 'src/bridge/store.mjs': '' })[0], /src\/common may not import src\/bridge\/store.mjs/)
  assert.match(violations({ 'src/common/a.mjs': "import '../runner/run.mjs'", 'src/runner/run.mjs': '' })[0], /src\/common may not import/)
  assert.match(violations({ 'src/common/a.mjs': "import '../cli.mjs'", 'src/cli.mjs': '' })[0], /src\/common may not import src\/cli.mjs/)
  assert.match(violations({ 'src/common/a.mjs': "import { parse } from 'yaml'" })[0], /yaml may not be imported here/)
  assert.match(violations({ 'src/common/a.mjs': "await import('../bridge/store.mjs')", 'src/bridge/store.mjs': '' })[0], /may not import/)
})

test('imports: the bridge and the runner never import each other', () => {
  const both = { 'src/bridge/outbox.mjs': '', 'src/runner/run.mjs': '' }
  assert.deepEqual(violations({ ...both, 'src/bridge/main.mjs': "import './outbox.mjs'\nimport '../common/log.mjs'" }), [])
  assert.match(violations({ ...both, 'src/bridge/main.mjs': "import '../runner/run.mjs'" })[0], /src\/bridge may not import src\/runner\/run.mjs/)
  assert.match(violations({ ...both, 'src/runner/main.mjs': "import { x } from '../bridge/outbox.mjs'" })[0], /src\/runner may not import src\/bridge\/outbox.mjs/)
  assert.match(violations({ ...both, 'src/runner/main.mjs': "export * from '../bridge/outbox.mjs'" })[0], /src\/runner may not import/)
  assert.match(violations({ ...both, 'src/ops/doctor.mjs': "import '../runner/run.mjs'" })[0], /src\/ops may not import/)
})

test('imports: src/mail takes only files, limits and logging from src/common', () => {
  assert.deepEqual(
    violations({ 'src/mail/reader.mjs': "import '../common/files.mjs'\nimport '../common/limits.mjs'\nimport '../common/log.mjs'\nimport './imap.mjs'", 'src/mail/imap.mjs': "import { ImapFlow } from 'imapflow'\nimport PostalMime from 'postal-mime'" }),
    [],
  )
  assert.match(violations({ 'src/mail/reader.mjs': "import '../common/settings.mjs'" }).join('\n'), /imports only files, limits and logging from src\/common, not src\/common\/settings.mjs/)
  assert.match(violations({ 'src/mail/reader.mjs': "import '../common/proc.mjs'" })[0], /imports only files, limits and logging/)
  assert.match(violations({ 'src/mail/reader.mjs': "import '../bridge/channels/email.mjs'", 'src/bridge/channels/email.mjs': '' })[0], /src\/mail may not import/)
  // Not through another module either.
  const indirect = violations({ 'src/mail/reader.mjs': "import '../common/log.mjs'", 'src/common/log.mjs': "import './settings.mjs'" })
  assert.deepEqual(indirect, ['src/mail/reader.mjs: loads src/common/settings.mjs, directly or through another module'])
})

test('imports: each library is imported in one place', () => {
  assert.deepEqual(
    violations({
      'src/runner/config.mjs': "import { parse } from 'yaml'",
      'src/runner/sandbox/gondolin.mjs': "import { VM } from '@earendil-works/gondolin'",
      'src/runner/sandbox/policy.mjs': "const { createHttpHooks } = await import('@earendil-works/gondolin')",
    }),
    [],
  )
  assert.match(violations({ 'src/runner/agentdir.mjs': "import { parse } from 'yaml'" })[0], /yaml may not be imported here/)
  assert.match(violations({ 'src/runner/run.mjs': "import { VM } from '@earendil-works/gondolin'" })[0], /@earendil-works\/gondolin may not be imported here/)
  assert.match(violations({ 'src/bridge/channels/email.mjs': "import PostalMime from 'postal-mime'" })[0], /postal-mime may not be imported here/)
  assert.match(violations({ 'src/bridge/channels/email.mjs': "import { ImapFlow } from 'imapflow'" })[0], /imapflow may not be imported here/)
  assert.match(violations({ 'src/bridge/main.mjs': "import yaml from 'yaml'" })[0], /yaml may not be imported here/)
  assert.match(violations({ 'src/ops/setup.mjs': "import { VM } from '@earendil-works/gondolin/internal'" })[0], /gondolin may not be imported here/)
  // Nothing beyond the four, and Node's own modules by their `node:` names.
  assert.match(violations({ 'src/bridge/main.mjs': "import express from 'express'" })[0], /neither a node: module nor one of the four libraries/)
  assert.match(violations({ 'src/bridge/main.mjs': "import fs from 'fs'" })[0], /neither a node: module/)
})

test('imports: one place for each outside contact', () => {
  const channels = { 'src/bridge/channels/whatsapp.mjs': '', 'src/bridge/channels/email.mjs': '', 'src/bridge/backup.mjs': '' }
  assert.deepEqual(
    violations({
      'src/bridge/store.mjs': "import { encodeLine } from '../common/datastore/line.mjs'",
      'src/bridge/channels/whatsapp.mjs': "import { createProc } from '../../common/proc.mjs'\nconst program = 'wacli'",
      'src/bridge/channels/email.mjs': "import { createProc } from '../../common/proc.mjs'\nconst program = '../../mail/reader.mjs'",
      'src/bridge/backup.mjs': "import { createProc } from '../common/proc.mjs'\nconst program = 'restic'",
      'src/common/paths.mjs': "const folder = 'wacli'",
    }),
    [],
  )
  // Only the store writes datastore lines.
  assert.match(violations({ 'src/bridge/intake.mjs': "import { encodeLine } from '../common/datastore/line.mjs'" })[0], /only src\/bridge\/store.mjs writes datastore lines/)
  assert.match(violations({ 'src/runner/run.mjs': "import { decodeLine, encodeLine as enc } from '../common/datastore/line.mjs'" })[0], /only src\/bridge\/store.mjs writes datastore lines/)
  assert.match(violations({ 'src/common/datastore/reader.mjs': "import fs from 'node:fs'\nfs.appendFileSync(file, line)" })[0], /the shared datastore code only reads/)
  assert.match(violations({ 'src/common/datastore/reader.mjs': 'fs.truncateSync(file, 0)' })[0], /only reads/)
  assert.deepEqual(violations({ 'src/common/datastore/reader.mjs': "fs.readSync(fd, buffer)\nfs.openSync(file, 'r')\n// fs.writeSync(fd)" }), [])
  // Only the WhatsApp module runs wacli, only the email module the reader, only the backup module restic.
  assert.match(violations({ ...channels, 'src/bridge/outbox.mjs': "run('wacli', ['send', 'text'])" })[0], /names the program wacli; only src\/bridge\/channels\/whatsapp.mjs runs it/)
  assert.match(violations({ ...channels, 'src/ops/doctor.mjs': 'const tools = ["restic", "qemu-img"]' })[0], /names the program restic; only src\/bridge\/backup.mjs runs it/)
  assert.match(violations({ ...channels, 'src/bridge/main.mjs': "const reader = new URL('../mail/reader.mjs', import.meta.url)" })[0], /names the email reader's program/)
  assert.match(violations({ ...channels, 'src/bridge/commands.mjs': "import { createProc } from '../common/proc.mjs'" })[0], /only the two channels and the backup module run programs/)
  // Every program is run through proc.mjs, which never uses a shell.
  assert.match(violations({ 'src/runner/git.mjs': "import { execFile } from 'node:child_process'" })[0], /only src\/common\/proc.mjs imports node:child_process/)
  // A comment may say what it likes.
  assert.deepEqual(violations({ ...channels, 'src/bridge/outbox.mjs': "// 'wacli' sends it, through whatsapp.mjs; 'restic' backs it up" }), [])
})

test('imports: the entry point loads a command\'s code only when the command runs', () => {
  const sides = { 'src/bridge/main.mjs': '', 'src/runner/main.mjs': '' }
  assert.deepEqual(
    violations({ ...sides, 'src/cli.mjs': "import { loadSettings } from './common/settings.mjs'\nconst load = () => import('./bridge/main.mjs')\nconst other = () => import('./runner/main.mjs')" }),
    [],
  )
  assert.match(violations({ ...sides, 'src/cli.mjs': "import { runBridge } from './bridge/main.mjs'" })[0], /a command's code is imported only when the command runs/)
  assert.match(violations({ ...sides, 'src/cli.mjs': 'const load = name => import(`./${name}/main.mjs`)' })[0], /a dynamic import whose target is not a plain string/)
})

test('imports: the rest of what the checker refuses', () => {
  assert.match(violations({ 'src/bridge/main.mjs': "import './missing.mjs'" })[0], /imports .\/missing.mjs, which isn't a file under src\//)
  assert.match(violations({ 'src/bridge/main.mjs': "import '../../test/support/tmp.mjs'" })[0], /which isn't a file under src\//)
  assert.match(violations({ 'src/bridge/helper.js': '' })[0], /code under src\/ is ES modules in .mjs files/)
  assert.match(violations({ 'src/bridge/helper.cjs': '' })[0], /ES modules in .mjs files/)
  assert.match(violations({ 'src/extra/thing.mjs': "import '../common/log.mjs'" })[0], /isn't in a folder the import rules know/)
  assert.deepEqual(violations({ 'src/runner/protocol.md': "import nothing from 'anywhere'" }), [])
})
