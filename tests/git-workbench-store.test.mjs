// Store-level regression test for the Git Workbench (Task 2).
//
// Proves the separation the UI relies on:
//   - selectFile (the FileRow click handler) calls gitGetDiff and NEVER calls
//     gitStageFiles / gitUnstageFiles. Clicking a row must not stage anything.
//   - stage / unstage (the FileRow action-button handlers) call gitStageFiles /
//     gitUnstageFiles respectively, and NOT gitGetDiff (except the documented
//     re-select-after-stage path, which IS a gitGetDiff — but only AFTER the
//     stage call, never as the primary action).
//
// The store is a TS module that imports zustand + type-only DTOs. We transpile
// it with esbuild to a temp ESM file (type imports erased), stub
// globalThis.window.raintool with call-tracking fakes, and drive the store.
//
// Run:  node --test tests/git-workbench-store.test.mjs

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Transpile src/store/git-workbench.ts → temp ESM. Type-only imports
// (../../electron/git-types) are erased by esbuild; zustand resolves from
// node_modules. The store reads window.raintool lazily inside actions, so we
// stub globalThis.window before importing.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'raintool-git-store-'))
const outPath = path.join(tmpDir, 'git-workbench-store.mjs')
await build({
  entryPoints: ['src/store/git-workbench.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: outPath,
  // zustand is a real runtime dep; bundle it in. git-types is type-only.
  external: [],
  logLevel: 'silent',
})

/** Build a call-tracking fake for window.raintool.git* . */
function makeFakeRaintool({ diff, statusAfterStage, identity, stagedStatus, proposal, proposeError }) {
  const calls = { gitGetDiff: [], gitStageFiles: [], gitUnstageFiles: [], gitRefreshStatus: [], gitGetIdentity: [], gitCommit: [], gitProposeCommitMessage: [], gitListBranches: [], gitSwitchBranch: [] }
  const normalSummary = { root: '/r', displayName: 'r', branch: 'main', headSha: 's', upstream: null, ahead: 0, behind: 0, isDetached: false, operation: 'normal' }
  const emptyStatus = { repository: normalSummary, staged: [], unstaged: [], untracked: [] }
  const baseStatus = stagedStatus ?? emptyStatus
  const api = {
    gitGetDiff: async (req) => { calls.gitGetDiff.push(req); return diff ?? { kind: 'text', original: 'a', modified: 'b', summary: 'x' } },
    gitStageFiles: async (repoId, paths) => { calls.gitStageFiles.push({ repoId, paths }); return statusAfterStage ?? baseStatus },
    gitUnstageFiles: async (repoId, paths) => { calls.gitUnstageFiles.push({ repoId, paths }); return statusAfterStage ?? baseStatus },
    gitRefreshStatus: async (repoId) => { calls.gitRefreshStatus.push(repoId); return baseStatus },
    gitGetIdentity: async (repoId) => { calls.gitGetIdentity.push(repoId); return identity ?? { name: 'Test', email: 'test@example.com' } },
    gitCommit: async (input) => { calls.gitCommit.push(input); return { headSha: 'sha123', status: baseStatus } },
    // Task 4: AI commit-message proposal. Returns the injectable `proposal`
    // (subject/body/rationale + transparency metadata), or throws the injectable
    // `proposeError` (an Error with a [git:CODE] message) to exercise the
    // fail-safe path (no partial fill of commitSubject/commitBody).
    gitProposeCommitMessage: async (req) => {
      calls.gitProposeCommitMessage.push(req)
      if (proposeError) throw proposeError
      return proposal ?? {
        subject: 'feat: AI-proposed subject',
        body: 'AI-proposed body',
        rationale: 'based on staged diff',
        excludedPaths: ['.env'],
        cappedPaths: [],
        totalBytes: 1234,
        totalLines: 42,
        truncated: false,
      }
    },
    gitChooseRepository: async () => null,
    gitOpenRepository: async () => ({ repositoryId: 'repo_test', root: '/r', displayName: 'r', openedAt: 0 }),
    gitListRecentRepositories: async () => [],
    gitListBranches: async (repositoryId) => { calls.gitListBranches.push(repositoryId); return { branches: ['main', 'feature'], current: 'main' } },
    gitSwitchBranch: async (input) => {
      calls.gitSwitchBranch.push(input)
      return { ...baseStatus, repository: { ...baseStatus.repository, branch: input.branch } }
    },
  }
  return { calls, api }
}

/** Build a status with one staged file (for canCommit tests). */
function statusWithOneStaged(operation = 'normal') {
  return {
    repository: { root: '/r', displayName: 'r', branch: 'main', headSha: 's', upstream: null, ahead: 0, behind: 0, isDetached: false, operation },
    staged: [{ path: 'a.txt', indexStatus: 'M', worktreeStatus: '' }],
    unstaged: [],
    untracked: [],
  }
}

test('teardown', () => { /* placeholder so tmpDir cleanup runs in after() */ })

test.after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

test('selectFile (FileRow click) fetches diff and never stages', async () => {
  const { calls, api } = makeFakeRaintool({})
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  // Seed an open repo so selectFile has a repositoryId.
  await useGitWorkbench.getState().openRepository('/r')

  // Simulate a FileRow click on an unstaged file.
  await useGitWorkbench.getState().selectFile({ path: 'src/a.ts', source: 'unstaged' })

  assert.equal(calls.gitGetDiff.length, 1, 'click must fetch exactly one diff')
  assert.deepEqual(calls.gitGetDiff[0], { repositoryId: 'repo_test', path: 'src/a.ts', source: 'unstaged', view: 'unified' })
  assert.equal(calls.gitStageFiles.length, 0, 'click must NOT stage')
  assert.equal(calls.gitUnstageFiles.length, 0, 'click must NOT unstage')

  // The store must have recorded the selection + the fetched diff.
  const st = useGitWorkbench.getState()
  assert.equal(st.selection?.path, 'src/a.ts')
  assert.equal(st.selection?.source, 'unstaged')
  assert.equal(st.diffLoading, false)
  assert.ok(st.diff, 'diff must be populated after the click')
})

test('stage (action button) calls gitStageFiles, not gitGetDiff as primary action', async () => {
  const { calls, api } = makeFakeRaintool({})
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')

  // Simulate the stage action-button click on one file.
  await useGitWorkbench.getState().stage(['src/a.ts'])

  assert.equal(calls.gitStageFiles.length, 1, 'action button must stage')
  assert.deepEqual(calls.gitStageFiles[0], { repoId: 'repo_test', paths: ['src/a.ts'] })
  // The stage action may re-fetch the diff for the (now-staged) selected file,
  // but ONLY if there was a prior selection whose source flipped. With no prior
  // selection, stage must NOT call gitGetDiff.
  assert.equal(calls.gitGetDiff.length, 0, 'stage with no prior selection must not fetch a diff')
  assert.equal(calls.gitUnstageFiles.length, 0, 'stage must not unstage')
})

test('unstage (action button) calls gitUnstageFiles', async () => {
  const { calls, api } = makeFakeRaintool({})
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')

  await useGitWorkbench.getState().unstage(['src/a.ts'])

  assert.equal(calls.gitUnstageFiles.length, 1)
  assert.deepEqual(calls.gitUnstageFiles[0], { repoId: 'repo_test', paths: ['src/a.ts'] })
  assert.equal(calls.gitStageFiles.length, 0)
})

test('batch stage forwards every selected path in one IPC call', async () => {
  const { calls, api } = makeFakeRaintool({})
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().stage(['a.txt', 'b.txt', 'new.txt'])
  assert.deepEqual(calls.gitStageFiles.at(-1), { repoId: 'repo_test', paths: ['a.txt', 'b.txt', 'new.txt'] })
})

test('duplicated Git tabs clone once and then keep independent workspace state', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged() })
  globalThis.window = { raintool: api }
  const { getGitWorkbenchStore, cloneGitWorkbenchStore } = await import(outPath + '?t=' + Date.now())
  const original = getGitWorkbenchStore('tab-original')
  original.setState({
    handle: { repositoryId: 'repo_original', root: '/original', displayName: 'original', openedAt: 1 },
    status: statusWithOneStaged(),
    commitSubject: 'feat: original draft',
    branches: ['main', 'feature'],
  })

  cloneGitWorkbenchStore('tab-original', 'tab-copy')
  const copy = getGitWorkbenchStore('tab-copy')
  assert.notEqual(original, copy, 'each tab owns a distinct Zustand store')
  assert.equal(copy.getState().handle?.root, '/original', 'copy starts from the same repository snapshot')
  assert.equal(copy.getState().commitSubject, 'feat: original draft')

  copy.setState({
    handle: { repositoryId: 'repo_other', root: '/other', displayName: 'other', openedAt: 2 },
    status: null,
    commitSubject: 'fix: copy-only draft',
    branches: ['develop'],
  })

  assert.equal(original.getState().handle?.root, '/original', 'changing repository in the copy does not change the original')
  assert.equal(original.getState().commitSubject, 'feat: original draft', 'commit drafts are isolated')
  assert.deepEqual(original.getState().branches, ['main', 'feature'], 'branch lists are isolated')
})

