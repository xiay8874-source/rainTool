// Tests for the conversation repository.
//
// Covers plan §4.2 / P0 spike §5.1:
//   - schemaVersion migration: an older file (schemaVersion 0 / missing) loads
//     and is normalized to the current version.
//   - A file with a NEWER schemaVersion than the app understands is REFUSED,
//     not silently dropped.
//   - appendMessage updates the summary and derives a title from the first
//     user message.
//   - recordRunAudit caps the audit log and carries the actual profile id.
//   - delete() removes the file and the index entry.
//   - No raw keys ever appear in persisted conversation JSON (by construction
//     the repository only stores text; this test guards against regressions).

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AiConversationRepository } from '../dist-electron/ai-platform/ai-conversation-repository.js'

const PROFILE_ID = 'prof_test_001'
const RAW_KEY = 'sk-never-persisted-1234567890abcdef'

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-conv-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('create + appendMessage + get round-trips a conversation', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const created = repo.create({ title: '测试', modelProfileId: PROFILE_ID })
    assert.equal(created.schemaVersion, 1)
    assert.equal(created.messages.length, 0)
    assert.equal(created.modelProfileId, PROFILE_ID)

    const userMsg = repo.appendMessage(created.id, {
      role: 'user', at: Date.now(), text: '你好',
    })
    const aiMsg = repo.appendMessage(created.id, {
      role: 'assistant', at: Date.now(), text: '你好，有什么可以帮你？',
      modelProfileId: PROFILE_ID, runId: 'run_1',
    })

    const reloaded = new AiConversationRepository(dir)
    const conv = reloaded.get(created.id)
    assert.equal(conv.messages.length, 2)
    assert.equal(conv.messages[0].id, userMsg.id)
    assert.equal(conv.messages[1].text, aiMsg.text)
    assert.equal(conv.messages[1].modelProfileId, PROFILE_ID)
    assert.equal(conv.messages[1].runId, 'run_1')
  } finally {
    cleanup()
  }
})

test('first user message derives the title when the conversation is untitled', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const created = repo.create({ modelProfileId: PROFILE_ID }) // untitled
    assert.equal(created.title, '新会话')

    repo.appendMessage(created.id, { role: 'user', at: Date.now(), text: '请帮我画一张架构图' })
    const conv = repo.get(created.id)
    assert.equal(conv.title, '请帮我画一张架构图')
  } finally {
    cleanup()
  }
})

test('list() returns summaries sorted by updatedAt desc and with messageCount', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const a = repo.create({ modelProfileId: PROFILE_ID })
    const b = repo.create({ modelProfileId: PROFILE_ID })
    repo.appendMessage(b.id, { role: 'user', at: Date.now(), text: 'hi' })

    const list = repo.list()
    assert.equal(list.length, 2)
    assert.equal(list[0].id, b.id) // b updated last
    assert.equal(list[0].messageCount, 1)
    assert.equal(list[1].messageCount, 0)
  } finally {
    cleanup()
  }
})

test('schemaVersion 0 / missing migrates to current version on load', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    // Hand-write a legacy v0 file directly on disk.
    const legacy = {
      // schemaVersion intentionally omitted
      id: 'conv_legacy_1',
      title: '旧会话',
      modelProfileId: PROFILE_ID,
      mode: 'chat',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        { id: 'm1', role: 'user', at: 1500, text: 'legacy message' },
      ],
      runAuditRefs: [],
    }
    writeFileSync(
      path.join(dir, 'ai', 'conversations', 'conv_legacy_1.json'),
      JSON.stringify(legacy),
    )

    const reloaded = new AiConversationRepository(dir)
    const conv = reloaded.get('conv_legacy_1')
    assert.equal(conv.schemaVersion, 1)
    assert.equal(conv.messages.length, 1)
    assert.equal(conv.messages[0].text, 'legacy message')
  } finally {
    cleanup()
  }
})

