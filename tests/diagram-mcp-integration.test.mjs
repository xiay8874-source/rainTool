import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { DiagramBridgeServer } from '../dist-electron/diagram-bridge-server.js'
import { DiagramRepository } from '../dist-electron/diagram-repository.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MCP_ENTRY = path.join(ROOT, 'build', 'raintool-mcp', 'index.cjs')
const INITIAL_XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Initial" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>'
const LARGE_INITIAL_XML = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${Array.from({ length: 9 }, (_, index) => `<mxCell id="node-${index}" value="Node ${index}" vertex="1" parent="1"><mxGeometry x="${40 + index * 150}" y="40" width="120" height="60" as="geometry"/></mxCell>`).join('')}</root></mxGraphModel>`

class McpProcess {
  constructor(authFile) {
    this.child = spawn(process.execPath, [MCP_ENTRY, '--client', 'codex'], {
      cwd: ROOT,
      env: { ...process.env, RAINTOOL_MCP_AUTH_FILE: authFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.nextId = 1
    this.pending = new Map()
    this.stdout = ''
    this.stderr = ''
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk.toString()))
    this.child.on('error', (error) => this.rejectAll(error))
    this.child.on('exit', (code) => {
      if (this.pending.size) this.rejectAll(new Error(`MCP exited with ${code}: ${this.stderr}`))
    })
  }

  handleStdout(chunk) {
    this.stdout += chunk
    const lines = this.stdout.split('\n')
    this.stdout = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}; stderr: ${this.stderr}`))
      }, 10_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raintool-integration-test', version: '1.0.0' },
    })
    this.notify('notifications/initialized')
  }

  async call(name, args = {}) {
    const result = await this.callResult(name, args)
    assert.equal(result.isError, undefined, result.content?.[0]?.text)
    return result
  }

  callResult(name, args = {}) {
    return this.request('tools/call', { name, arguments: args })
  }

  stop() {
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }
}

test('MCP creates, reads and safely edits the same persistent RainTool diagram', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'raintool-mcp-integration-'))
  const repository = new DiagramRepository(directory)
  const bridge = new DiagramBridgeServer({
    dataDir: directory,
    repository,
    port: 0,
    getActiveDiagramId: () => null,
    openDiagram: () => {},
    exportDiagram: async () => { throw new Error('not used in this test') },
    onChanged: () => {},
    onDeleted: () => {},
  })
  let mcp
  try {
    await bridge.start()
    mcp = new McpProcess(path.join(directory, 'mcp-auth.json'))
    await mcp.initialize()
    await mcp.call('start_session', { title: 'Codex 实时图纸' })
    const oneShot = await mcp.callResult('create_new_diagram', { xml: LARGE_INITIAL_XML, stage: 'complete' })
    assert.equal(oneShot.isError, true)
    assert.match(oneShot.content[0].text, /REJECTED_LARGE_INITIAL_DIAGRAM/)
    assert.match(oneShot.content[0].text, /Do not retry create_new_diagram/)
    assert.match(oneShot.content[0].text, /inspect_diagram, preview_diagram, then finalize_diagram/)
    await mcp.call('create_new_diagram', { xml: INITIAL_XML })
    const before = await mcp.call('get_diagram')
    assert.match(before.content[0].text, /value="Initial"/)
    await mcp.call('edit_diagram', {
      operations: [{
        operation: 'update',
        cell_id: '2',
        new_xml: '<mxCell id="2" value="Edited by Codex" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>',
      }],
    })
    const list = repository.list()
    assert.equal(list.total, 1)
    assert.equal(list.items[0].source, 'codex')
    assert.match(repository.require(list.items[0].id).xml, /Edited by Codex/)

    const output = path.join(directory, 'export.drawio')
    await mcp.call('export_diagram', { path: output })
    assert.match(readFileSync(output, 'utf8'), /Edited by Codex/)
  } finally {
    mcp?.stop()
    await bridge.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('MCP supports official multi-page editing and blocks completion until inspection passes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'raintool-mcp-quality-'))
  const repository = new DiagramRepository(directory)
  const bridge = new DiagramBridgeServer({
    dataDir: directory,
    repository,
    port: 0,
    getActiveDiagramId: () => null,
    openDiagram: () => {},
    exportDiagram: async () => { throw new Error('not used in this test') },
    onChanged: () => {},
    onDeleted: () => {},
  })
  let mcp
  try {
    await bridge.start()
    mcp = new McpProcess(path.join(directory, 'mcp-auth.json'))
    await mcp.initialize()
    await mcp.call('start_session', {
      title: '多页质量图纸',
      requirements: '用两个页面分别表达主流程和异常流程，图中不能重叠。',
    })
    await mcp.call('create_new_diagram', { xml: INITIAL_XML })
    await mcp.call('add_page', { name: '异常流程' })
    const pages = await mcp.call('list_pages')
    assert.match(pages.content[0].text, /异常流程/)

    await mcp.call('get_diagram', { page_name: '异常流程' })
    await mcp.call('edit_diagram', {
      page_name: '异常流程',
      operations: [{
        operation: 'add',
        cell_id: 'exception',
        new_xml: '<mxCell id="exception" value="Retry" vertex="1" parent="1"><mxGeometry x="260" y="60" width="120" height="60" as="geometry"/></mxCell>',
      }],
    })

    const inspection = await mcp.call('inspect_diagram')
    const report = JSON.parse(inspection.content[0].text)
    assert.equal(report.passed, true)
    assert.equal(report.summary.pages, 2)
    await mcp.call('finalize_diagram')

    await mcp.call('get_diagram')
    await mcp.call('edit_diagram', {
      operations: [{
        operation: 'add',
        cell_id: 'overlap',
        new_xml: '<mxCell id="overlap" value="Overlap" vertex="1" parent="1"><mxGeometry x="45" y="45" width="120" height="60" as="geometry"/></mxCell>',
      }],
    })
    const overlapInspection = await mcp.call('inspect_diagram')
    assert.match(overlapInspection.content[0].text, /OVERLAP/)
    const finalization = await mcp.callResult('finalize_diagram')
    assert.equal(finalization.isError, true)
    assert.match(finalization.content[0].text, /error/)
    const waivedFinalization = await mcp.callResult('finalize_diagram', { allow_warnings: true })
    assert.equal(waivedFinalization.isError, true)
    assert.match(waivedFinalization.content[0].text, /error/)
  } finally {
    mcp?.stop()
    await bridge.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
