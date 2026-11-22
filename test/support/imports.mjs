// The import rules between the code's layers, as a check over source text.
//
// `checkImportRules` takes the files under `src/` and returns every broken rule as a sentence.
// `test/imports.test.mjs` runs it over the real tree, and over small made-up trees to show that it
// catches what it should.
//
// The rules need to know what each file imports and which program names it holds, without being
// fooled by a comment or a string that only looks like an import. So `scanSource` reads the text
// the way a tokenizer would: it tells code, comments, strings, templates and regular expressions
// apart, and knows nothing more of JavaScript than that.

import path from 'node:path'

const WORD = /[A-Za-z0-9_$]/
// After these words a `/` starts a regular expression, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await'])

// Splits source text. Returns `{ code, strings }`: the code with every comment removed and every
// string replaced by `"<its number>"`, and the strings' own text, by number. A template counts as
// a string only when it has no `${…}` in it; the code inside `${…}` is scanned as code.
export function scanSource(text) {
  const strings = []
  let code = ''
  let i = 0

  const lastWord = () => /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(code)?.[1]
  const regexMayStart = () => {
    const before = code.trimEnd()
    if (before === '') return true
    const last = before.at(-1)
    if (WORD.test(last)) return BEFORE_REGEX.has(lastWord())
    return !')]}'.includes(last)
  }

  function quoted(quote) {
    let value = ''
    i += 1
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') {
        value += text[i + 1] ?? ''
        i += 2
      } else {
        value += text[i]
        i += 1
      }
    }
    i += 1
    strings.push(value)
    code += `"${strings.length - 1}"`
  }

  function template() {
    let value = ''
    let plain = true
    const start = code.length
    code += '`'
    i += 1
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') {
        value += text[i + 1] ?? ''
        i += 2
      } else if (text[i] === '$' && text[i + 1] === '{') {
        plain = false
        code += '${'
        i += 2
        scan(true)
        code += '}'
      } else {
        value += text[i]
        i += 1
      }
    }
    i += 1
    if (plain) {
      strings.push(value)
      code = `${code.slice(0, start)}"${strings.length - 1}"`
    } else {
      code += '`'
    }
  }

  function regex() {
    let inClass = false
    i += 1
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '\\') i += 1
      else if (text[i] === '[') inClass = true
      else if (text[i] === ']') inClass = false
      else if (text[i] === '/' && !inClass) break
      i += 1
    }
    i += 1
    while (i < text.length && /[a-z]/.test(text[i])) i += 1
    code += '/regex/'
  }

  // Scans code. Inside a template's `${…}` it stops at the brace that closes it.
  function scan(inTemplate) {
    let depth = 0
    while (i < text.length) {
      const char = text[i]
      const next = text[i + 1]
      if (char === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i += 1
      } else if (char === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end === -1 ? text.length : end + 2
        code += ' '
      } else if (char === "'" || char === '"') {
        quoted(char)
      } else if (char === '`') {
        template()
      } else if (char === '/' && regexMayStart()) {
        regex()
      } else {
        if (char === '{') depth += 1
        if (char === '}') {
          if (inTemplate && depth === 0) {
            i += 1
            return
          }
          depth -= 1
        }
        code += char
        i += 1
      }
    }
  }

  // A `#!` line is not code.
  if (text.startsWith('#!')) i = text.indexOf('\n')
  scan(false)
  return { code, strings }
}

