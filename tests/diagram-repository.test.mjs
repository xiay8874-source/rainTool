import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DiagramConflictError,
  DiagramRepository,
} from '../dist-electron/diagram-repository.js'

const XML_1 = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>'
const XML_2 = XML_1.replace('value="A"', 'value="B"')

test('diagram repository persists documents, revisions, metadata and conflicts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'raintool-diagram-repository-'))
  try {
    const repository = new DiagramRepository(directory)
    const created = repository.create({
      title: '架构图',
      xml: XML_1,
      source: 'codex',
      sourceClient: 'test',
      tags: ['architecture'],
    })
    assert.equal(created.revision, 1)
    assert.equal(repository.list().total, 1)

    const updated = repository.update({
      id: created.id,
      xml: XML_2,
      favorite: true,
      expectedRevision: 1,
    })
    assert.equal(updated.revision, 2)
    assert.equal(updated.favorite, true)
    assert.equal(repository.listRevisions(created.id)[0].revision, 1)

    assert.throws(
      () => repository.update({ id: created.id, title: '过期写入', expectedRevision: 1 }),
      (error) => error instanceof DiagramConflictError && error.current.revision === 2,
    )

    const duplicate = repository.duplicate({ id: created.id })
    assert.notEqual(duplicate.id, created.id)
    assert.equal(duplicate.xml, XML_2)
    assert.match(duplicate.title, /副本/)

    const restored = repository.restoreRevision(created.id, 1, 2)
    assert.equal(restored.revision, 3)
    assert.equal(restored.xml, XML_1)

    const reloaded = new DiagramRepository(directory)
    assert.equal(reloaded.require(created.id).revision, 3)
    assert.equal(reloaded.require(created.id).xml, XML_1)
    assert.equal(reloaded.delete(duplicate.id), true)
    assert.equal(reloaded.list().total, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('legacy migration is idempotent and never imports chat content', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'raintool-diagram-legacy-'))
  try {
    const repository = new DiagramRepository(directory)
    const input = {
      legacySessionId: 'legacy-1',
      title: '旧图纸',
      xml: XML_1,
      createdAt: 100,
      updatedAt: 200,
    }
    assert.deepEqual(repository.migrateLegacy([input]).imported, 1)
    assert.deepEqual(repository.migrateLegacy([input]).skipped, 1)
    const document = repository.list().items[0]
    assert.equal(document.source, 'legacy')
    assert.equal(document.createdAt, 100)
    assert.equal(document.updatedAt, 200)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
