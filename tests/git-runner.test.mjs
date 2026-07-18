// Tests for the Git Workbench GitRunner + service diff path (Task 1+2+3).
//
// Hard requirements under test:
//   (A) CLOSED GitRunner surface: there is NO public runGit/spawnGit/GitArgs.
//       reset --hard / push --force / merge / rebase are UNREACHABLE — proven
//       by asserting the absence of any method that accepts arbitrary argv,
//       and by asserting the public method set is exactly the allowlist.
//       Task 3 ADDS commit/fetch/pullFfOnly/push/pushUpstream to the allowlist
//       (fixed argv, no caller-supplied subcommand/flag); force-push remains
//       structurally impossible (no method accepts --force/-f).
//   (B) Diff IPC returns COMPLETE original/modified texts (no unified patch,
//       no renderer reconstruction) for staged / unstaged / untracked, plus
//       binary / too_large / submodule / empty kinds.
//   (C) porcelain v2 -z parser: rename NUL frame, untracked, unmerged, groupFiles.
//   (D) CappedBuffer tail/head modes (tail keeps end, head keeps start).
//   (E) AbortSignal cancellation.
//   (F) validatePaths rejects NUL / absolute / '..' / out-of-snapshot.
//   (G) Task 3 commit/fetch/pull --ff-only/push: gates (identity / staged /
//       operation / upstream / detached), success paths, error mapping
//       (IDENTITY_MISSING / NO_STAGED_CHANGES / EMPTY_COMMIT / HOOK_FAILED /
//       NO_UPSTREAM / REMOTE_DIVERGED / REPOSITORY_UNSAFE), and the
//       no-autocommit/autopush / no-force-push invariants.
//
// GitRunner has ZERO electron imports. git-repository-service.js imports
// `electron` (app.getPath), so we register the test stub loader for it.
//
// Run:  npm run build:electron && node --test tests/git-runner.test.mjs

import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

// Redirect bare `electron` to the test stub so git-repository-service.js loads.
register('./fixtures/electron-loader.mjs', import.meta.url)

const {
  GitRunner,
  GitRunnerError,
  parsePorcelainV2,
  groupFiles,
  GIT_OUTPUT_CAP_BYTES,
} = await import('../dist-electron/git-runner.js')
const gitServiceMod = await import('../dist-electron/git-repository-service.js')
const { GitRepositoryService, validatePaths } = gitServiceMod

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function gitAvailable() {
  try { execSync('git --version', { stdio: 'ignore' }); return true } catch { return false }
}
const GIT = gitAvailable()