// What a file imports: `{ imports, problems }`. Each import is `{ specifier, dynamic, names }`,
// where `names` lists what a static import takes by name.
export function importsOf(text) {
  const { code, strings } = scanSource(text)
  const imports = []
  const problems = []
  const clean = code.replace(/\s+/g, ' ')

  // import x from "0" · import { a, b as c } from "0" · import * as x from "0" · export … from "0"
  for (const match of clean.matchAll(/\b(?:import|export)\b([^;"`()]*?)\bfrom ?"(\d+)"/g)) {
    const braces = /\{([^}]*)\}/.exec(match[1])
    const names = braces
      ? braces[1]
          .split(',')
          .map(name => name.trim().split(' as ')[0].trim())
          .filter(Boolean)
      : []
    imports.push({ specifier: strings[Number(match[2])], dynamic: false, names })
  }
  // import "0"
  for (const match of clean.matchAll(/\bimport ?"(\d+)"/g)) {
    imports.push({ specifier: strings[Number(match[1])], dynamic: false, names: [] })
  }
  // import("0"), and import(anything else), which the rules can't follow
  for (const match of clean.matchAll(/\bimport ?\( ?("(\d+)" ?\))?/g)) {
    if (match[2] === undefined) problems.push('a dynamic import whose target is not a plain string')
    else imports.push({ specifier: strings[Number(match[2])], dynamic: true, names: [] })
  }
  if (/\brequire ?\(/.test(clean)) problems.push('require(), where the code is ES modules')
  return { imports, problems, strings, code: clean }
}

// The folder of `src/` a file belongs to.
function areaOf(file) {
  if (file === 'src/cli.mjs') return 'cli'
  return /^src\/([^/]+)\//.exec(file)?.[1] ?? 'other'
}

function packageOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const STORE = 'src/bridge/store.mjs'
const WHATSAPP = 'src/bridge/channels/whatsapp.mjs'
const EMAIL = 'src/bridge/channels/email.mjs'
const BACKUP = 'src/bridge/backup.mjs'
const BRIDGE_MAIN = 'src/bridge/main.mjs'
const PROC = 'src/common/proc.mjs'
const PATHS = 'src/common/paths.mjs'
const SETTINGS = 'src/common/settings.mjs'
const RUNNER_CONFIG = 'src/runner/config.mjs'

// What `src/mail` may import from `src/common` (rule 3).
const MAIL_COMMON = ['src/common/files.mjs', 'src/common/limits.mjs', 'src/common/log.mjs']

// Which folders of `src/` each folder may import from, itself included.
const MAY_IMPORT = {
  common: ['common'],
  bridge: ['bridge', 'common'],
  runner: ['runner', 'common'],
  mail: ['mail', 'common'],
  ops: ['ops', 'common'],
}

// The third-party libraries, and where each may be imported.
const LIBRARIES = {
  yaml: file => file === RUNNER_CONFIG,
  '@earendil-works/gondolin': file => file.startsWith('src/runner/sandbox/'),
  imapflow: file => areaOf(file) === 'mail',
  'postal-mime': file => areaOf(file) === 'mail',
}

// What under `src/` isn't code: the documents, the runner's skill among them, and the data in the
// folder of ICU's zone rules that ship with the runner for the VM (`src/runner/vm/icu-tz/`).
const NOT_CODE = file => file.endsWith('.md') || file.startsWith('src/runner/vm/icu-tz/')

// Calls that change files. The code in `src/common/datastore/` only reads.
const WRITES = /\b(?:appendFile|writeFile|write|writev|truncate|ftruncate|rename|unlink|rm|rmdir|mkdir|copyFile|cp|createWriteStream|chmod|fchmod|chown|fchown|link|symlink)(?:Sync)? ?\(/

// Checks the files of `src/`. `files` is a Map from each file's path, as `src/…` with forward
// slashes, to its text. Returns the broken rules, each as a sentence that names the file.
export function checkImportRules(files) {
  const violations = []
  const graph = new Map()

  for (const [file, text] of files) {
    if (NOT_CODE(file)) continue
    if (!file.endsWith('.mjs')) {
      violations.push(`${file}: code under src/ is ES modules in .mjs files`)
      continue
    }
    const area = areaOf(file)
    const { imports, problems, strings, code } = importsOf(text)
    for (const problem of problems) violations.push(`${file}: ${problem}`)
    const targets = []
    graph.set(file, targets)

    for (const { specifier, dynamic, names } of imports) {
      if (specifier.startsWith('node:')) {
        if (specifier === 'node:child_process' && file !== PROC) {
          violations.push(`${file}: only ${PROC} imports node:child_process; programs are run through it`)
        }
        continue
      }

      if (!specifier.startsWith('.')) {
        const library = packageOf(specifier)
        if (!Object.hasOwn(LIBRARIES, library)) {
          violations.push(`${file}: imports ${specifier}, which is neither a node: module nor one of the four libraries`)
        } else if (!LIBRARIES[library](file)) {
          violations.push(`${file}: ${library} may not be imported here`)
        }
        continue
      }

      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      if (!files.has(target)) {
        violations.push(`${file}: imports ${specifier}, which isn't a file under src/`)
        continue
      }
      targets.push(target)
      const targetArea = areaOf(target)

      if (area === 'cli') {
        // The entry point loads one side per command, and each only when its command runs.
        if (!dynamic && targetArea !== 'common') {
          violations.push(`${file}: imports ${target} at the top; a command's code is imported only when the command runs`)
        }
      } else if (!MAY_IMPORT[area]) {
        violations.push(`${file}: isn't in a folder the import rules know`)
      } else if (!MAY_IMPORT[area].includes(targetArea)) {
        violations.push(`${file}: src/${area} may not import ${target}`)
      } else if (area === 'mail' && targetArea === 'common' && !MAIL_COMMON.includes(target)) {
        violations.push(`${file}: src/mail imports only files, limits and logging from src/common, not ${target}`)
      }

      if (names.includes('encodeLine') && file !== STORE) {
        violations.push(`${file}: only ${STORE} writes datastore lines, so only it imports encodeLine`)
      }
      // `main.mjs` makes the one `proc` the bridge shares, and looks up its users with it.
      if (target === PROC && area === 'bridge' && ![WHATSAPP, EMAIL, BACKUP, BRIDGE_MAIN].includes(file)) {
        violations.push(`${file}: in the bridge, only the two channels and the backup module run programs`)
      }
    }

    // One place for each outside contact: a program is run by the one module that names it.
    for (const string of strings) {
      if (string === 'wacli' && file !== WHATSAPP && file !== PATHS) {
        violations.push(`${file}: names the program wacli; only ${WHATSAPP} runs it`)
      }
      if (string === 'restic' && file !== BACKUP) {
        violations.push(`${file}: names the program restic; only ${BACKUP} runs it`)
      }
      if (/(^|\/)mail\/reader\.mjs$/.test(string) && file !== EMAIL) {
        violations.push(`${file}: names the email reader's program; only ${EMAIL} runs it`)
      }
    }

    if (file.startsWith('src/common/datastore/') && WRITES.test(code)) {
      violations.push(`${file}: the shared datastore code only reads; ${STORE} is the only writer`)
    }
  }

  // The email reader must not load the bridge's settings, however indirectly.
  for (const file of files.keys()) {
    if (areaOf(file) !== 'mail') continue
    const seen = new Set()
    const queue = [file]
    while (queue.length > 0) {
      const current = queue.pop()
      if (seen.has(current)) continue
      seen.add(current)
      queue.push(...(graph.get(current) ?? []))
    }
    if (seen.has(SETTINGS)) violations.push(`${file}: loads ${SETTINGS}, directly or through another module`)
  }

  return violations
}