test('Git tab persistence reopens its repository with a fresh runtime handle', async () => {
  const { calls, api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged() })
  globalThis.window = { raintool: api }
  const {
    getGitWorkbenchStore,
    serializeGitWorkbenchStore,
    restoreGitWorkbenchStore,
  } = await import(outPath + '?t=' + Date.now())

  const beforeRestart = getGitWorkbenchStore('before-restart')
  beforeRestart.setState({
    handle: { repositoryId: 'expired_runtime_token', root: '/saved/repo', displayName: 'repo', openedAt: 1 },
    commitSubject: 'fix: preserve each Git tab',
    diffView: 'split',
    selection: { path: 'a.txt', source: 'staged' },
  })
  const persisted = serializeGitWorkbenchStore(beforeRestart)
  assert.equal(persisted.includes('expired_runtime_token'), false, 'opaque repositoryId must never be persisted')

  const afterRestart = getGitWorkbenchStore('after-restart')
  await restoreGitWorkbenchStore(afterRestart, persisted)
  const restored = afterRestart.getState()
  assert.equal(restored.handle?.repositoryId, 'repo_test', 'repository is reopened to allocate a fresh token')
  assert.equal(restored.commitSubject, 'fix: preserve each Git tab')
  assert.equal(restored.diffView, 'split')
  assert.deepEqual(restored.selection, { path: 'a.txt', source: 'staged' })
  assert.equal(calls.gitRefreshStatus.at(-1), 'repo_test')
  assert.equal(calls.gitGetDiff.at(-1)?.path, 'a.txt')
})