function makeRepo(seed) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'raintool-git-runner-'))
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString()}`)
    return r
  }
  g(['init', '-q'])
  g(['config', 'user.name', 'Test'])
  g(['config', 'user.email', 'test@example.com'])
  g(['config', 'commit.gpgsign', 'false'])
  if (seed) seed(root, g)
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// ===========================================================================
// (A) CLOSED GitRunner surface — no public runGit, no denylist, no GitArgs
// ===========================================================================

test('GitRunner: no public runGit / spawnGit / GitArgs — arbitrary argv unreachable', () => {
  const runner = new GitRunner()
  // The old design exposed runner.runGit(root, args) and a GitArgs namespace.
  // Both are gone: there is no method that accepts an arbitrary argv, so
  // reset --hard / push --force / fetch / commit can never be constructed.
  assert.equal(typeof runner.runGit, 'undefined', 'runGit must NOT exist')
  assert.equal(typeof runner.spawnGit, 'undefined', 'spawnGit must NOT exist')
  // GitArgs is not exported at all.
  assert.equal(gitServiceMod.GitArgs, undefined, 'GitArgs must NOT be exported')
})

test('GitRunner: public method set is exactly the closed allowlist', () => {
  const runner = new GitRunner()
  const allowed = new Set([
    'revParseTopLevel', 'revParseHead', 'statusPorcelainV2', 'configGet',
    'add', 'restoreStaged', 'showBlob', 'catFileSize',
    // Task 3 named operations — fixed argv, no caller-supplied subcommand/flag.
    'commit', 'fetch', 'pullFfOnly', 'push', 'pushUpstream',
    // Supervisor corrections: discard-worktree + remote listing. restoreWorktree
    // is `git restore --worktree -- <paths>` (tracked unstaged only; service
    // pre-validates). remoteList is read-only `git remote` (for first-push
    // remote validation). Neither accepts an arbitrary subcommand/flag.
    'restoreWorktree', 'remoteList',
    // Branch switching is closed to an existing local branch validated by the
    // service; no branch create/delete/reset operation is exposed.
    'localBranchList', 'switchBranch',
    // Task 4: staged-diff context for the AI commit-message proposer.
    // diffCachedStat is read-only `git diff --cached --stat`; diffCachedPatch
    // is `git diff --cached --unified=3 --no-ext-diff -- <path>` (one path,
    // fixed flags, head-capped at COMMIT_CONTEXT_CAP_BYTES). No arbitrary argv.
    'diffCachedStat', 'diffCachedPatch',
  ])
  const ownMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(runner))
    .filter((n) => n !== 'constructor' && typeof runner[n] === 'function')
  for (const m of ownMethods) {
    assert.ok(allowed.has(m), `unexpected public method ${m} on GitRunner`)
  }
  // None of the dangerous subcommands have a builder/method. commit/fetch/pull/push
  // ARE now allowed (Task 3), but force-push / reset --hard / merge / rebase /
  // clean / branch -D / stash / checkout remain structurally unreachable.
  const forbidden = ['reset', 'merge', 'rebase', 'clean', 'branch', 'checkout', 'stash']
  for (const f of forbidden) {
    assert.equal(typeof runner[f], 'undefined', `GitRunner must NOT expose a ${f}() method`)
    assert.ok(!ownMethods.includes(f), `GitRunner prototype must NOT have ${f}`)
  }
})

test('GitRunner: reset --hard cannot be executed — no reachable path', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.txt'), 'committed\n')
    g(['add', 'f.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'f.txt'), 'uncommitted\n')
  })
  try {
    const runner = new GitRunner()
    // There is literally no API to ask for reset --hard. The only write
    // operations are add() and restoreStaged(). Attempting to reach reset via
    // the service also fails — the service has no reset method.
    const svc = new GitRepositoryService(runner)
    assert.equal(typeof runner.reset, 'undefined')
    assert.equal(typeof svc.reset, 'undefined')
    assert.equal(typeof svc.discard, 'undefined')
    // Worktree must be untouched (we never ran anything destructive).
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(path.join(root, 'f.txt'), 'utf8'), 'uncommitted\n')
  } finally {
    cleanup()
  }
})

test('branch switch: lists local branches and switches an existing branch', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((repo, g) => {
    writeFileSync(path.join(repo, 'f.txt'), 'base\n')
    g(['add', 'f.txt'])
    g(['commit', '-qm', 'base'])
    g(['branch', 'feature'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const listed = await svc.listBranches(handle.repositoryId)
    assert.ok(listed.branches.includes('feature'))
    const status = await svc.switchBranch({ repositoryId: handle.repositoryId, branch: 'feature' })
    assert.equal(status.repository.branch, 'feature')
  } finally {
    cleanup()
  }
})

test('branch switch: refuses when checkout would overwrite local changes', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((repo, g) => {
    writeFileSync(path.join(repo, 'f.txt'), 'main\n')
    g(['add', 'f.txt'])
    g(['commit', '-qm', 'main'])
    g(['checkout', '-qb', 'feature'])
    writeFileSync(path.join(repo, 'f.txt'), 'feature\n')
    g(['commit', '-qam', 'feature'])
    g(['checkout', '-q', '-'])
    writeFileSync(path.join(repo, 'f.txt'), 'local\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      () => svc.switchBranch({ repositoryId: handle.repositoryId, branch: 'feature' }),
      (error) => error?.code === 'WORKTREE_DIRTY',
    )
    assert.equal(readFileSync(path.join(root, 'f.txt'), 'utf8'), 'local\n')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (B) Diff IPC returns full original/modified texts
// ===========================================================================

test('getDiff staged: original=HEAD text, modified=index text', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.txt'), 'line1\nline2\n')
    g(['add', 'f.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'f.txt'), 'line1\nline2\nline3\n')
    g(['add', 'f.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'f.txt', source: 'staged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, 'line1\nline2\n', 'original = HEAD version')
    assert.equal(diff.modified, 'line1\nline2\nline3\n', 'modified = staged/index version')
    assert.equal(diff.language, undefined) // .txt has no language mapping
    // No unified patch leaks through — the result carries texts, not a patch.
    assert.equal(diff.patch, undefined, 'diff must NOT carry a unified patch')
  } finally {
    cleanup()
  }
})

test('getDiff unstaged: original=index text, modified=worktree text', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.ts'), 'export const a = 1\n')
    g(['add', 'f.ts'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'f.ts'), 'export const a = 1\nexport const b = 2\n')
    // NOT staged — pure worktree change.
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'f.ts', source: 'unstaged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, 'export const a = 1\n')
    assert.equal(diff.modified, 'export const a = 1\nexport const b = 2\n')
    assert.equal(diff.language, 'typescript')
  } finally {
    cleanup()
  }
})

test('getDiff untracked: original=empty, modified=worktree text', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    g(['commit', '-q', '--allow-empty', '-m', 'init'])
    writeFileSync(path.join(root, 'new.js'), 'console.log("hi")\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'new.js', source: 'untracked' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, '', 'untracked has no prior version')
    assert.equal(diff.modified, 'console.log("hi")\n')
    assert.equal(diff.language, 'javascript')
  } finally {
    cleanup()
  }
})

test('getDiff staged-new-file: original=empty (no HEAD blob), modified=index', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    g(['commit', '-q', '--allow-empty', '-m', 'init'])
    writeFileSync(path.join(root, 'brand-new.txt'), 'fresh\n')
    g(['add', 'brand-new.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'brand-new.txt', source: 'staged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, '', 'new file has no HEAD blob')
    assert.equal(diff.modified, 'fresh\n')
  } finally {
    cleanup()
  }
})

test('getDiff staged-delete: original=HEAD text, modified=empty', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'doomed.txt'), 'bye\n')
    g(['add', 'doomed.txt'])
    g(['commit', '-q', '-m', 'init'])
    g(['rm', '-q', 'doomed.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'doomed.txt', source: 'staged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, 'bye\n', 'HEAD still has the file')
    assert.equal(diff.modified, '', 'staged deletion → empty index blob')
  } finally {
    cleanup()
  }
})

test('getDiff binary: kind=binary, no text returned', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    // A PNG header is binary (contains NUL bytes).
    writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]))
    g(['add', 'img.png'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]))
    g(['add', 'img.png'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'img.png', source: 'staged' })
    assert.equal(diff.kind, 'binary')
    assert.equal(diff.original, undefined)
    assert.equal(diff.modified, undefined)
  } finally {
    cleanup()
  }
})

test('getDiff empty: original===modified → kind=empty (untracked empty file)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    g(['commit', '-q', '--allow-empty', '-m', 'init'])
    // An empty untracked file: original='' and modified='' → equal → empty.
    writeFileSync(path.join(root, 'empty.txt'), '')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'empty.txt', source: 'untracked' })
    assert.equal(diff.kind, 'empty')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (C) porcelain v2 -z parser
// ===========================================================================

test('parsePorcelainV2: rename entry consumes the NEXT NUL frame as origPath', () => {
  const frames = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +0 -0',
    '2 RM N... 100644 100644 100644 sha1 sha2 R100 new/path.txt',
    'old/path.txt',
  ]
  const buf = Buffer.from(frames.join('\0') + '\0', 'utf8')
  const parsed = parsePorcelainV2(buf)
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.files.length, 1)
  assert.equal(parsed.files[0].path, 'new/path.txt')
  assert.equal(parsed.files[0].originalPath, 'old/path.txt')
  assert.equal(parsed.files[0].indexStatus, 'R')
  assert.equal(parsed.files[0].worktreeStatus, 'M')
})

test('parsePorcelainV2: untracked "?" entries marked with indexStatus="?"', () => {
  const frames = ['# branch.head main', '? untracked.txt', '? docs/new file.md']
  const parsed = parsePorcelainV2(Buffer.from(frames.join('\0') + '\0', 'utf8'))
  assert.equal(parsed.files.length, 2)
  assert.equal(parsed.files[0].indexStatus, '?')
  assert.equal(parsed.files[1].path, 'docs/new file.md')
})

test('parsePorcelainV2: detached HEAD + ahead/behind + unmerged', () => {
  // Real conflicted `u ` line has 11 space-separated fields (path at index 10);
  // git omits the worktree mode/sha when worktree matches stage 3.
  const frames = [
    '# branch.oid abcdef',
    '# branch.head (detached)',
    '# branch.ab +3 -1',
    'u UU N... 100644 100644 100644 100644 sha1 sha2 sha3 conflict.txt',
  ]
  const parsed = parsePorcelainV2(Buffer.from(frames.join('\0') + '\0', 'utf8'))
  assert.equal(parsed.branch, null)
  assert.equal(parsed.isDetached, true)
  assert.equal(parsed.ahead, 3)
  assert.equal(parsed.behind, 1)
  assert.equal(parsed.files.length, 1)
  assert.equal(parsed.files[0].path, 'conflict.txt')
  assert.equal(parsed.files[0].indexStatus, 'U')
})

test('groupFiles: untracked separated; a file can be both staged and unstaged', () => {
  const files = [
    { path: 'a.txt', indexStatus: 'M', worktreeStatus: 'M' },
    { path: 'b.txt', indexStatus: 'A', worktreeStatus: '' },
    { path: 'c.txt', indexStatus: '', worktreeStatus: 'M' },
    { path: 'd.txt', indexStatus: '?', worktreeStatus: '' },
  ]
  const g = groupFiles(files)
  assert.equal(g.staged.length, 2)
  assert.equal(g.unstaged.length, 2)
  assert.equal(g.untracked.length, 1)
  assert.equal(g.untracked[0].indexStatus, '')
})

test('GitRunner.statusPorcelainV2 + parsePorcelainV2 against real git (rename)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'old.txt'), 'x\n')
    g(['add', 'old.txt'])
    g(['commit', '-q', '-m', 'init'])
    g(['mv', 'old.txt', 'new.txt'])
  })
  try {
    const runner = new GitRunner()
    const raw = await runner.statusPorcelainV2(root)
    const parsed = parsePorcelainV2(raw)
    const staged = groupFiles(parsed.files).staged
    assert.equal(staged.length, 1)
    assert.equal(staged[0].path, 'new.txt')
    assert.equal(staged[0].originalPath, 'old.txt')
    assert.equal(staged[0].indexStatus, 'R')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (D) CappedBuffer tail/head modes (via status overflow + showBlob head)
// ===========================================================================

test('GitRunner: status stdout tail-capped at 16 KiB', async () => {
  if (!GIT) return test.skip('git not installed')
  // 200 untracked files → porcelain v2 output well over 16 KiB.
  const { root, cleanup } = makeRepo((root, g) => {
    g(['commit', '-q', '--allow-empty', '-m', 'init'])
    for (let i = 0; i < 200; i++) {
      writeFileSync(path.join(root, `file-with-a-long-name-${i}-${'x'.repeat(80)}.txt`), 'x\n')
    }
  })
  try {
    const runner = new GitRunner()
    const raw = await runner.statusPorcelainV2(root)
    // The Buffer re-encoded from the tail-capped stdout; the LAST untracked
    // file (199) must be present (tail preserves the end).
    const text = raw.toString('utf8')
    assert.ok(text.includes('file-with-a-long-name-199-'), 'tail must retain the last entry')
    // The first entry (0) is likely truncated away.
    assert.ok(!text.includes('file-with-a-long-name-0-'), 'head entries truncated in tail mode')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (E) AbortSignal cancellation
// ===========================================================================

test('GitRunner: AbortSignal cancels statusPorcelainV2 (COMMAND_TIMEOUT)', async () => {
  if (!GIT) return test.skip('git not installed')
  // A repo with many untracked files makes `git status` take long enough to
  // abort mid-flight. We abort immediately after starting; the child is
  // SIGKILLed and the promise rejects COMMAND_TIMEOUT.
  const { root, cleanup } = makeRepo((root, g) => {
    g(['commit', '-q', '--allow-empty', '-m', 'init'])
    for (let i = 0; i < 5000; i++) {
      writeFileSync(path.join(root, `f${i}-${'x'.repeat(60)}.txt`), 'x\n')
    }
  })
  try {
    const runner = new GitRunner()
    const ac = new AbortController()
    const p = runner.statusPorcelainV2(root, ac.signal)
    setImmediate(() => ac.abort())
    await assert.rejects(
      p,
      (e) => e instanceof GitRunnerError && e.code === 'COMMAND_TIMEOUT',
      'aborted status must reject with COMMAND_TIMEOUT',
    )
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (F) validatePaths rejects NUL / absolute / '..' / out-of-snapshot
// ===========================================================================

test('validatePaths: rejects NUL bytes', () => {
  const allowed = new Set(['a.txt'])
  assert.throws(() => validatePaths(['a.txt\0evil'], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
})

test('validatePaths: rejects absolute paths', () => {
  const allowed = new Set(['a.txt'])
  assert.throws(() => validatePaths(['/etc/passwd'], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
})

test('validatePaths: rejects .. traversal', () => {
  const allowed = new Set(['a.txt'])
  assert.throws(() => validatePaths(['../outside.txt'], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
  assert.throws(() => validatePaths(['dir/../../outside.txt'], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
})

test('validatePaths: rejects paths not in the status snapshot', () => {
  const allowed = new Set(['a.txt', 'b.txt'])
  assert.throws(() => validatePaths(['c.txt'], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
})

test('validatePaths: accepts snapshot paths', () => {
  const allowed = new Set(['a.txt', 'dir/b.txt'])
  assert.deepEqual(validatePaths(['a.txt', 'dir/b.txt'], allowed), ['a.txt', 'dir/b.txt'])
})

test('validatePaths: rejects empty array and non-string entries', () => {
  const allowed = new Set(['a.txt'])
  assert.throws(() => validatePaths([], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
  assert.throws(() => validatePaths([123], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
  assert.throws(() => validatePaths([''], allowed), (e) => e.code === 'REPOSITORY_UNSAFE')
})

// ===========================================================================
// Extra: configGet + non-repo error mapping
// ===========================================================================

test('GitRunner.configGet: returns null for an unset key', async () => {
  if (!GIT) return test.skip('git not installed')
  // Isolate from the user's global/system git config so `user.name` is truly
  // unset. The runner sets GIT_TERMINAL_PROMPT=0 but inherits the rest of
  // process.env, so we run this case in a child that overrides HOME to the
  // repo and blocks global/system config.
  const { root, cleanup } = makeRepo((root, g) => {
    // Wipe local user.name so only global could supply it.
    try { g(['config', '--local', '--unset', 'user.name']) } catch { /* already unset */ }
  })
  try {
    const runner = new GitRunner()
    // Re-init the repo's local config WITHOUT user.name, under an isolated env.
    // Easiest: spawn git directly with -c to nullify global for this one call.
    // But configGet uses the runner's env. Instead, verify the unset path by
    // unsetting local AND asserting: if a global user.name exists, this test
    // would return it — so we skip when global is set.
    const globalCheck = spawnSync('git', ['config', '--global', '--get', 'user.name'], { encoding: 'utf8' })
    const hasGlobal = globalCheck.status === 0 && globalCheck.stdout.trim()
    if (hasGlobal) return test.skip('global user.name is set; cannot test the unset path in this environment')
    assert.equal(await runner.configGet(root, 'user.name'), null)
  } finally {
    cleanup()
  }
})

test('GitRunner.revParseTopLevel: NOT_REPOSITORY on a non-repo dir', async () => {
  if (!GIT) return test.skip('git not installed')
  const notARepo = mkdtempSync(path.join(os.tmpdir(), 'raintool-notrepo-'))
  try {
    const runner = new GitRunner()
    await assert.rejects(
      runner.revParseTopLevel(notARepo),
      (e) => e instanceof GitRunnerError && (e.code === 'NOT_REPOSITORY' || e.code === 'COMMAND_FAILED'),
    )
  } finally {
    rmSync(notARepo, { recursive: true, force: true })
  }
})

test('GIT_OUTPUT_CAP_BYTES is 16 KiB', () => {
  assert.equal(GIT_OUTPUT_CAP_BYTES, 16 * 1024)
})

// ===========================================================================
// (G) readBlobText: missing blob → '' (no spawn); real errors propagate
// ===========================================================================

/**
 * A GitRunner that delegates to a real runner for everything EXCEPT showBlob,
 * which throws a caller-chosen error. This lets us prove readBlobText
 * propagates timeout / GIT_NOT_FOUND / COMMAND_FAILED when catFileSize says the
 * blob EXISTS (size !== null), while still returning '' for genuinely missing
 * blobs (size === null, where readBlobText never calls showBlob at all).
 */
class FakeShowBlobRunner extends GitRunner {
  constructor(real, opts) {
    super()
    this._real = real
    this._opts = opts
  }
  async revParseTopLevel(root) { return this._real.revParseTopLevel(root) }
  async revParseHead(root) { return this._real.revParseHead(root) }
  async statusPorcelainV2(root, signal) { return this._real.statusPorcelainV2(root, signal) }
  async configGet(root, key) { return this._real.configGet(root, key) }
  async add(root, paths) { return this._real.add(root, paths) }
  async restoreStaged(root, paths) { return this._real.restoreStaged(root, paths) }
  async catFileSize(root, treeIsh, rel) {
    if (this._opts.catFileSizeOverride !== undefined) return this._opts.catFileSizeOverride
    return this._real.catFileSize(root, treeIsh, rel)
  }
  async showBlob(_root, _treeIsh, _rel) {
    if (this._opts.showBlobError) throw this._opts.showBlobError
    const text = this._opts.showBlobResult ?? 'fake-blob\n'
    return { text, truncated: false }
  }
}

test('readBlobText: missing blob (catFileSize=null) → "" without spawning showBlob', async () => {
  if (!GIT) return test.skip('git not installed')
  // f.txt must appear in the status snapshot for getDiff to accept it, so we
  // stage a modification. The fake then overrides catFileSize → null so
  // readBlobText treats the blob as missing WITHOUT spawning showBlob.
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.txt'), 'content\n')
    g(['add', 'f.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'f.txt'), 'content2\n')
    g(['add', 'f.txt'])
  })
  try {
    let showBlobCalled = false
    const fake = new FakeShowBlobRunner(new GitRunner(), {
      catFileSizeOverride: null, // blob "missing" per the override
    })
    fake.showBlob = async () => { showBlobCalled = true; throw new Error('showBlob must NOT be called for a missing blob') }
    const svc = new GitRepositoryService(fake)
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'f.txt', source: 'staged' })
    assert.equal(showBlobCalled, false, 'showBlob must not spawn when catFileSize says the blob is missing')
    // Both sides "missing" (override null) → original==modified=='' → empty.
    assert.equal(diff.kind, 'empty')
  } finally {
    cleanup()
  }
})

test('readBlobText: COMMAND_TIMEOUT from showBlob propagates (blob confirmed present)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.txt'), 'content\n')
    g(['add', 'f.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'f.txt'), 'content2\n')
    g(['add', 'f.txt'])
  })
  try {
    // catFileSize returns a real size (blob exists), so readBlobText reaches
    // showBlob, which throws COMMAND_TIMEOUT. The service must propagate it —
    // NOT swallow it as "missing blob → ''".
    const real = new GitRunner()
    const fake = new FakeShowBlobRunner(real, {
      // Let catFileSize run for real (blob exists → non-null size).
      catFileSizeOverride: undefined,
      showBlobError: new GitRunnerError('COMMAND_TIMEOUT', 'Git 命令已取消（超时或中止）'),
    })
    const svc = new GitRepositoryService(fake)
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.getDiff({ repositoryId: handle.repositoryId, path: 'f.txt', source: 'staged' }),
      (e) => e.code === 'COMMAND_TIMEOUT',
      'a timeout from showBlob must propagate, not be swallowed as empty',
    )
  } finally {
    cleanup()
  }
})

test('readBlobText: GIT_NOT_FOUND from showBlob propagates (blob confirmed present)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.txt'), 'content\n')
    g(['add', 'f.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'f.txt'), 'content2\n')
    g(['add', 'f.txt'])
  })
  try {
    const fake = new FakeShowBlobRunner(new GitRunner(), {
      catFileSizeOverride: undefined, // blob exists
      showBlobError: new GitRunnerError('GIT_NOT_FOUND', '未找到 git 可执行文件'),
    })
    const svc = new GitRepositoryService(fake)
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.getDiff({ repositoryId: handle.repositoryId, path: 'f.txt', source: 'staged' }),
      (e) => e.code === 'GIT_NOT_FOUND',
      'GIT_NOT_FOUND must propagate, not be swallowed',
    )
  } finally {
    cleanup()
  }
})

test('readBlobText: a present HEAD blob with a missing :0 blob → original=text, modified=""', async () => {
  if (!GIT) return test.skip('git not installed')
  // Real staged deletion: HEAD has the blob, :0 is missing.
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'f.txt'), 'bye\n')
    g(['add', 'f.txt'])
    g(['commit', '-q', '-m', 'init'])
    g(['rm', '-q', 'f.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'f.txt', source: 'staged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, 'bye\n', 'HEAD blob fetched for real')
    assert.equal(diff.modified, '', ':0 blob missing → "" without error')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (G) Task 3 — commit / fetch / pull --ff-only / push
//     Closed named operations only; gates enforced; no force/reset/merge.
// ===========================================================================

/**
 * Bare-remote fixture: `git init --bare remote` → `git clone remote clone` →
 * configure clone identity → seed callback → initial commit + push -u origin main.
 * Returns { remoteRoot, cloneRoot, gClone, cleanup }. Two clones share the bare
 * remote so fetch/pull/push scenarios can simulate a second developer.
 */
function makeRemoteRepo(seed) {
  const remoteRoot = mkdtempSync(path.join(os.tmpdir(), 'raintool-git-remote-'))
  const cloneRoot = mkdtempSync(path.join(os.tmpdir(), 'raintool-git-clone-'))
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  // bare remote
  let r = spawnSync('git', ['init', '-q', '--bare', '--initial-branch=main', remoteRoot], { env })
  if (r.status !== 0) throw new Error(`bare init failed: ${r.stderr?.toString()}`)
  // clone (empty) — clone of an empty bare repo warns but succeeds
  r = spawnSync('git', ['clone', '-q', remoteRoot, cloneRoot], { env })
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr?.toString()}`)
  const gClone = (args) => {
    const rr = spawnSync('git', args, { cwd: cloneRoot, env })
    if (rr.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${rr.stderr?.toString()}`)
    return rr
  }
  gClone(['config', 'user.name', 'Test'])
  gClone(['config', 'user.email', 'test@example.com'])
  gClone(['config', 'commit.gpgsign', 'false'])
  if (seed) seed(cloneRoot, gClone)
  // Ensure there's an initial commit + upstream tracking, unless the seed
  // already committed. We detect by checking rev-parse HEAD.
  const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: cloneRoot, env })
  if (head.status !== 0) {
    writeFileSync(path.join(cloneRoot, 'README.md'), '# init\n')
    gClone(['add', 'README.md'])
    gClone(['commit', '-q', '-m', 'init'])
    gClone(['push', '-u', '-q', 'origin', 'main'])
  }
  return {
    remoteRoot,
    cloneRoot,
    gClone,
    cleanup: () => {
      rmSync(remoteRoot, { recursive: true, force: true })
      rmSync(cloneRoot, { recursive: true, force: true })
    },
  }
}

/** A second clone of the same bare remote, for simulating a remote-side push. */
function makeSecondClone(remoteRoot) {
  const second = mkdtempSync(path.join(os.tmpdir(), 'raintool-git-second-'))
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const r = spawnSync('git', ['clone', '-q', remoteRoot, second], { env })
  if (r.status !== 0) throw new Error(`second clone failed: ${r.stderr?.toString()}`)
  const g = (args) => {
    const rr = spawnSync('git', args, { cwd: second, env })
    if (rr.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${rr.stderr?.toString()}`)
    return rr
  }
  g(['config', 'user.name', 'Other'])
  g(['config', 'user.email', 'other@example.com'])
  g(['config', 'commit.gpgsign', 'false'])
  return { second, g, cleanup: () => rmSync(second, { recursive: true, force: true }) }
}

