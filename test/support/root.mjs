// Which of the tests that need root can run here (section 10 of DESIGN.md).
//
// Some behavior needs root: giving files to another owner, and running a program as another user.
// Those tests run when the suite runs as root, and skip themselves otherwise. Tests that go
// further and create users run only with `SCOOTER_ROOT_TESTS=1`, which the throwaway container of
// the plan sets, so running the suite as root on a real machine creates none.

export const isRoot = process.getuid?.() === 0
export const mayCreateUsers = isRoot && process.env.SCOOTER_ROOT_TESTS === '1'

export const skipUnlessRoot = isRoot ? false : 'needs root'
export const skipUnlessUsers = mayCreateUsers ? false : 'needs root and SCOOTER_ROOT_TESTS=1'
// For tests of files their owner can't read: root reads every file.
export const skipIfRoot = isRoot ? 'root reads every file' : false