test('switchBranch uses a typed branch request and refreshes store status', async () => {
  const { calls, api } = makeFakeRaintool({})
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().switchBranch('feature')
  assert.deepEqual(calls.gitSwitchBranch, [{ repositoryId: 'repo_test', branch: 'feature' }])
  assert.equal(useGitWorkbench.getState().status.repository.branch, 'feature')
})

test('stage after a selection re-fetches diff (source flips to staged), but stage is the primary action', async () => {
  const { calls, api } = makeFakeRaintool({})
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  // User clicks an unstaged file first (selects it), then clicks the stage button.
  await useGitWorkbench.getState().selectFile({ path: 'src/a.ts', source: 'unstaged' })
  calls.gitGetDiff.length = 0 // reset after the select-driven fetch

  await useGitWorkbench.getState().stage(['src/a.ts'])

  // Primary action is stage:
  assert.equal(calls.gitStageFiles.length, 1, 'stage must be called first')
  // Because the selected file's source flips unstaged→staged, the store
  // re-fetches the diff. This gitGetDiff is a FOLLOW-UP, not the primary action.
  assert.equal(calls.gitGetDiff.length, 1, 'follow-up diff re-fetch after stage')
  assert.equal(calls.gitGetDiff[0].source, 'staged', 're-fetched diff is for the staged side')
  assert.equal(calls.gitUnstageFiles.length, 0)
})

// ===========================================================================
// canCommit identity-requirement (audit correction 2, plan §2.6)
// The commit button must be DISABLED when identity is unloaded or missing
// name/email, even if staged files + subject are present. The backend gate
// (service.commit) re-checks; this is the UX + defense-in-depth layer.
// ===========================================================================