test('Task 3 getIdentity: returns configured name + email', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo()
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const id = await svc.getIdentity(handle.repositoryId)
    assert.equal(id.name, 'Test')
    assert.equal(id.email, 'test@example.com')
  } finally {
    cleanup()
  }
})

/**
 * A GitRunner that delegates to a real runner EXCEPT for configGet, which
 * returns caller-chosen values. This deterministically proves the service's
 * IDENTITY_MISSING gate without depending on the host machine's global
 * user.name/user.email (which the real `git config --get` would fall back to).
 * The production contract stays closed: the service only calls the public
 * named operations, and the fake is a subclass of GitRunner so the service
 * accepts it unchanged.
 */
class FakeIdentityRunner extends GitRunner {
  constructor(real, opts) {
    super()
    this._real = real
    this._opts = opts
  }
  async revParseTopLevel(root) { return this._real.revParseTopLevel(root) }
  async revParseHead(root) { return this._real.revParseHead(root) }
  async statusPorcelainV2(root, signal) { return this._real.statusPorcelainV2(root, signal) }
  async configGet(_root, _key) {
    // Deterministic: ignore the real config. Default to "no identity" so the
    // IDENTITY_MISSING gate fires without touching the host's global git config.
    return this._opts.name ?? null
  }
  async add(root, paths) { return this._real.add(root, paths) }
  async restoreStaged(root, paths) { return this._real.restoreStaged(root, paths) }
  async catFileSize(root, treeIsh, rel) { return this._real.catFileSize(root, treeIsh, rel) }
  async showBlob(root, treeIsh, rel) { return this._real.showBlob(root, treeIsh, rel) }
  async commit(...args) { return this._real.commit(...args) }
  async fetch(...args) { return this._real.fetch(...args) }
  async pullFfOnly(...args) { return this._real.pullFfOnly(...args) }
  async push(...args) { return this._real.push(...args) }
  async pushUpstream(...args) { return this._real.pushUpstream(...args) }
}