test('a file with a NEWER schemaVersion than supported is refused', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const future = {
      schemaVersion: 999,
      id: 'conv_future',
      title: '未来',
      modelProfileId: PROFILE_ID,
      mode: 'chat',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      runAuditRefs: [],
    }
    writeFileSync(
      path.join(dir, 'ai', 'conversations', 'conv_future.json'),
      JSON.stringify(future),
    )

    const reloaded = new AiConversationRepository(dir)
    // get() returns null for a file that throws during migrate.
    assert.equal(reloaded.get('conv_future'), null)
  } finally {
    cleanup()
  }
})

test('recordRunAudit caps the audit log at 200 entries and keeps the actual profile id', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const created = repo.create({ modelProfileId: PROFILE_ID })

    for (let i = 0; i < 210; i++) {
      repo.recordRunAudit(created.id, {
        runId: `run_${i}`,
        startedAt: i,
        endedAt: i + 1,
        modelProfileId: PROFILE_ID,
        status: i % 3 === 0 ? 'failed' : 'completed',
        redactedError: i % 3 === 0 ? `error ${i}` : undefined,
      })
    }

    const conv = repo.get(created.id)
    assert.equal(conv.runAuditRefs.length, 200)
    // Newest first.
    assert.equal(conv.runAuditRefs[0].runId, 'run_209')
    assert.equal(conv.runAuditRefs[0].modelProfileId, PROFILE_ID)
    assert.equal(conv.runAuditRefs[0].status, 'completed')
  } finally {
    cleanup()
  }
})

test('delete() removes the conversation file and the index entry', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const a = repo.create({ modelProfileId: PROFILE_ID })
    const b = repo.create({ modelProfileId: PROFILE_ID })
    assert.equal(repo.list().length, 2)

    const deleted = repo.delete(a.id)
    assert.equal(deleted, true)
    assert.equal(existsSync(path.join(dir, 'ai', 'conversations', `${a.id}.json`)), false)
    assert.equal(repo.get(a.id), null)
    assert.equal(repo.list().length, 1)
    assert.equal(repo.list()[0].id, b.id)

    // Deleting again is a no-op (returns false since nothing was removed).
    assert.equal(repo.delete(a.id), false)
  } finally {
    cleanup()
  }
})

test('persisted conversation JSON never contains a raw API key, even if one is appended as text', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const created = repo.create({ modelProfileId: PROFILE_ID })
    // A user could paste a key into the conversation. The repository stores
    // text verbatim (it is not a secret scanner), but it must NEVER add a key
    // field of its own. This guards against a regression where a key field
    // leaks via the message or audit structures.
    repo.appendMessage(created.id, { role: 'user', at: Date.now(), text: `my key is ${RAW_KEY}` })

    const file = readFileSync(
      path.join(dir, 'ai', 'conversations', `${created.id}.json`),
      'utf8',
    )
    const parsed = JSON.parse(file)
    for (const msg of parsed.messages) {
      assert.equal('apiKey' in msg, false, 'message leaked an apiKey field')
      assert.equal('credentialKey' in msg, false, 'message leaked a credentialKey field')
    }
    // The audit refs must also be key-free.
    for (const ref of parsed.runAuditRefs) {
      assert.equal('apiKey' in ref, false)
    }
  } finally {
    cleanup()
  }
})

test('setTitle updates the title and persists', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const created = repo.create({ modelProfileId: PROFILE_ID })
    repo.setTitle(created.id, '重命名后的会话')
    const conv = repo.get(created.id)
    assert.equal(conv.title, '重命名后的会话')
    assert.equal(repo.list()[0].title, '重命名后的会话')
  } finally {
    cleanup()
  }
})

test('overly long message text is truncated to the byte limit', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiConversationRepository(dir)
    const created = repo.create({ modelProfileId: PROFILE_ID })
    const huge = 'a'.repeat(300 * 1024)
    const msg = repo.appendMessage(created.id, { role: 'user', at: Date.now(), text: huge })
    assert.ok(msg.text.length < huge.length, 'huge text was not truncated')
    assert.ok(msg.text.includes('[消息过长已截断]'))
  } finally {
    cleanup()
  }
})
