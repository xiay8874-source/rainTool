#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const command = process.env.RAINTOOL_MCP_COMMAND || '/Applications/RainTool.app/Contents/Resources/raintool-mcp/raintool-mcp'
const output = path.resolve(process.argv[2] || '/tmp/raintool-mcp-smoke.png')
const existingDiagramId = process.env.RAINTOOL_SMOKE_DIAGRAM_ID
const diagramXml = `<mxGraphModel grid="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="title" value="RainTool 实时绘图链路" style="text;html=1;align=center;verticalAlign=middle;fontSize=24;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="220" y="30" width="420" height="50" as="geometry"/></mxCell>
    <mxCell id="zcode" value="ZCode / Codex" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=16;" vertex="1" parent="1"><mxGeometry x="60" y="160" width="180" height="80" as="geometry"/></mxCell>
    <mxCell id="mcp" value="RainTool MCP" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=16;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="330" y="160" width="180" height="80" as="geometry"/></mxCell>
    <mxCell id="store" value="持久化图纸库" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=16;" vertex="1" parent="1"><mxGeometry x="600" y="160" width="180" height="80" as="geometry"/></mxCell>
    <mxCell id="drawio" value="Draw.io 实时画布" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=16;" vertex="1" parent="1"><mxGeometry x="330" y="330" width="180" height="80" as="geometry"/></mxCell>
    <mxCell id="e1" value="stdio" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="zcode" target="mcp"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="e2" value="版本保护" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="mcp" target="store"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="e3" value="事件同步" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="mcp" target="drawio"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root>
</mxGraphModel>`

class Client {
  constructor() {
    this.child = spawn(command, ['--client', 'codex'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.id = 1
    this.pending = new Map()
    this.buffer = ''
    this.stderr = ''
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
    this.child.stdout.on('data', (chunk) => this.onData(chunk.toString()))
    this.child.on('error', (error) => this.rejectAll(error))
    this.child.on('exit', (code) => this.rejectAll(new Error(`MCP exited with ${code}: ${this.stderr}`)))
  }

  onData(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  request(method, params = {}, timeoutMs = 35_000) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out: ${this.stderr}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raintool-installed-smoke', version: '1.0.0' },
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  }

  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args })
    assert.notEqual(result.isError, true, result.content?.[0]?.text)
    return result.content?.[0]?.text || ''
  }

  stop() {
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }
}

const client = new Client()
try {
  await client.initialize()
  let started
  if (existingDiagramId) {
    started = await client.call('open_diagram', { id: existingDiagramId })
    await client.call('get_diagram', { id: existingDiagramId })
  } else {
    started = await client.call('start_session', { title: 'RainTool MCP 实时绘图验收' })
    await client.call('create_new_diagram', { xml: diagramXml, title: 'RainTool MCP 实时绘图验收' })
    await client.call('get_diagram')
    await client.call('edit_diagram', {
      operations: [{
        operation: 'update',
        cell_id: 'drawio',
        new_xml: '<mxCell id="drawio" value="Draw.io 实时画布 ✓" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=16;" vertex="1" parent="1"><mxGeometry x="330" y="330" width="180" height="80" as="geometry"/></mxCell>',
      }],
    })
  }
  await client.call('export_diagram', { path: output, format: 'png' })
  assert.ok(existsSync(output), `PNG was not created: ${output}`)
  assert.ok(statSync(output).size > 1_000, `PNG is unexpectedly small: ${statSync(output).size}`)
  console.log(started)
  console.log(`Installed MCP smoke passed: ${output} (${statSync(output).size} bytes)`)
} finally {
  client.stop()
}