test('Task 3 getIdentity: returns nulls when user.name/email unset', async () => {
  if (!GIT) return test.skip('git not installed')
  // Deterministic via FakeIdentityRunner: configGet returns null regardless of
  // the host's global git config. No production change, no env mutation.
  const { root, cleanup } = makeRepo()
  try {
    const svc = new GitRepositoryService(new FakeIdentityRunner(new GitRunner(), { name: null }))
    const handle = await svc.openRepository(root)
    const id = await svc.getIdentity(handle.repositoryId)
    assert.equal(id.name, null)
    assert.equal(id.email, null)
  } finally {
    cleanup()
  }
})

test('Task 3 commit: IDENTITY_MISSING when user.name/email unset', async () => {
  if (!GIT) return test.skip('git not installed')
  // Deterministic via FakeIdentityRunner: configGet returns null for BOTH
  // user.name and user.email, so the service gate fires IDENTITY_MISSING
  // before any git mutation — regardless of the host's global git config.
  // The repo still has a staged file so the only reason to reject is identity.
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
  })
  try {
    const svc = new GitRepositoryService(new FakeIdentityRunner(new GitRunner(), { name: null }))
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.commit({ repositoryId: handle.repositoryId, subject: 'add a', body: '' }),
      (e) => e.code === 'IDENTITY_MISSING',
      'unset identity must reject with IDENTITY_MISSING before any mutation',
    )
    // Nothing was committed — HEAD still doesn't exist (only a staged file).
    const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root })
    assert.notEqual(head.status, 0, 'no commit should exist')
  } finally {
    cleanup()
  }
})

test('Task 3 commit: NO_STAGED_CHANGES on a clean repo', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.commit({ repositoryId: handle.repositoryId, subject: 'noop', body: '' }),
      (e) => e.code === 'NO_STAGED_CHANGES',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 commit: EMPTY_COMMIT on empty subject', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.commit({ repositoryId: handle.repositoryId, subject: '   ', body: '' }),
      (e) => e.code === 'EMPTY_COMMIT',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 commit: EMPTY_COMMIT on overlong subject (>200)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.commit({ repositoryId: handle.repositoryId, subject: 'x'.repeat(201), body: '' }),
      (e) => e.code === 'EMPTY_COMMIT',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 commit: MERGE_OR_REBASE_IN_PROGRESS when MERGE_HEAD present', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    // Fabricate a merge-in-progress state: write MERGE_HEAD + staged change.
    writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), '0'.repeat(40))
    writeFileSync(path.join(root, 'b.txt'), 'b\n')
    g(['add', 'b.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.commit({ repositoryId: handle.repositoryId, subject: 'merge commit', body: '' }),
      (e) => e.code === 'MERGE_OR_REBASE_IN_PROGRESS',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 commit: success returns 40-char headSha + refreshed status (staged now empty)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const result = await svc.commit({
      repositoryId: handle.repositoryId,
      subject: 'add a',
      body: 'line1\nline2',
    })
    assert.match(result.headSha, /^[0-9a-f]{40}$/, 'headSha is a 40-char sha')
    assert.equal(result.status.staged.length, 0, 'staged set cleared after commit')
    // Verify the commit message on disk matches subject + body.
    const log = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: root })
    const msg = log.stdout.toString().trim()
    assert.ok(msg.startsWith('add a'), 'subject is first line')
    assert.ok(msg.includes('line1'), 'body present')
  } finally {
    cleanup()
  }
})