test('canCommit: false when identity is unloaded (null)', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged() })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  // openRepository calls loadIdentity() but we haven't awaited it; force the
  // null state to simulate "identity not yet loaded".
  useGitWorkbench.setState({ identity: null })
  useGitWorkbench.getState().setCommitSubject('add a')
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'null identity → commit disabled')
})

test('canCommit: false when identity loaded but name is null', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged(), identity: { name: null, email: 't@t.com' } })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('add a')
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'name=null → commit disabled (identity incomplete)')
})

test('canCommit: false when identity loaded but email is null', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged(), identity: { name: 'Test', email: null } })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('add a')
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'email=null → commit disabled (identity incomplete)')
})

test('canCommit: false when no staged files (even with full identity + subject)', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: { repository: { root: '/r', displayName: 'r', branch: 'main', headSha: 's', upstream: null, ahead: 0, behind: 0, isDetached: false, operation: 'normal' }, staged: [], unstaged: [], untracked: [] } })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('add a')
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'no staged files → commit disabled')
})

test('canCommit: false when subject empty (even with full identity + staged)', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged() })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('   ')
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'whitespace-only subject → commit disabled')
})

test('canCommit: false during a merge in progress (even with identity + staged + subject)', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged('merge') })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('merge commit')
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'merge in progress → commit disabled')
})

test('canCommit: true only when ALL conditions met (identity + staged + subject + normal op)', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged('normal') })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('add a')
  assert.equal(useGitWorkbench.getState().canCommit(), true, 'all conditions met → commit enabled')
})

test('canCommit: false while a commit is in flight (committing flag)', async () => {
  const { api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged('normal') })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  await useGitWorkbench.getState().loadIdentity()
  useGitWorkbench.getState().setCommitSubject('add a')
  assert.equal(useGitWorkbench.getState().canCommit(), true, 'enabled before commit starts')
  useGitWorkbench.setState({ committing: true })
  assert.equal(useGitWorkbench.getState().canCommit(), false, 'committing flag → commit disabled (no double-submit)')
})

// ===========================================================================
// Task 4: proposeCommitMessage store action — editable handoff + fail-safe.
//
// The store action calls gitProposeCommitMessage with ONLY repositoryId +
// modelProfileId (no cwd/argv/paths/diff). On success it writes the proposal's
// subject+body into the existing commit inputs (the user edits + clicks 提交
// manually — NEVER auto-commit). On ANY error it leaves commitSubject/commitBody
// UNTOUCHED (no partial fill) and sets error/errorCode. Guards: no staged files
// → early return, no IPC call.
// ===========================================================================

test('Task 4 proposeCommitMessage: success → subject only, NO gitCommit call (editable handoff)', async () => {
  const { calls, api } = makeFakeRaintool({
    stagedStatus: statusWithOneStaged('normal'),
    proposal: {
      subject: 'feat: add new endpoint',
      body: 'POST /api/widgets\n\nCreates a widget.',
      rationale: 'staged controller + route',
      excludedPaths: ['.env'],
      cappedPaths: ['big.bin'],
      totalBytes: 500,
      totalLines: 20,
      truncated: false,
    },
  })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')

  // Pre-existing draft must be OVERWRITTEN by the proposal on success.
  useGitWorkbench.getState().setCommitSubject('old draft')
  useGitWorkbench.getState().setCommitBody('old body')

  await useGitWorkbench.getState().proposeCommitMessage('profile_1')

  // The IPC was called with ONLY repositoryId + modelProfileId.
  assert.equal(calls.gitProposeCommitMessage.length, 1, 'exactly one IPC call')
  assert.deepEqual(calls.gitProposeCommitMessage[0], { repositoryId: 'repo_test', modelProfileId: 'profile_1' })
  // The proposal filled the commit inputs (editable handoff).
  const s = useGitWorkbench.getState()
  assert.equal(s.commitSubject, 'feat: add new endpoint')
  assert.equal(s.commitBody, '', 'AI proposal intentionally leaves commit body empty')
  assert.equal(s.proposing, false, 'proposing flag cleared')
  assert.deepEqual(s.proposalMeta, {
    excludedPaths: ['.env'],
    cappedPaths: ['big.bin'],
    totalBytes: 500,
    totalLines: 20,
    truncated: false,
  })
  // CRITICAL: the proposal did NOT auto-commit. gitCommit was never called.
  assert.equal(calls.gitCommit.length, 0, 'NEVER auto-commits — user must click 提交 manually')
})

