#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mcpRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'build', 'raintool-mcp')
const entry = path.join(mcpRoot, 'index.cjs')
const launcher = path.join(mcpRoot, 'raintool-mcp')
const licenses = path.join(mcpRoot, 'THIRD_PARTY_LICENSES.txt')

for (const file of [entry, launcher, licenses]) {
  if (!existsSync(file)) throw new Error(`RainTool MCP artifact missing: ${file}`)
}
if ((statSync(launcher).mode & 0o111) === 0) throw new Error(`RainTool MCP launcher is not executable: ${launcher}`)

const requiredTools = [
  'start_session',
  'list_diagrams',
  'open_diagram',
  'create_new_diagram',
  'load_diagram',
  'get_diagram',
  'edit_diagram',
  'list_pages',
  'add_page',
  'rename_page',
  'delete_page',
  'inspect_diagram',
  'preview_diagram',
  'finalize_diagram',
  'duplicate_diagram',
  'update_diagram_metadata',
  'delete_diagram',
  'list_diagram_revisions',
  'restore_diagram_revision',
  'export_diagram',
]

const tools = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entry], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timeout = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`RainTool MCP handshake timed out. stderr: ${stderr}`))
  }, 10_000)

  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    const lines = stdout.split('\n')
    stdout = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch {
        clearTimeout(timeout)
        child.kill('SIGKILL')
        reject(new Error(`Non-JSON output on MCP stdout: ${line}`))
        return
      }
      if (message.id === 2) {
        clearTimeout(timeout)
        child.kill('SIGTERM')
        resolve(message.result?.tools || [])
        return
      }
    }
  })
  child.on('error', (error) => {
    clearTimeout(timeout)
    reject(error)
  })
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'raintool-build-verifier', version: '1.0.0' },
    },
  })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
})

const actual = new Set(tools.map((tool) => tool.name))
for (const name of requiredTools) {
  if (!actual.has(name)) throw new Error(`RainTool MCP tool missing: ${name}`)
}

console.log(`[RainTool MCP verify] ${requiredTools.length} tools available from ${entry}`)