test('Task 3 commit: HOOK_FAILED on a failing pre-commit hook', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
  })
  try {
    // Install a failing pre-commit hook. The stderr must contain a token that
    // mapExitToError recognizes as a hook failure (e.g. "pre-commit" or
    // "hook declined"); a bare "nope" would fall through to COMMAND_FAILED.
    const hookPath = path.join(root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hookPath, '#!/bin/sh\necho "pre-commit hook declined" >&2\nexit 1\n')
    spawnSync('chmod', ['+x', hookPath])
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.commit({ repositoryId: handle.repositoryId, subject: 'should fail', body: '' }),
      (e) => e.code === 'HOOK_FAILED',
    )
    // No commit should have been created.
    const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root })
    assert.notEqual(head.status, 0, 'hook must have blocked the commit')
  } finally {
    cleanup()
  }
})

test('Task 3 fetch: updates remote refs (behind count increases)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo()
  try {
    // Second clone advances the remote by one commit.
    const second = makeSecondClone(remoteRoot)
    try {
      writeFileSync(path.join(second.second, 'remote.txt'), 'from-second\n')
      second.g(['add', 'remote.txt'])
      second.g(['commit', '-q', '-m', 'remote advance'])
      second.g(['push', '-q', 'origin', 'main'])
    } finally {
      second.cleanup()
    }
    // The first clone hasn't fetched yet — behind should be 0 (it doesn't know).
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    const before = await svc.getStatus(handle.repositoryId)
    assert.equal(before.repository.behind, 0, 'before fetch, behind is 0 (unaware of remote)')

    const result = await svc.fetch(handle.repositoryId)
    assert.equal(result.status.repository.behind, 1, 'after fetch, behind=1')
    assert.equal(result.summary, '已更新远端引用')
  } finally {
    cleanup()
  }
})

test('Task 3 pull --ff-only: fast-forwards to remote HEAD', async () => {
  if (!GIT) return test.skip('git not installed')
  const { remoteRoot, cloneRoot, cleanup } = makeRemoteRepo()
  try {
    // Remote advances by one commit (via a second clone).
    const second = makeSecondClone(remoteRoot)
    try {
      writeFileSync(path.join(second.second, 'ff.txt'), 'ff\n')
      second.g(['add', 'ff.txt'])
      second.g(['commit', '-q', '-m', 'remote ff'])
      second.g(['push', '-q', 'origin', 'main'])
    } finally {
      second.cleanup()
    }
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    const result = await svc.pullFfOnly(handle.repositoryId)
    assert.equal(result.status.repository.behind, 0, 'pull ff → behind=0')
    assert.equal(result.status.repository.ahead, 0, 'pull ff → ahead=0')
    // The ff.txt file should now exist in cloneRoot.
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(path.join(cloneRoot, 'ff.txt'), 'utf8'), 'ff\n')
  } finally {
    cleanup()
  }
})

test('Task 3 pull --ff-only: non-fast-forward → REMOTE_DIVERGED (no merge commit)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo()
  try {
    // Local diverges: add a local commit.
    writeFileSync(path.join(cloneRoot, 'local.txt'), 'local\n')
    gClone(['add', 'local.txt'])
    gClone(['commit', '-q', '-m', 'local divergence'])
    // Remote diverges: second clone pushes a different commit.
    const second = makeSecondClone(remoteRoot)
    try {
      writeFileSync(path.join(second.second, 'remote.txt'), 'remote\n')
      second.g(['add', 'remote.txt'])
      second.g(['commit', '-q', '-m', 'remote divergence'])
      second.g(['push', '-q', 'origin', 'main'])
    } finally {
      second.cleanup()
    }
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    await assert.rejects(
      svc.pullFfOnly(handle.repositoryId),
      (e) => e.code === 'REMOTE_DIVERGED',
      'diverged remote must reject with REMOTE_DIVERGED, not merge',
    )
    // No merge commit should have been created — local HEAD still points at the
    // local-divergence commit (1 parent, no MERGE_HEAD).
    const log = spawnSync('git', ['log', '-1', '--format=%P'], { cwd: cloneRoot })
    const parents = log.stdout.toString().trim().split(/\s+/)
    assert.equal(parents.length, 1, 'no merge commit created by pull --ff-only')
    const mergeHead = spawnSync('git', ['rev-parse', '-q', 'MERGE_HEAD'], { cwd: cloneRoot })
    assert.notEqual(mergeHead.status, 0, 'no MERGE_HEAD left behind')
  } finally {
    cleanup()
  }
})