test('Task 4 proposeCommitMessage: error → commitSubject/commitBody UNTOUCHED (no partial fill)', async () => {
  const { calls, api } = makeFakeRaintool({
    stagedStatus: statusWithOneStaged('normal'),
    proposeError: new Error('[git:AI_SCHEMA_INVALID] 模型输出不符合规范'),
  })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')
  useGitWorkbench.getState().setCommitSubject('my draft')
  useGitWorkbench.getState().setCommitBody('my body')

  await useGitWorkbench.getState().proposeCommitMessage('profile_1')

  const s = useGitWorkbench.getState()
  assert.equal(s.proposing, false, 'proposing flag cleared even on error')
  // Fail-safe: the user's in-progress draft is preserved (no partial fill).
  assert.equal(s.commitSubject, 'my draft', 'subject untouched on error')
  assert.equal(s.commitBody, 'my body', 'body untouched on error')
  // The structured error is surfaced for the UI.
  assert.equal(s.errorCode, 'AI_SCHEMA_INVALID')
  assert.ok(s.error?.includes('模型输出不符合规范'), 'error message surfaced')
  // And no proposalMeta was set (no misleading "上次：…" banner).
  assert.equal(s.proposalMeta, null)
})

test('Task 4 proposeCommitMessage: no staged files → early return, NO IPC call', async () => {
  const { calls, api } = makeFakeRaintool({
    stagedStatus: {
      repository: { root: '/r', displayName: 'r', branch: 'main', headSha: 's', upstream: null, ahead: 0, behind: 0, isDetached: false, operation: 'normal' },
      staged: [],
      unstaged: [],
      untracked: [],
    },
  })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')

  await useGitWorkbench.getState().proposeCommitMessage('profile_1')

  // Guard fired: no IPC call, no state churn.
  assert.equal(calls.gitProposeCommitMessage.length, 0, 'no IPC call when nothing staged')
  assert.equal(useGitWorkbench.getState().proposing, false)
  assert.equal(useGitWorkbench.getState().proposalMeta, null)
})

test('Task 4 proposeCommitMessage: no modelProfileId → error, NO IPC call', async () => {
  const { calls, api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged('normal') })
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')

  await useGitWorkbench.getState().proposeCommitMessage(null)

  // Defense-in-depth: the UI disables the button, but the store also guards.
  assert.equal(calls.gitProposeCommitMessage.length, 0, 'no IPC call without a profile')
  const s = useGitWorkbench.getState()
  assert.equal(s.errorCode, 'AI_UNAVAILABLE')
  assert.ok(s.error?.includes('Provider'), 'clear guidance to configure a provider')
  assert.equal(s.proposing, false)
})

test('Task 4 proposeCommitMessage: re-entrancy guard — proposing flag blocks double-submit', async () => {
  const { calls, api } = makeFakeRaintool({ stagedStatus: statusWithOneStaged('normal') })
  // Make the proposal slow so we can observe the in-flight flag. Keep call
  // tracking so we can assert the second call is a no-op.
  let resolveProposal
  api.gitProposeCommitMessage = (req) => {
    calls.gitProposeCommitMessage.push(req)
    return new Promise((resolve) => { resolveProposal = resolve })
  }
  globalThis.window = { raintool: api }
  const { useGitWorkbench } = await import(outPath + '?t=' + Date.now())
  await useGitWorkbench.getState().openRepository('/r')

  const first = useGitWorkbench.getState().proposeCommitMessage('profile_1')
  assert.equal(useGitWorkbench.getState().proposing, true, 'proposing set during in-flight call')
  // Second call while the first is pending → no-op guard.
  await useGitWorkbench.getState().proposeCommitMessage('profile_1')
  assert.equal(calls.gitProposeCommitMessage.length, 1, 'second call is a no-op while proposing')
  // Resolve + await the first.
  resolveProposal({
    subject: 's', body: 'b', rationale: 'r',
    excludedPaths: [], cappedPaths: [], totalBytes: 0, totalLines: 0, truncated: false,
  })
  await first
  assert.equal(useGitWorkbench.getState().proposing, false, 'flag cleared after resolution')
})
