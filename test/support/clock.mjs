// A clock for tests: time stands still until the test moves it.
//
// It has the same two functions as the real clock in `src/common/time.mjs`, `now()` and
// `sleep(ms, { signal })`, and the code under test is handed it in place of the real one.

function abortReason(signal) {
  return signal.reason ?? new Error('aborted')
}

// `start` is an instant in milliseconds, or a time such as `2026-11-09T15:43:02Z`.
export function createFakeClock(start = '2026-11-09T15:43:02Z') {
  let now = typeof start === 'string' ? Date.parse(start) : start
  let sleepers = []
  let watchers = []

  function settleWatchers() {
    const waiting = watchers
    watchers = []
    for (const watcher of waiting) {
      if (sleepers.length >= watcher.count) watcher.resolve()
      else watchers.push(watcher)
    }
  }

  // Lets whatever a resolved sleep set going run on, as far as it gets without more time passing.
  const settle = () => new Promise(resolve => setImmediate(resolve))

  return {
    now: () => now,

    sleep(ms, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortReason(signal))
        const sleeper = { due: now + ms, resolve }
        const onAbort = () => {
          sleepers = sleepers.filter(other => other !== sleeper)
          reject(abortReason(signal))
        }
        sleeper.done = () => signal?.removeEventListener('abort', onAbort)
        signal?.addEventListener('abort', onAbort, { once: true })
        sleepers.push(sleeper)
        settleWatchers()
      })
    },

    // Moves the time on by `ms`, waking each sleeper as its time comes, in order.
    async advance(ms) {
      const target = now + ms
      for (;;) {
        await settle()
        const next = sleepers.filter(sleeper => sleeper.due <= target).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        sleepers = sleepers.filter(sleeper => sleeper !== next)
        now = Math.max(now, next.due)
        next.done()
        next.resolve()
      }
      now = target
      await settle()
    },

    // Sets the time, forwards or backwards, without waking anyone.
    set(time) {
      now = typeof time === 'string' ? Date.parse(time) : time
    },

    // How many sleeps are waiting, and how long each has left.
    sleeping: () => sleepers.map(sleeper => sleeper.due - now).sort((a, b) => a - b),

    // Resolves once at least `count` sleeps are waiting. Code under test that does real work
    // between sleeps, such as starting a program, reaches its next sleep in its own time.
    whenSleeping(count = 1) {
      if (sleepers.length >= count) return Promise.resolve()
      return new Promise(resolve => watchers.push({ count, resolve }))
    },
  }
}