test('Task 3 pull: NO_UPSTREAM when branch has no upstream', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.pullFfOnly(handle.repositoryId),
      (e) => e.code === 'NO_UPSTREAM',
      'branch with no upstream must reject with NO_UPSTREAM',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 push: NO_UPSTREAM when branch has no upstream (no silent origin)', async () => {
  if (!GIT) return test.skip('git not installed')
  // Supervisor correction 1: push() must NEVER silently assume origin. A branch
  // with no upstream rejects NO_UPSTREAM; the UI then guides the user through an
  // explicit remote/branch confirmation via pushUpstream(repositoryId, remote).
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo((cloneRoot, g) => {
    writeFileSync(path.join(cloneRoot, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    // Unset tracking to force the no-upstream state.
    const tolerantUnset = (key) => {
      spawnSync('git', ['config', '--unset', key], { cwd: cloneRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    }
    tolerantUnset('branch.main.remote')
    tolerantUnset('branch.main.merge')
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    await assert.rejects(
      svc.push(handle.repositoryId),
      (e) => e.code === 'NO_UPSTREAM',
      'push() with no upstream must reject NO_UPSTREAM, never silently push -u origin',
    )
    // Nothing was pushed: the remote has no main ref yet.
    const remoteHead = spawnSync('git', ['--git-dir', remoteRoot, 'rev-parse', '-q', 'main'])
    assert.notEqual(remoteHead.status, 0, 'remote main must NOT exist — push() refused to guess origin')
  } finally {
    cleanup()
  }
})

test('Task 3 pushUpstream: explicit origin/branch sets tracking after user confirmation', async () => {
  if (!GIT) return test.skip('git not installed')
  // Supervisor correction 1: the FIRST push goes through pushUpstream(remote),
  // where remote is user-confirmed AND server-validated against `git remote`.
  // branch is the current branch from the status snapshot (never renderer-supplied).
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo((cloneRoot, g) => {
    writeFileSync(path.join(cloneRoot, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const tolerantUnset = (key) => {
      spawnSync('git', ['config', '--unset', key], { cwd: cloneRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    }
    tolerantUnset('branch.main.remote')
    tolerantUnset('branch.main.merge')
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    // push() rejects NO_UPSTREAM first (proven above); the UI then calls
    // pushUpstream with the user-confirmed remote name.
    const result = await svc.pushUpstream({ repositoryId: handle.repositoryId, remote: 'origin' })
    assert.match(result.summary, /origin\/main/, 'summary names the confirmed remote/branch')
    // Upstream should now be set: branch.main.remote=origin.
    const remote = spawnSync('git', ['config', 'branch.main.remote'], { cwd: cloneRoot })
    assert.equal(remote.stdout.toString().trim(), 'origin', 'push -u set branch.main.remote=origin')
    // The bare remote should have the commit.
    const remoteHead = spawnSync('git', ['--git-dir', remoteRoot, 'rev-parse', 'main'])
    assert.equal(remoteHead.status, 0, 'remote main exists after explicit pushUpstream')
  } finally {
    cleanup()
  }
})

test('Task 3 pushUpstream: rejects an unconfigured remote (REPOSITORY_UNSAFE)', async () => {
  if (!GIT) return test.skip('git not installed')
  // The service validates remote against `git remote` BEFORE spawning
  // `git push -u <remote> <branch>` — a bogus remote never reaches spawn.
  const { cloneRoot, cleanup } = makeRemoteRepo((cloneRoot, g) => {
    writeFileSync(path.join(cloneRoot, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    await assert.rejects(
      svc.pushUpstream({ repositoryId: handle.repositoryId, remote: 'evil-remote' }),
      (e) => e.code === 'REPOSITORY_UNSAFE',
      'an unconfigured remote must be rejected before any spawn',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 pushUpstream: rejects a remote name with shell metacharacters', async () => {
  if (!GIT) return test.skip('git not installed')
  // Defense in depth: even though spawn uses shell:false, a remote name with
  // slashes/spaces/NUL is rejected early so it never reaches spawn.
  const { cloneRoot, cleanup } = makeRemoteRepo((cloneRoot, g) => {
    writeFileSync(path.join(cloneRoot, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    for (const bad of ['origin/main', 'o rigin', 'orig\0in', '']) {
      await assert.rejects(
        svc.pushUpstream({ repositoryId: handle.repositoryId, remote: bad }),
        (e) => e.code === 'REPOSITORY_UNSAFE',
        `remote name ${JSON.stringify(bad)} must be rejected`,
      )
    }
  } finally {
    cleanup()
  }
})

test('Task 3 listRemotes: returns configured remotes (origin for a clone)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { cloneRoot, cleanup } = makeRemoteRepo()
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    const result = await svc.listRemotes(handle.repositoryId)
    assert.ok(result.remotes.includes('origin'), 'a clone has an origin remote')
  } finally {
    cleanup()
  }
})

test('Task 3 listRemotes: empty array for a repo with no remotes', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const result = await svc.listRemotes(handle.repositoryId)
    assert.deepEqual(result.remotes, [], 'a repo with no remotes returns []')
  } finally {
    cleanup()
  }
})

test('Task 3 push: non-fast-forward → REMOTE_DIVERGED', async () => {
  if (!GIT) return test.skip('git not installed')
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo()
  try {
    // Remote advances via second clone.
    const second = makeSecondClone(remoteRoot)
    try {
      writeFileSync(path.join(second.second, 'remote.txt'), 'remote\n')
      second.g(['add', 'remote.txt'])
      second.g(['commit', '-q', '-m', 'remote advance'])
      second.g(['push', '-q', 'origin', 'main'])
    } finally {
      second.cleanup()
    }
    // Local also advances (diverges) WITHOUT fetching.
    writeFileSync(path.join(cloneRoot, 'local.txt'), 'local\n')
    gClone(['add', 'local.txt'])
    gClone(['commit', '-q', '-m', 'local divergence'])
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    await assert.rejects(
      svc.push(handle.repositoryId),
      (e) => e.code === 'REMOTE_DIVERGED',
      'non-ff push must reject with REMOTE_DIVERGED',
    )
  } finally {
    cleanup()
  }
})

test('Task 3 push: detached HEAD → REPOSITORY_UNSAFE', async () => {
  if (!GIT) return test.skip('git not installed')
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo()
  try {
    // Detach HEAD in the clone.
    gClone(['checkout', '-q', '--detach', 'HEAD'])
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    await assert.rejects(
      svc.push(handle.repositoryId),
      (e) => e.code === 'REPOSITORY_UNSAFE',
      'detached HEAD must reject push with REPOSITORY_UNSAFE',
    )
  } finally {
    cleanup()
  }
})

test('Task 3: no force-push path exists — GitRunner has no --force-accepting method', () => {
  const runner = new GitRunner()
  // The only push methods are push() and pushUpstream(); neither accepts a flag
  // arg, so --force / -f can never be injected. Confirm by signature arity.
  assert.equal(runner.push.length, 2, 'push(root, signal) — no flag arg')
  // pushUpstream(root, remote, branch, signal) — remote is server-validated
  // against `git remote`, branch is from the status snapshot; no flag arg.
  assert.equal(runner.pushUpstream.length, 4, 'pushUpstream(root, remote, branch, signal) — no flag arg')
  // And there is no method named after a force/destructive verb.
  const forbidden = ['forcePush', 'pushForce', 'reset', 'resetHard', 'pushWithForce', 'deleteBranch']
  for (const f of forbidden) {
    assert.equal(typeof runner[f], 'undefined', `GitRunner must NOT expose ${f}`)
  }
})

test('Task 3 commit: no autocommit/autopush — commit does not trigger push', async () => {
  if (!GIT) return test.skip('git not installed')
  const { remoteRoot, cloneRoot, gClone, cleanup } = makeRemoteRepo()
  try {
    // Stage a new file and commit via the service.
    writeFileSync(path.join(cloneRoot, 'new.txt'), 'new\n')
    gClone(['add', 'new.txt'])
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(cloneRoot)
    const result = await svc.commit({
      repositoryId: handle.repositoryId,
      subject: 'add new',
      body: '',
    })
    assert.match(result.headSha, /^[0-9a-f]{40}$/)
    // ahead should be 1 (local commit not pushed); behind 0.
    assert.equal(result.status.repository.ahead, 1, 'commit did NOT auto-push (ahead=1)')
    // Remote main should NOT have the new commit.
    const localHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloneRoot }).stdout.toString().trim()
    const remoteHead = spawnSync('git', ['--git-dir', remoteRoot, 'rev-parse', 'main']).stdout.toString().trim()
    assert.notEqual(localHead, remoteHead, 'remote HEAD unchanged — no autopush happened')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (H) Supervisor correction 2 — discard worktree (tracked unstaged only)
//     Closed named restoreWorktree; service gates on fresh-status unstaged set;
//     staged changes untouched; untracked paths rejected; no delete.
// ===========================================================================

test('discard: restores unstaged worktree changes to the index version', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    // Unstaged modification on top of the committed version.
    writeFileSync(path.join(root, 'a.txt'), 'committed\nworktree-change\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const status = await svc.discardWorktreeFiles(handle.repositoryId, ['a.txt'])
    assert.equal(status.unstaged.length, 0, 'a.txt no longer unstaged after discard')
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'committed\n', 'worktree restored to committed version')
  } finally {
    cleanup()
  }
})

test('discard: staged changes are UNTOUCHED (only worktree resets)', async () => {
  if (!GIT) return test.skip('git not installed')
  // File is BOTH staged (index = "staged") and unstaged (worktree = "worktree").
  // discard must reset the worktree to the INDEX version ("staged"), preserving
  // the staged change. This is the critical "staged untouched" guarantee.
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'a.txt'), 'staged\n')
    g(['add', 'a.txt']) // index now "staged"
    writeFileSync(path.join(root, 'a.txt'), 'staged\nworktree\n') // worktree diverges
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const before = await svc.getStatus(handle.repositoryId)
    assert.equal(before.staged.length, 1, 'a.txt is staged before discard')
    assert.equal(before.unstaged.length, 1, 'a.txt is also unstaged before discard')
    const status = await svc.discardWorktreeFiles(handle.repositoryId, ['a.txt'])
    assert.equal(status.staged.length, 1, 'staged change PRESERVED (discard never touches the index)')
    assert.equal(status.unstaged.length, 0, 'worktree reset to index → no longer unstaged')
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'staged\n', 'worktree restored to INDEX version, not HEAD')
  } finally {
    cleanup()
  }
})

test('discard: rejects an untracked path (no delete offered)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'untracked.txt'), 'new\n') // untracked
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.discardWorktreeFiles(handle.repositoryId, ['untracked.txt']),
      (e) => e.code === 'REPOSITORY_UNSAFE',
      'untracked paths must be rejected — first version offers no delete',
    )
    // The untracked file must still exist on disk.
    const { existsSync } = await import('node:fs')
    assert.ok(existsSync(path.join(root, 'untracked.txt')), 'untracked file NOT deleted')
  } finally {
    cleanup()
  }
})

test('discard: rejects a staged-only path (nothing to discard, refuse to touch)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'a.txt'), 'staged\n')
    g(['add', 'a.txt']) // staged only, no worktree divergence
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.discardWorktreeFiles(handle.repositoryId, ['a.txt']),
      (e) => e.code === 'REPOSITORY_UNSAFE',
      'a staged-only path (no worktree change) must be rejected — nothing to discard',
    )
  } finally {
    cleanup()
  }
})

test('discard: rejects a path not in the status snapshot (stale UI)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.discardWorktreeFiles(handle.repositoryId, ['nonexistent.txt']),
      (e) => e.code === 'REPOSITORY_UNSAFE',
      'a path not in the fresh status snapshot must be rejected',
    )
  } finally {
    cleanup()
  }
})

