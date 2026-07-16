#!/usr/bin/env node
/**
 * RainTool transport for the pinned next-ai-draw-io MCP implementation.
 *
 * The upstream XML validation and ID-based edit operations are retained, but
 * browser polling is replaced by RainTool's authenticated localhost bridge so
 * ZCode, Codex and the visible editor all operate on the same document store.
 */
import { DOMParser } from "linkedom"
;(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = DOMParser

class XMLSerializerPolyfill {
    serializeToString(node: { outerHTML?: string; documentElement?: { outerHTML?: string } }): string {
        return node.outerHTML ?? node.documentElement?.outerHTML ?? ""
    }
}
;(globalThis as unknown as { XMLSerializer: typeof XMLSerializerPolyfill }).XMLSerializer = XMLSerializerPolyfill

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import {
    applyDiagramOperations,
    type DiagramOperation,
} from "./diagram-operations.js"
import { checkEditGate } from "./edit-gate.js"
import { inspectDiagramXml, type DiagramInspection } from "./diagram-inspection.js"
import { parseDrawioFileContent } from "./load-diagram.js"
import {
    addPageToDoc,
    deletePageFromDoc,
    hasPageSelector,
    listPagesFromDoc,
    normalizeToMxfile,
    parseMxfile,
    projectPage,
    renamePageInDoc,
    serializeMxfile,
    type PageSelector,
} from "./pages.js"
import { validateAndFixXml } from "./xml-validation.js"

type DiagramSource = "raintool" | "zcode" | "codex" | "mcp" | "legacy"

interface DiagramMetadata {
    id: string
    title: string
    revision: number
    createdAt: number
    updatedAt: number
    source: DiagramSource
    sourceClient?: string
    favorite: boolean
    tags: string[]
}

interface DiagramDocument extends DiagramMetadata {
    xml: string
}

interface AuthFile {
    version: number
    host: string
    port: number
    token: string
}

interface RpcEnvelope<T> {
    ok: boolean
    result?: T
    error?: { code: string; message: string; data?: unknown }
}

class RpcError extends Error {
    readonly code: string
    readonly data?: unknown

    constructor(code: string, message: string, data?: unknown) {
        super(message)
        this.name = "RpcError"
        this.code = code
        this.data = data
    }
}

const clientName = (() => {
    const index = process.argv.indexOf("--client")
    const value = index >= 0 ? process.argv[index + 1]?.trim().toLowerCase() : undefined
    return value === "zcode" || value === "codex" ? value : "mcp"
})()
const source = clientName as "zcode" | "codex" | "mcp"
const authPath = process.env.RAINTOOL_MCP_AUTH_FILE || path.join(os.homedir(), "raintool", "mcp-auth.json")
let appLaunchRequested = false
let currentDiagramId: string | null = null
const lastSeenXml = new Map<string, string>()
const qualityRequirements = new Map<string, string>()
const qualityReviews = new Map<string, { revision: number; inspection: DiagramInspection }>()

const pageSelectorSchema = {
    page_id: z.string().min(1).optional().describe("Target page by its id."),
    page_name: z.string().min(1).optional().describe("Target page by its visible name."),
    page_index: z.number().int().nonnegative().optional().describe("Target page by its 0-based index."),
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function readAuth(): Promise<AuthFile> {
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as Partial<AuthFile>
    if (
        parsed.version !== 1 ||
        typeof parsed.host !== "string" ||
        !Number.isInteger(parsed.port) ||
        typeof parsed.token !== "string" ||
        parsed.token.length < 32
    ) {
        throw new Error(`RainTool MCP auth file is invalid: ${authPath}`)
    }
    return parsed as AuthFile
}

function requestAppLaunch(): void {
    if (appLaunchRequested) return
    appLaunchRequested = true
    if (process.platform === "darwin") {
        const child = spawn("/usr/bin/open", ["-a", process.env.RAINTOOL_APP_NAME || "RainTool"], {
            detached: true,
            stdio: "ignore",
        })
        child.unref()
    }
}

async function rpc<T>(method: string, params: Record<string, unknown> = {}, allowLaunch = true): Promise<T> {
    let lastError: unknown
    const deadline = Date.now() + (allowLaunch ? 15_000 : 1)
    do {
        try {
            const auth = await readAuth()
            const response = await fetch(`http://${auth.host}:${auth.port}/rpc`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${auth.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ method, params }),
            })
            const envelope = (await response.json()) as RpcEnvelope<T>
            if (!envelope.ok || envelope.result === undefined) {
                throw new RpcError(
                    envelope.error?.code || "RPC_ERROR",
                    envelope.error?.message || `RainTool RPC ${method} failed`,
                    envelope.error?.data,
                )
            }
            return envelope.result
        } catch (error) {
            if (error instanceof RpcError) throw error
            lastError = error
            if (!allowLaunch) break
            requestAppLaunch()
            await sleep(300)
        }
    } while (Date.now() < deadline)
    throw new Error(
        `Unable to connect to RainTool. Open RainTool and try again. ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
}

function textResult(text: string) {
    return { content: [{ type: "text" as const, text }] }
}

function errorResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true }
}

function validatedXml(input: string): { xml: string; fixes: string[] } {
    const result = validateAndFixXml(input)
    if (!result.valid) throw new Error(`XML validation failed: ${result.error || "unknown error"}`)
    return { xml: result.fixed || input, fixes: result.fixes }
}

async function resolveDiagram(id?: string): Promise<DiagramDocument> {
    if (id) currentDiagramId = id
    if (currentDiagramId) return rpc<DiagramDocument>("diagram.get", { id: currentDiagramId })
    const active = await rpc<DiagramDocument | null>("diagram.getActive")
    if (!active) throw new Error("No active diagram. Call start_session or open_diagram first.")
    currentDiagramId = active.id
    return active
}

function documentSummary(document: DiagramDocument): string {
    return `${document.title} (${document.id}, revision ${document.revision})`
}

function pickPageSelector(input: {
    page_id?: string
    page_name?: string
    page_index?: number
}): PageSelector {
    const selector: PageSelector = {}
    if (input.page_id) selector.page_id = input.page_id
    if (input.page_name) selector.page_name = input.page_name
    if (input.page_index !== undefined) selector.page_index = input.page_index
    return selector
}

function recordSeen(document: DiagramDocument): void {
    currentDiagramId = document.id
    lastSeenXml.set(document.id, document.xml)
}

function normalizedDiagramXml(input: string): { xml: string; fixes: string[] } {
    const validated = validatedXml(input)
    const xml = normalizeToMxfile(validated.xml)
    if (!xml) throw new Error("Diagram XML must be a complete <mxGraphModel> or <mxfile> document.")
    const normalized = validatedXml(xml)
    return { xml: normalized.xml, fixes: [...validated.fixes, ...normalized.fixes] }
}

async function updateDiagramXml(
    document: DiagramDocument,
    xml: string,
): Promise<DiagramDocument> {
    const normalized = normalizedDiagramXml(xml)
    const updated = await rpc<DiagramDocument>("diagram.update", {
        id: document.id,
        xml: normalized.xml,
        expectedRevision: document.revision,
    })
    recordSeen(updated)
    qualityReviews.delete(updated.id)
    return updated
}

async function loadMxfileForMutation(id?: string): Promise<{
    document: DiagramDocument
    xml: string
    mxfile: Document
}> {
    const document = await resolveDiagram(id)
    const xml = normalizeToMxfile(document.xml)
    if (!xml) throw new Error("Current diagram is not a valid <mxfile> or <mxGraphModel> document.")
    const mxfile = parseMxfile(xml)
    if (!mxfile) throw new Error("Current diagram <mxfile> could not be parsed.")
    return { document, xml, mxfile }
}

function inspectionResult(document: DiagramDocument, inspection: DiagramInspection) {
    return JSON.stringify({
        diagram: {
            id: document.id,
            title: document.title,
            revision: document.revision,
        },
        ...inspection,
    }, null, 2)
}

function assertInitialDraftSize(xml: string): void {
    const inspection = inspectDiagramXml(xml)
    if (inspection.summary.vertices > 8 || inspection.summary.edges > 10) {
        throw new Error(
            `REJECTED_LARGE_INITIAL_DIAGRAM: received ${inspection.summary.vertices} visible nodes and ` +
            `${inspection.summary.edges} edges; the first submission allows at most 8 nodes and 10 edges.\n\n` +
            "Do not retry create_new_diagram with the same complete diagram. Recover as follows:\n" +
            "1. Call create_new_diagram with only the main actors and happy-path skeleton.\n" +
            "2. Add the remaining nodes and edges through edit_diagram in batches of 2-8 operations; use add_page for unrelated scenarios.\n" +
            "3. When construction is finished, call inspect_diagram, preview_diagram, then finalize_diagram.\n\n" +
            "This rejection is intentional: it forces incremental, inspectable drawing instead of an unreadable one-shot result.",
        )
    }
}

async function writeRenderedPreview(
    document: DiagramDocument,
    format: "png" | "svg",
    outputPath: string,
): Promise<string> {
    const result = await rpc<{ data: string }>("diagram.export", { id: document.id, format })
    const absolutePath = path.resolve(outputPath)
    if (format === "png") {
        const base64 = result.data.replace(/^data:image\/png;base64,/, "")
        await writeFile(absolutePath, Buffer.from(base64, "base64"))
    } else {
        let svg = result.data
        if (svg.startsWith("data:image/svg+xml;base64,")) {
            svg = Buffer.from(svg.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8")
        } else if (svg.startsWith("data:image/svg+xml,")) {
            svg = decodeURIComponent(svg.slice("data:image/svg+xml,".length))
        }
        await writeFile(absolutePath, svg, "utf8")
    }
    return absolutePath
}

const server = new McpServer({
    name: "raintool-next-ai-drawio",
    version: "1.0.0",
})

server.prompt("diagram-workflow", "High-quality workflow for drawing in RainTool", () => ({
    messages: [{
        role: "user",
        content: {
            type: "text",
            text: `Use RainTool as the shared live diagram workspace.
1. Call start_session with the audience and acceptance requirements.
2. For a complex request, create_new_diagram with a small skeleton only, then use edit_diagram in 2-8 operation batches so the user sees the drawing evolve.
3. Put unrelated scenarios on separate pages with add_page; do not compress a large business process into one page.
4. Call inspect_diagram after each substantial change. Fix every error; OVERLAP is a hard error and cannot be waived.
5. Call preview_diagram and visually compare the rendered image against the requirements before finalize_diagram.
6. Use get_diagram after a stale-edit rejection. The server protects manual edits by comparing the actual XML content, not a time limit.
7. Use unique mxCell IDs per page; IDs 0 and 1 are reserved root sentinels in every page.`,
        },
    }],
}))

server.registerTool("start_session", {
    description: "Create a persistent RainTool diagram and open it in the visible AI drawing editor. Start here for a new drawing. The response records the optional requirements used by inspect_diagram and finalize_diagram.",
    inputSchema: {
        title: z.string().optional().describe("Diagram title. Defaults to a client-specific title."),
        requirements: z.string().max(4000).optional().describe("Audience, purpose, mandatory scenarios, and acceptance criteria for the drawing."),
    },
}, async ({ title, requirements }) => {
    try {
        const document = await rpc<DiagramDocument>("diagram.create", {
            title: title || `${clientName === "mcp" ? "AI" : clientName} 图纸`,
            source,
            sourceClient: clientName,
        })
        recordSeen(document)
        if (requirements?.trim()) qualityRequirements.set(document.id, requirements.trim())
        await rpc<DiagramDocument>("diagram.open", { id: document.id })
        return textResult(
            `RainTool session started.\n\nDiagram: ${documentSummary(document)}\n` +
            "Quality workflow: create a small skeleton, edit in batches, inspect, preview, then finalize.\n" +
            "The diagram is open and updates will appear in real time.",
        )
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("list_diagrams", {
    description: "List persistent diagrams managed by RainTool. Use an ID from this result with open_diagram or get_diagram.",
    inputSchema: {
        query: z.string().optional().describe("Search title, tag, or source client."),
        favorite: z.boolean().optional().describe("Filter to favorite or non-favorite diagrams."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum results; defaults to 100."),
    },
}, async ({ query, favorite, limit }) => {
    try {
        const result = await rpc<{ items: DiagramMetadata[]; total: number }>("diagram.list", {
            query,
            favorite,
            limit: limit ?? 100,
        })
        return textResult(JSON.stringify(result, null, 2))
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("open_diagram", {
    description: "Select an existing RainTool diagram as the current MCP diagram and show it in RainTool.",
    inputSchema: { id: z.string().describe("RainTool diagram ID.") },
}, async ({ id }) => {
    try {
        const document = await rpc<DiagramDocument>("diagram.open", { id })
        currentDiagramId = document.id
        lastSeenXml.delete(document.id)
        return textResult(`Opened ${documentSummary(document)} in RainTool.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("create_new_diagram", {
    description: `Create a NEW RainTool diagram from XML. This REPLACES the current document, including every page, so never use it for edits.

Guided drawing is mandatory for complex diagrams: create only a skeleton (at most 8 visible nodes and 10 edges), then use edit_diagram in 2-8 operation batches. This makes changes visible immediately and prevents a large unreadable one-shot result.
If this tool rejects a large submission, follow its recovery steps exactly; do not retry with the same full XML.

ACCEPTED XML: a bare <mxGraphModel> or a full <mxfile> with one or more <diagram> pages. Every page reserves cell IDs 0 and 1.

LAYOUT RULES PER PAGE:
- Keep unrelated scenarios on separate pages.
- Start around x=40, y=40 and keep sibling nodes 150-200px apart.
- Use parent=1 for top-level shapes and unique IDs within a page.
- Use edgeStyle=orthogonalEdgeStyle, explicit exitX/exitY/entryX/entryY, and route around obstacles with clearance.
- Keep labels concise; implementation details belong in notes or a dedicated page.

After creating or editing, call inspect_diagram, preview_diagram, then finalize_diagram.`,
    inputSchema: {
        xml: z.string().describe("Complete mxGraphModel or mxfile XML."),
        title: z.string().optional().describe("Optional diagram title."),
    },
}, async ({ xml: inputXml, title }) => {
    try {
        const validated = normalizedDiagramXml(inputXml)
        assertInitialDraftSize(validated.xml)
        let document: DiagramDocument
        try {
            const current = await resolveDiagram()
            document = await rpc<DiagramDocument>("diagram.update", {
                id: current.id,
                xml: validated.xml,
                title,
                expectedRevision: current.revision,
            })
        } catch (error) {
            if (error instanceof RpcError) throw error
            document = await rpc<DiagramDocument>("diagram.create", {
                title: title || `${clientName === "mcp" ? "AI" : clientName} 图纸`,
                xml: validated.xml,
                source,
                sourceClient: clientName,
            })
        }
        recordSeen(document)
        qualityReviews.delete(document.id)
        await rpc<DiagramDocument>("diagram.open", { id: document.id })
        const fixMessage = validated.fixes.length ? `\nAuto-fixes: ${validated.fixes.join(", ")}` : ""
        return textResult(
            `Diagram skeleton created successfully.\n\n${documentSummary(document)}${fixMessage}\n` +
            "Next: add details with edit_diagram, then inspect_diagram and preview_diagram before finalize_diagram.",
        )
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("get_diagram", {
    description: "Get current draw.io XML from RainTool, including the latest autosaved manual edits. Without a page selector it returns the full mxfile; a selector returns a one-page mxfile projection. Call this after a stale-edit rejection or when you do not know the cell IDs.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        ...pageSelectorSchema,
    },
}, async ({ id, page_id, page_name, page_index }) => {
    try {
        const document = await resolveDiagram(id)
        recordSeen(document)
        const selector = pickPageSelector({ page_id, page_name, page_index })
        if (!hasPageSelector(selector)) {
            return textResult(`Diagram: ${documentSummary(document)}\n\n${document.xml}`)
        }
        const projection = projectPage(document.xml, selector)
        if (!projection.ok) {
            throw new Error(projection.reason === "parse"
                ? "Current diagram could not be parsed as a multi-page <mxfile>."
                : "Requested page was not found.")
        }
        return textResult(`Diagram page ${projection.index} (${projection.name}) from ${documentSummary(document)}\n\n${projection.xml}`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("edit_diagram", {
    description: `Incrementally add, update, or delete mxCells in the current RainTool diagram. Use 2-8 operations per call (maximum 12) so the user sees progress. For add/update, new_xml must be a complete mxCell with mxGeometry.

The server rejects an edit only when the user changed the diagram since the agent last saw or wrote it. On rejection, call get_diagram, rebuild the operations, and retry. Do not overwrite the whole document for an edit.

Use page_id, page_name, or page_index for a multi-page document; default is the first page. After a substantial batch, call inspect_diagram.`,
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        ...pageSelectorSchema,
        operations: z.array(z.object({
            operation: z.enum(["update", "add", "delete"]),
            cell_id: z.string(),
            new_xml: z.string().optional(),
        })).min(1).max(12).describe("ID-based mxCell edit operations."),
    },
}, async ({ id, page_id, page_name, page_index, operations }) => {
    try {
        const document = await resolveDiagram(id)
        const gate = checkEditGate(lastSeenXml.get(document.id) || "", document.xml)
        if (!gate.ok) {
            throw new Error(gate.reason === "stale"
                ? "The diagram changed in RainTool since you last saw it. Call get_diagram, then rebuild the edit operations."
                : "Call get_diagram first so the edit is based on the current diagram.")
        }
        const validatedOperations = operations.map((operation) => {
            if (!operation.new_xml) return operation
            return { ...operation, new_xml: validatedXml(operation.new_xml).xml }
        })
        const selector = pickPageSelector({ page_id, page_name, page_index })
        const applied = applyDiagramOperations(document.xml, validatedOperations as DiagramOperation[], selector)
        if (applied.errors.length === operations.length) {
            throw new Error(applied.errors.map((item) => `${item.type} ${item.cellId}: ${item.message}`).join("\n"))
        }
        const updatedXml = normalizedDiagramXml(applied.result).xml
        const updated = await updateDiagramXml(document, updatedXml)
        const warnings = applied.errors.length
            ? `\n\nWarnings:\n${applied.errors.map((item) => `- ${item.type} ${item.cellId}: ${item.message}`).join("\n")}`
            : ""
        return textResult(`Diagram edited successfully.\n\n${documentSummary(updated)}\nApplied ${operations.length - applied.errors.length}/${operations.length} operations.${warnings}\nRun inspect_diagram after this batch.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("load_diagram", {
    description: "Load a .drawio file from disk into the current RainTool diagram, replacing all pages. Plain XML and draw.io compressed page content are supported. Call get_diagram after loading before using edit_diagram because the cell IDs may be unfamiliar.",
    inputSchema: {
        path: z.string().min(1).describe("Local .drawio file path."),
    },
}, async ({ path: inputPath }) => {
    try {
        const document = await resolveDiagram()
        const content = await readFile(path.resolve(inputPath), "utf8")
        const loaded = parseDrawioFileContent(content)
        if (!loaded.ok) throw new Error(loaded.error)
        const normalized = normalizedDiagramXml(loaded.xml)
        const updated = await updateDiagramXml(document, normalized.xml)
        const pages = parseMxfile(updated.xml)
            ? listPagesFromDoc(parseMxfile(updated.xml)!)
            : []
        lastSeenXml.delete(updated.id)
        return textResult(
            `Loaded ${documentSummary(updated)} with ${pages.length} page(s).\n` +
            "Call get_diagram before edit_diagram so edits use the loaded cell IDs.",
        )
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("list_pages", {
    description: "List every page (tab) in the current diagram with id, name, 0-based index, and cell count.",
    inputSchema: { id: z.string().optional().describe("Diagram ID; defaults to the current session diagram.") },
}, async ({ id }) => {
    try {
        const { document, mxfile } = await loadMxfileForMutation(id)
        return textResult(JSON.stringify({
            diagram: documentSummary(document),
            pages: listPagesFromDoc(mxfile),
        }, null, 2))
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("add_page", {
    description: "Append a new page without changing existing pages. Use this for unrelated scenarios instead of putting a dense multi-scenario process on one canvas. The optional xml must be a bare mxGraphModel.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        name: z.string().min(1).max(200).optional().describe("Visible page name."),
        page_id: z.string().min(1).max(128).optional().describe("Optional stable page ID."),
        xml: z.string().optional().describe("Optional bare mxGraphModel for the new page."),
    },
}, async ({ id, name, page_id, xml }) => {
    try {
        const loaded = await loadMxfileForMutation(id)
        const page = addPageToDoc(loaded.mxfile, { id: page_id, name, xml })
        const updated = await updateDiagramXml(loaded.document, serializeMxfile(loaded.mxfile))
        return textResult(`Added page ${page.index} (${page.name}, ${page.id}) to ${documentSummary(updated)}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("rename_page", {
    description: "Rename an existing page. Provide one page selector and a concise visible name.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        ...pageSelectorSchema,
        new_name: z.string().min(1).max(200).describe("New visible page name."),
    },
}, async ({ id, page_id, page_name, page_index, new_name }) => {
    try {
        const loaded = await loadMxfileForMutation(id)
        const selector = pickPageSelector({ page_id, page_name, page_index })
        if (!hasPageSelector(selector)) throw new Error("Provide page_id, page_name, or page_index to rename a page.")
        if (!renamePageInDoc(loaded.mxfile, selector, new_name)) throw new Error("Requested page was not found.")
        const updated = await updateDiagramXml(loaded.document, serializeMxfile(loaded.mxfile))
        return textResult(`Renamed page in ${documentSummary(updated)} to ${new_name}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("delete_page", {
    description: "Delete one page from a multi-page diagram. This cannot delete the final remaining page. Use only after explicit user confirmation.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        ...pageSelectorSchema,
    },
}, async ({ id, page_id, page_name, page_index }) => {
    try {
        const loaded = await loadMxfileForMutation(id)
        const selector = pickPageSelector({ page_id, page_name, page_index })
        if (!hasPageSelector(selector)) throw new Error("Provide page_id, page_name, or page_index to delete a page.")
        const result = deletePageFromDoc(loaded.mxfile, selector)
        if (!result.ok) throw new Error(result.reason || "Unable to delete page.")
        const updated = await updateDiagramXml(loaded.document, serializeMxfile(loaded.mxfile))
        return textResult(`Deleted page ${result.deletedIndex} (${result.deletedId}) from ${documentSummary(updated)}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("inspect_diagram", {
    description: "Run deterministic XML and layout checks before declaring a diagram complete. Reports invalid references, missing geometry, dangling edges, overlap, over-dense pages, oversized layouts, and unreadably long/dense labels. OVERLAP is a hard error: move or resize the nodes; it cannot be accepted by finalize_diagram. This does not replace a visual/business review; use preview_diagram afterwards.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        requirements: z.string().max(4000).optional().describe("Override or add the acceptance requirements from start_session."),
    },
}, async ({ id, requirements }) => {
    try {
        const document = await resolveDiagram(id)
        const inspection = inspectDiagramXml(document.xml, requirements?.trim() || qualityRequirements.get(document.id))
        qualityReviews.set(document.id, { revision: document.revision, inspection })
        return textResult(inspectionResult(document, inspection))
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("preview_diagram", {
    description: "Render the visible RainTool editor to a PNG or SVG preview for visual review. Inspect the image against the requirements before finalize_diagram. The returned local path is intentionally usable by Codex/ZCode image viewers.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        format: z.enum(["png", "svg"]).optional().describe("Preview format; defaults to PNG."),
        path: z.string().optional().describe("Optional local destination. Defaults to the system temporary directory."),
    },
}, async ({ id, format = "png", path: outputPath }) => {
    try {
        const document = await resolveDiagram(id)
        const generatedPath = outputPath || path.join(os.tmpdir(), `raintool-preview-${document.id}-r${document.revision}.${format}`)
        const file = await writeRenderedPreview(document, format, generatedPath)
        return textResult(`Preview rendered for ${documentSummary(document)}. Visually inspect this file before finalizing:\n${file}`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("finalize_diagram", {
    description: "Mark the current diagram ready only after inspect_diagram ran on this exact revision and preview_diagram was visually reviewed. Errors, including OVERLAP, always block finalization. Warnings block by default; set allow_warnings only after explicitly explaining the accepted trade-off to the user.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to the current session diagram."),
        allow_warnings: z.boolean().optional().describe("Accept remaining inspection warnings after explaining them to the user."),
    },
}, async ({ id, allow_warnings = false }) => {
    try {
        const document = await resolveDiagram(id)
        const review = qualityReviews.get(document.id)
        if (!review || review.revision !== document.revision) {
            throw new Error("Call inspect_diagram on the current revision, fix the findings, and preview the result before finalize_diagram.")
        }
        if (review.inspection.errors.length > 0) {
            throw new Error(`Quality inspection found ${review.inspection.errors.length} error(s). Fix them before finalizing.`)
        }
        if (review.inspection.warnings.length > 0 && !allow_warnings) {
            throw new Error(`Quality inspection found ${review.inspection.warnings.length} warning(s). Fix them or explain the accepted trade-off and call finalize_diagram with allow_warnings=true.`)
        }
        return textResult(`Diagram finalized: ${documentSummary(document)}. Structural inspection passed${review.inspection.warnings.length ? ` with ${review.inspection.warnings.length} accepted warning(s)` : ""}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("duplicate_diagram", {
    description: "Create a persistent copy of a RainTool diagram and open the copy.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to current."),
        title: z.string().optional().describe("Optional title for the copy."),
    },
}, async ({ id, title }) => {
    try {
        const current = await resolveDiagram(id)
        const copy = await rpc<DiagramDocument>("diagram.duplicate", {
            id: current.id,
            title,
            source,
            sourceClient: clientName,
        })
        currentDiagramId = copy.id
        lastSeenXml.delete(copy.id)
        await rpc<DiagramDocument>("diagram.open", { id: copy.id })
        return textResult(`Duplicated and opened ${documentSummary(copy)}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("update_diagram_metadata", {
    description: "Rename, favorite/unfavorite, or retag a RainTool diagram without replacing its XML.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to current."),
        title: z.string().optional(),
        favorite: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
    },
}, async ({ id, title, favorite, tags }) => {
    try {
        const current = await resolveDiagram(id)
        const updated = await rpc<DiagramDocument>("diagram.update", {
            id: current.id,
            title,
            favorite,
            tags,
            expectedRevision: current.revision,
        })
        recordSeen(updated)
        qualityReviews.delete(updated.id)
        return textResult(`Updated ${documentSummary(updated)}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("delete_diagram", {
    description: "Permanently delete a RainTool diagram. Use only after explicit user confirmation.",
    inputSchema: { id: z.string().describe("Diagram ID to delete.") },
}, async ({ id }) => {
    try {
        const result = await rpc<{ deleted: boolean }>("diagram.delete", { id })
        if (currentDiagramId === id) currentDiagramId = null
        lastSeenXml.delete(id)
        qualityRequirements.delete(id)
        qualityReviews.delete(id)
        return textResult(result.deleted ? `Deleted diagram ${id}.` : `Diagram ${id} did not exist.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("list_diagram_revisions", {
    description: "List saved revisions for a RainTool diagram.",
    inputSchema: { id: z.string().optional().describe("Diagram ID; defaults to current.") },
}, async ({ id }) => {
    try {
        const current = await resolveDiagram(id)
        const revisions = await rpc<Array<{ revision: number; savedAt: number }>>("diagram.listRevisions", { id: current.id })
        return textResult(JSON.stringify({ id: current.id, revisions }, null, 2))
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("restore_diagram_revision", {
    description: "Restore a saved RainTool diagram revision as a new current revision.",
    inputSchema: {
        id: z.string().optional().describe("Diagram ID; defaults to current."),
        revision: z.number().int().min(1),
    },
}, async ({ id, revision }) => {
    try {
        const current = await resolveDiagram(id)
        const restored = await rpc<DiagramDocument>("diagram.restoreRevision", {
            id: current.id,
            revision,
            expectedRevision: current.revision,
        })
        currentDiagramId = restored.id
        lastSeenXml.delete(restored.id)
        qualityReviews.delete(restored.id)
        return textResult(`Restored ${documentSummary(restored)} from revision ${revision}.`)
    } catch (error) {
        return errorResult(error)
    }
})

server.registerTool("export_diagram", {
    description: "Export a RainTool diagram to .drawio, .png, or .svg. A page selector exports a one-page .drawio projection; PNG/SVG export the currently visible editor page, so use preview_diagram for the final visual QA image.",
    inputSchema: {
        path: z.string().describe("Destination path."),
        format: z.enum(["drawio", "png", "svg"]).optional(),
        id: z.string().optional().describe("Diagram ID; defaults to current."),
        ...pageSelectorSchema,
    },
}, async ({ path: outputPath, format, id, page_id, page_name, page_index }) => {
    try {
        const document = await resolveDiagram(id)
        const extension = path.extname(outputPath).toLowerCase()
        const resolvedFormat = format || (extension === ".png" ? "png" : extension === ".svg" ? "svg" : "drawio")
        const normalizedPath = extension === `.${resolvedFormat}`
            ? outputPath
            : `${extension === ".drawio" || extension === ".png" || extension === ".svg" ? outputPath.slice(0, -extension.length) : outputPath}.${resolvedFormat}`
        const absolutePath = path.resolve(normalizedPath)
        const selector = pickPageSelector({ page_id, page_name, page_index })
        if (resolvedFormat === "drawio") {
            let xml = document.xml
            if (hasPageSelector(selector)) {
                const projection = projectPage(document.xml, selector)
                if (!projection.ok) throw new Error(projection.reason === "parse"
                    ? "Current diagram could not be parsed as a multi-page <mxfile>."
                    : "Requested page was not found.")
                xml = projection.xml
            }
            await writeFile(absolutePath, xml, "utf8")
        } else {
            if (hasPageSelector(selector)) {
                throw new Error("Page-targeted PNG/SVG export is not available through the visible RainTool editor yet. Export that page as .drawio or select the page in RainTool first.")
            }
            await writeRenderedPreview(document, resolvedFormat, absolutePath)
        }
        return textResult(`Exported ${documentSummary(document)} to ${absolutePath} (${resolvedFormat}).`)
    } catch (error) {
        return errorResult(error)
    }
})

async function main(): Promise<void> {
    const transport = new StdioServerTransport()
    await server.connect(transport)
}

void main().catch((error) => {
    process.stderr.write(`[RainTool MCP] ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exitCode = 1
})
