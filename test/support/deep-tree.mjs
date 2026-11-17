// Trees deeper than a path can name, as pi can leave them (the fourth review of milestone 4).
//
// In the VM, `mkdir` stops where the host's path would pass what the system takes, 4,095 bytes on
// Linux, but moving a folder into another doesn't, and each move adds as much again. These make
// such trees the same way, with every call here within the limit.

import fs from 'node:fs'
import path from 'node:path'

// Leaves `<dir>/t1/`: two chains of `levels` folders with 200-byte names, each with `notes.csv` at
// its end, the second moved to the end of the first. With 12 levels, the deepest file's path is
// about 4,900 bytes longer than `dir`'s. With `locked`, pi has also taken the runner's access away
// from a folder half way down the second chain, past the limit once it is moved.
export function deepTree(dir, { levels = 12, locked = false } = {}) {
  const name = 'd'.repeat(200)
  const chain = top => {
    const end = path.join(top, ...Array(levels).fill(name))
    fs.mkdirSync(end, { recursive: true })
    fs.writeFileSync(path.join(end, 'notes.csv'), 'x\n')
    return end
  }
  const first = chain(path.join(dir, 't1'))
  chain(path.join(dir, 't2'))
  if (locked) fs.chmodSync(path.join(dir, 't2', ...Array(Math.ceil(levels / 2)).fill(name)), 0o000)
  fs.renameSync(path.join(dir, 't2'), path.join(first, 't2'))
}

// Leaves `<dir>/c/`, a chain of at least `depth` folders with one-letter names, and `end.txt` at
// its end. It is built 1,000 folders at a time: the chain so far is moved to the end of a new
// stretch, which then takes its place.
export function deepChain(dir, { depth }) {
  const stretch = top => {
    const end = path.join(top, ...Array(1000).fill('a'))
    fs.mkdirSync(end, { recursive: true })
    return end
  }
  fs.writeFileSync(path.join(stretch(path.join(dir, 'c')), 'end.txt'), 'x\n')
  for (let made = 1000; made < depth; made += 1001) {
    fs.renameSync(path.join(dir, 'c'), path.join(stretch(path.join(dir, 'next')), 'c'))
    fs.renameSync(path.join(dir, 'next'), path.join(dir, 'c'))
  }
}