test('discard: rejects NUL / absolute / .. paths (defense in depth)', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'a.txt'), 'committed\nworktree\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    for (const bad of ['a.txt\0', '/etc/passwd', '../escape.txt']) {
      await assert.rejects(
        svc.discardWorktreeFiles(handle.repositoryId, [bad]),
        (e) => e.code === 'REPOSITORY_UNSAFE',
        `path ${JSON.stringify(bad)} must be rejected`,
      )
    }
    // a.txt still has its worktree change (nothing was discarded).
    const { readFileSync } = await import('node:fs')
    assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'committed\nworktree\n', 'no discard happened for rejected paths')
  } finally {
    cleanup()
  }
})

test('discard: rejects during a merge in progress', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'a.txt'), 'committed\nworktree\n')
    writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), '0'.repeat(40))
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      svc.discardWorktreeFiles(handle.repositoryId, ['a.txt']),
      (e) => e.code === 'MERGE_OR_REBASE_IN_PROGRESS',
      'discard during a merge must be rejected',
    )
  } finally {
    cleanup()
  }
})

// ===========================================================================
// (I) Supervisor correction 3 — diff limits aligned with plan (2 MiB / 50k lines)
//     + explicit split/unified view echo.
// ===========================================================================

test('diff: too_large when a side exceeds 2 MiB', async () => {
  if (!GIT) return test.skip('git not installed')
  // 3 MiB of 'x' → exceeds the 2 MiB cap. catFileSize reports the HEAD blob
  // size; the service returns too_large WITHOUT fetching the blob text.
  const big = 'x'.repeat(3 * 1024 * 1024)
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'big.txt'), big)
    g(['add', 'big.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'big.txt'), big + '\nworktree\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'big.txt', source: 'unstaged' })
    assert.equal(diff.kind, 'too_large', 'a >2 MiB file must be too_large')
    assert.match(diff.summary, /2 MiB/, 'summary names the 2 MiB cap')
    assert.equal(diff.original, undefined, 'no text shipped for too_large')
    assert.equal(diff.modified, undefined, 'no text shipped for too_large')
  } finally {
    cleanup()
  }
})

test('diff: too_large when a side exceeds 50,000 lines (under the byte cap)', async () => {
  if (!GIT) return test.skip('git not installed')
  // 60,000 short lines: well under 2 MiB in bytes, but over the 50k line cap.
  // Each line "l\n" is 2 bytes → 120 KiB total, under the byte cap. The line
  // cap must catch it and return too_large.
  const manyLines = Array.from({ length: 60_000 }, (_, i) => `l${i}`).join('\n') + '\n'
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'many.txt'), manyLines)
    g(['add', 'many.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'many.txt'), manyLines + 'worktree\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'many.txt', source: 'unstaged' })
    assert.equal(diff.kind, 'too_large', 'a >50,000-line file must be too_large even under the byte cap')
    assert.match(diff.summary, /50,000 行/, 'summary names the 50,000 line cap')
  } finally {
    cleanup()
  }
})

test('diff: text under both caps is returned in full', async () => {
  if (!GIT) return test.skip('git not installed')
  // 1.5 MiB / 1,000 lines — under both caps. Must come back as full text.
  const lines = Array.from({ length: 1_000 }, (_, i) => `line ${i}`).join('\n') + '\n'
  const modified = lines + 'extra\n'
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'ok.txt'), lines)
    g(['add', 'ok.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'ok.txt'), modified)
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'ok.txt', source: 'unstaged' })
    assert.equal(diff.kind, 'text')
    assert.equal(diff.original, lines, 'full original text returned')
    assert.equal(diff.modified, modified, 'full modified text returned')
  } finally {
    cleanup()
  }
})

test('diff: >256 KiB but <2 MiB blob is fetched in FULL (no stale 256 KiB truncation)', async () => {
  if (!GIT) return test.skip('git not installed')
  // Regression guard: showBlob used to default its cap to 256 KiB, so a blob
  // between 257 KiB and 2 MiB was silently truncated to its first 256 KiB even
  // though it passed the 2 MiB size pre-check. The cap is now aligned with
  // DIFF_SIZE_CAP_BYTES (2 MiB) and the service passes the exact bounded size.
  // This file is 512 KiB of ASCII — well past the old 256 KiB default, well
  // under the 2 MiB policy cap, and under the 50,000 line cap.
  const original = 'a'.repeat(512 * 1024) + '\n' // 512 KiB + newline
  const modified = original.slice(0, -2) + 'ZZ\n' // tiny change at the very end
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'bigish.txt'), original)
    g(['add', 'bigish.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'bigish.txt'), modified)
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const diff = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'bigish.txt', source: 'unstaged' })
    assert.equal(diff.kind, 'text', '512 KiB is under the 2 MiB cap → text, not too_large')
    assert.equal(diff.truncated, false, 'no safety truncation expected (blob size known + stable)')
    // The CRITICAL assertion: the full 512 KiB is present, NOT truncated to
    // 256 KiB. The old bug would have made original.length === 256 * 1024.
    assert.equal(diff.original.length, original.length, 'full 512 KiB original returned (old 256 KiB cap would have truncated)')
    assert.equal(diff.modified.length, modified.length, 'full 512 KiB modified returned')
    assert.equal(diff.original, original, 'byte-exact original')
    assert.equal(diff.modified, modified, 'byte-exact modified')
  } finally {
    cleanup()
  }
})

test('diff: echoes the requested view (split/unified) on every kind', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'committed\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'a.txt'), 'committed\nworktree\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    // text kind
    const split = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'a.txt', source: 'unstaged', view: 'split' })
    assert.equal(split.view, 'split', 'text diff echoes split')
    const unified = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'a.txt', source: 'unstaged', view: 'unified' })
    assert.equal(unified.view, 'unified', 'text diff echoes unified')
    // Default (no view) → undefined; the UI falls back to its store default.
    const none = await svc.getDiff({ repositoryId: handle.repositoryId, path: 'a.txt', source: 'unstaged' })
    assert.equal(none.view, undefined, 'omitted view → undefined (UI uses its default)')
  } finally {
    cleanup()
  }
})

// ===========================================================================
// Task 4: diffCachedStat / diffCachedPatch closed operations + collectStagedContext
//
// The AI commit-message proposer MUST only ever see STAGED content. These tests
// prove: (a) the two new GitRunner ops are closed (covered by the allowlist test
// above), (b) collectStagedContext isolates staged from unstaged/untracked,
// (c) secret-path files are excluded (filename only, no patch content), and
// (d) the aggregate 80 KiB / 12,000-line cap truncates overflow.
// ===========================================================================

test('Task 4 diffCachedStat: returns staged stat text; empty when nothing staged', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const runner = new GitRunner()
    // Nothing staged → empty stat.
    let stat = await runner.diffCachedStat(root)
    assert.equal(stat.trim(), '', 'no staged → empty stat')
    // Stage a change → stat mentions the file.
    writeFileSync(path.join(root, 'a.txt'), 'a\nb\n')
    spawnSync('git', ['add', 'a.txt'], { cwd: root })
    stat = await runner.diffCachedStat(root)
    assert.ok(stat.includes('a.txt'), 'staged file appears in stat')
  } finally {
    cleanup()
  }
})

test('Task 4 diffCachedPatch: returns per-file staged patch; head-capped', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const runner = new GitRunner()
    writeFileSync(path.join(root, 'a.txt'), 'a\nb\n')
    spawnSync('git', ['add', 'a.txt'], { cwd: root })
    const { text, truncated } = await runner.diffCachedPatch(root, 'a.txt')
    assert.ok(text.includes('diff --git'), 'patch text present')
    assert.ok(text.includes('+b'), 'added line present')
    assert.equal(truncated, false, 'small patch not truncated')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: NO_STAGED_CHANGES on a clean repo', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    await assert.rejects(
      () => svc.collectStagedContext(handle.repositoryId),
      (e) => e.code === 'NO_STAGED_CHANGES',
      'no staged → NO_STAGED_CHANGES',
    )
  } finally {
    cleanup()
  }
})

test('commit title context is staged-only and excludes patch bodies', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'title-context.txt'), 'TOP_SECRET_PATCH_BODY\n')
    g(['add', 'title-context.txt'])
  })
  try {
    const service = new GitRepositoryService()
    const handle = await service.openRepository(root)
    const context = await service.collectStagedTitleContext(handle.repositoryId)
    assert.match(context.prompt, /title-context\.txt/)
    assert.match(context.prompt, /1 file changed/)
    assert.doesNotMatch(context.prompt, /TOP_SECRET_PATCH_BODY/)
    assert.ok(context.totalBytes <= 16 * 1024)
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: STAGED-ONLY isolation (unstaged + untracked excluded)', async () => {
  if (!GIT) return test.skip('git not installed')
  // Stage a.txt; modify b.txt but DON'T stage it; add c.txt untracked.
  // The prompt MUST contain a.txt's patch and MUST NOT mention b.txt or c.txt.
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    writeFileSync(path.join(root, 'b.txt'), 'b\n')
    g(['add', 'a.txt', 'b.txt'])
    g(['commit', '-q', '-m', 'init'])
    // Now stage a change to a.txt only.
    writeFileSync(path.join(root, 'a.txt'), 'a\nstaged-change\n')
    g(['add', 'a.txt'])
    // b.txt: unstaged modification.
    writeFileSync(path.join(root, 'b.txt'), 'b\nunstaged-change\n')
    // c.txt: untracked (never added).
    writeFileSync(path.join(root, 'c.txt'), 'untracked\n')
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    assert.ok(ctx.prompt.includes('staged-change'), 'staged a.txt patch present')
    assert.equal(ctx.prompt.includes('unstaged-change'), false, 'unstaged b.txt must NOT appear')
    assert.equal(ctx.prompt.includes('untracked'), false, 'untracked c.txt must NOT appear')
    // b.txt and c.txt are not even in the file list (only staged files are listed).
    // a.txt must appear; b.txt/c.txt filenames may appear in the file-list section
    // ONLY if they were staged — they are not, so:
    const fileListSection = ctx.prompt.split('## 文件列表')[1]?.split('## 已暂存 patch')[0] ?? ''
    assert.ok(fileListSection.includes('a.txt'), 'staged a.txt in file list')
    assert.equal(fileListSection.includes('b.txt'), false, 'unstaged b.txt NOT in file list')
    assert.equal(fileListSection.includes('c.txt'), false, 'untracked c.txt NOT in file list')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: secret-path .env excluded (filename only, no content)', async () => {
  if (!GIT) return test.skip('git not installed')
  const secret = 'OPENAI_API_KEY=sk-proj-leak-me-1234567890\n'
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    // Stage a normal change + a .env with a real-looking key.
    writeFileSync(path.join(root, 'a.txt'), 'a\nnormal\n')
    writeFileSync(path.join(root, '.env'), secret)
    g(['add', 'a.txt', '.env'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    assert.ok(ctx.excludedPaths.includes('.env'), '.env in excludedPaths')
    assert.equal(ctx.prompt.includes('sk-proj-leak'), false, 'secret content MUST NOT leak into prompt')
    assert.ok(ctx.prompt.includes('.env'), 'excluded filename still listed')
    assert.ok(ctx.prompt.includes('已排除'), 'excluded note present')
    // The normal file's patch is still present.
    assert.ok(ctx.prompt.includes('normal'), 'normal staged content still present')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: restricted-content (non-secret-path) excluded too', async () => {
  if (!GIT) return test.skip('git not installed')
  // A file named `notes.txt` (NOT a secret path) but containing a PEM block.
  // Defense-in-depth: isRestrictedContent must exclude it.
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD\n-----END PRIVATE KEY-----\n'
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'notes.txt'), pem)
    g(['add', 'notes.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    assert.ok(ctx.excludedPaths.includes('notes.txt'), 'PEM-bearing file excluded by content')
    assert.equal(ctx.prompt.includes('BEGIN PRIVATE KEY'), false, 'PEM content MUST NOT leak')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: secret RENAMED to benign destination excluded via originalPath', async () => {
  if (!GIT) return test.skip('git not installed')
  // Audit regression: a staged rename `secrets/token.json → data/config.json`
  // must be excluded because the ORIGINAL path matches isSecretPath, even
  // though the destination `data/config.json` does not. Without the
  // originalPath check, the secret content would leak into the prompt.
  const secret = 'SUPER_SECRET_TOKEN=sk-leak-me-1234567890\n'
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'keep.txt'), 'a\n')
    g(['add', 'keep.txt'])
    g(['commit', '-q', '-m', 'init'])
    // Create the secret under secrets/, commit it, then rename it to a
    // benign-looking destination and stage the rename.
    spawnSync('mkdir', ['-p', path.join(root, 'secrets')], { cwd: root })
    writeFileSync(path.join(root, 'secrets', 'token.json'), secret)
    g(['add', 'secrets/token.json'])
    g(['commit', '-q', '-m', 'add secret'])
    // Rename + stage (git mv stages the rename in one step).
    spawnSync('mkdir', ['-p', path.join(root, 'data')], { cwd: root })
    g(['mv', 'secrets/token.json', 'data/config.json'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    // The renamed file is excluded (originalPath `secrets/token.json` matched).
    assert.ok(ctx.excludedPaths.includes('data/config.json'), 'renamed secret excluded via originalPath')
    assert.equal(ctx.prompt.includes('sk-leak-me'), false, 'secret content MUST NOT leak after rename')
    assert.equal(ctx.prompt.includes('SUPER_SECRET_TOKEN'), false, 'secret key name MUST NOT leak')
    assert.ok(ctx.prompt.includes('data/config.json'), 'excluded filename still listed')
    assert.ok(ctx.prompt.includes('已排除'), 'excluded note present')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: id_rsa wildcard variant excluded (id_rsa_backup)', async () => {
  if (!GIT) return test.skip('git not installed')
  // Audit regression: `id_rsa_backup` must match isSecretPath (the `id_rsa*`
  // wildcard), not just the exact `id_rsa`/`id_rsa.pub` names.
  const key = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC...leak\n'
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    writeFileSync(path.join(root, 'id_rsa_backup'), key)
    g(['add', 'id_rsa_backup'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    assert.ok(ctx.excludedPaths.includes('id_rsa_backup'), 'id_rsa_backup excluded (wildcard match)')
    assert.equal(ctx.prompt.includes('AAAAB3NzaC1yc2EAAAADAQABAAABgQC'), false, 'SSH key content MUST NOT leak')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: aggregate cap truncates overflow (truncated=true)', async () => {
  if (!GIT) return test.skip('git not installed')
  // Stage two large text files whose combined patches exceed 80 KiB. The
  // aggregate cap must drop the overflow file to filename-only + set truncated.
  const big = 'x'.repeat(60 * 1024) + '\n' // ~60 KiB per file
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'big1.txt'), '')
    writeFileSync(path.join(root, 'big2.txt'), '')
    g(['add', 'big1.txt', 'big2.txt'])
    g(['commit', '-q', '-m', 'init'])
    // Stage large modifications to both.
    writeFileSync(path.join(root, 'big1.txt'), big)
    writeFileSync(path.join(root, 'big2.txt'), big)
    g(['add', 'big1.txt', 'big2.txt'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    assert.ok(ctx.truncated, 'aggregate cap reached → truncated=true')
    assert.ok(ctx.cappedPaths.length >= 1, 'at least one file capped')
    assert.ok(ctx.totalBytes <= 80 * 1024, 'totalBytes respects the 80 KiB cap')
  } finally {
    cleanup()
  }
})

test('Task 4 collectStagedContext: binary file → filename + status only', async () => {
  if (!GIT) return test.skip('git not installed')
  const { root, cleanup } = makeRepo((root, g) => {
    writeFileSync(path.join(root, 'a.txt'), 'a\n')
    g(['add', 'a.txt'])
    g(['commit', '-q', '-m', 'init'])
    // A real binary file (PNG header + random bytes).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(256).fill(0)])
    writeFileSync(path.join(root, 'logo.png'), png)
    g(['add', 'logo.png'])
  })
  try {
    const svc = new GitRepositoryService()
    const handle = await svc.openRepository(root)
    const ctx = await svc.collectStagedContext(handle.repositoryId)
    // The binary file is noted but no binary patch content is in the prompt.
    assert.ok(ctx.prompt.includes('logo.png'), 'binary filename present')
    assert.ok(ctx.prompt.includes('二进制'), 'binary note present')
  } finally {
    cleanup()
  }
})
