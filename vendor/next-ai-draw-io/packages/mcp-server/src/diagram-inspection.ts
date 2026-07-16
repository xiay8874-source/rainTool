/**
 * Deterministic quality checks for RainTool diagrams.
 *
 * draw.io accepts many diagrams that are valid XML but difficult to read.
 * This is deliberately a static review: it reports objective structure and
 * layout problems, while an agent uses preview_diagram to judge the requested
 * business meaning and visual hierarchy.
 */
import { parseMxfile, normalizeToMxfile } from "./pages.js"
import { validateMxCellStructure } from "./xml-validation.js"

export type DiagramInspectionIssue = {
    severity: "error" | "warning"
    code: string
    message: string
    page?: string
    cellIds?: string[]
}

export type DiagramInspectionSummary = {
    pages: number
    vertices: number
    edges: number
    labels: number
}

export type DiagramInspection = {
    passed: boolean
    summary: DiagramInspectionSummary
    errors: DiagramInspectionIssue[]
    warnings: DiagramInspectionIssue[]
    requirements?: string
}

type Rectangle = {
    id: string
    x: number
    y: number
    width: number
    height: number
    parent: string
}

function issue(
    issues: DiagramInspectionIssue[],
    severity: DiagramInspectionIssue["severity"],
    code: string,
    message: string,
    page?: string,
    cellIds?: string[],
): void {
    issues.push({ severity, code, message, page, cellIds })
}

function numericAttribute(element: Element, name: string): number | null {
    const value = element.getAttribute(name)
    if (value === null || value.trim() === "") return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

function plainText(value: string): string {
    return value
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim()
}

function overlaps(first: Rectangle, second: Rectangle): boolean {
    const horizontal = Math.min(first.x + first.width, second.x + second.width)
        - Math.max(first.x, second.x)
    const vertical = Math.min(first.y + first.height, second.y + second.height)
        - Math.max(first.y, second.y)
    if (horizontal <= 0 || vertical <= 0) return false
    const intersection = horizontal * vertical
    const smallerArea = Math.min(first.width * first.height, second.width * second.height)
    return smallerArea > 0 && intersection / smallerArea >= 0.25
}

function isContainer(cell: Element, allCells: Element[]): boolean {
    const id = cell.getAttribute("id")
    if (!id) return false
    const style = cell.getAttribute("style") || ""
    return style.includes("swimlane") || allCells.some((other) => other.getAttribute("parent") === id)
}

/**
 * Validate structural correctness plus readable-page heuristics. Grouped
 * children may overlap their container, so collision detection compares only
 * non-container siblings. A collision between comparable siblings is a hard
 * error: a finished RainTool diagram must not visually cover another node.
 */
export function inspectDiagramXml(
    inputXml: string,
    requirements?: string,
): DiagramInspection {
    const errors: DiagramInspectionIssue[] = []
    const warnings: DiagramInspectionIssue[] = []
    const summary: DiagramInspectionSummary = { pages: 0, vertices: 0, edges: 0, labels: 0 }
    const structuralError = validateMxCellStructure(inputXml)
    if (structuralError) {
        issue(errors, "error", "XML_INVALID", structuralError)
        return { passed: false, summary, errors, warnings, requirements }
    }

    const xml = normalizeToMxfile(inputXml)
    const document = xml ? parseMxfile(xml) : null
    if (!document) {
        issue(errors, "error", "DOCUMENT_INVALID", "Diagram must be a valid <mxfile> or <mxGraphModel> document.")
        return { passed: false, summary, errors, warnings, requirements }
    }

    const pages = Array.from(document.querySelectorAll("diagram"))
    summary.pages = pages.length
    if (pages.length === 0) {
        issue(errors, "error", "NO_PAGE", "Diagram has no <diagram> page.")
    }

    for (const [index, page] of pages.entries()) {
        const pageName = page.getAttribute("name") || `Page-${index + 1}`
        const root = page.querySelector("root")
        if (!root) {
            issue(errors, "error", "NO_ROOT", "Page has no <root> element.", pageName)
            continue
        }

        const cells = Array.from(root.querySelectorAll("mxCell"))
        const ids = new Set(cells.map((cell) => cell.getAttribute("id")).filter(Boolean))
        const rectangles: Rectangle[] = []
        const visibleCells: Element[] = []

        for (const cell of cells) {
            const id = cell.getAttribute("id") || ""
            if (id === "0" || id === "1") continue
            const parent = cell.getAttribute("parent") || ""
            const isEdge = cell.getAttribute("edge") === "1"
            const isVertex = cell.getAttribute("vertex") === "1"
            const label = plainText(cell.getAttribute("value") || "")
            if (label) summary.labels++

            if (parent && parent !== "0" && parent !== "1" && !ids.has(parent)) {
                issue(errors, "error", "MISSING_PARENT", `Cell ${id} references missing parent ${parent}.`, pageName, [id, parent])
            }

            if (isEdge) {
                summary.edges++
                const source = cell.getAttribute("source")
                const target = cell.getAttribute("target")
                if (!source || !target) {
                    issue(warnings, "warning", "DANGLING_EDGE", `Edge ${id} is missing ${!source ? "source" : "target"}.`, pageName, [id])
                } else if (!ids.has(source) || !ids.has(target)) {
                    issue(errors, "error", "MISSING_EDGE_ENDPOINT", `Edge ${id} references a missing endpoint.`, pageName, [id, source, target])
                }
                continue
            }

            if (!isVertex) continue
            summary.vertices++
            visibleCells.push(cell)
            const geometry = Array.from(cell.children).find((child) => child.tagName === "mxGeometry")
            if (!geometry) {
                issue(errors, "error", "MISSING_GEOMETRY", `Vertex ${id} has no mxGeometry.`, pageName, [id])
                continue
            }
            const x = numericAttribute(geometry, "x")
            const y = numericAttribute(geometry, "y")
            const width = numericAttribute(geometry, "width")
            const height = numericAttribute(geometry, "height")
            if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
                issue(errors, "error", "INVALID_GEOMETRY", `Vertex ${id} has invalid geometry.`, pageName, [id])
                continue
            }
            if (x < 0 || y < 0) {
                issue(warnings, "warning", "NEGATIVE_POSITION", `Vertex ${id} begins outside the page origin.`, pageName, [id])
            }
            if (parent === "1" && (x + width > 1600 || y + height > 1000)) {
                issue(warnings, "warning", "OVERSIZED_PAGE", `Vertex ${id} expands the top-level layout beyond 1600×1000. Split unrelated scenarios into pages.`, pageName, [id])
            }
            if (label.length > 80) {
                issue(warnings, "warning", "LONG_LABEL", `Vertex ${id} has a ${label.length}-character label; move implementation detail to notes or a separate page.`, pageName, [id])
            }
            if (label && width < Math.min(240, Math.max(90, label.length * 5))) {
                issue(warnings, "warning", "LABEL_DENSITY", `Vertex ${id} is likely too narrow for its label.`, pageName, [id])
            }
            rectangles.push({ id, x, y, width, height, parent })
        }

        if (summary.vertices > 0 && visibleCells.length > 18) {
            issue(warnings, "warning", "DENSE_PAGE", `Page contains ${visibleCells.length} visible nodes. Split scenarios or use additional pages.`, pageName)
        }

        for (let firstIndex = 0; firstIndex < rectangles.length; firstIndex++) {
            for (let secondIndex = firstIndex + 1; secondIndex < rectangles.length; secondIndex++) {
                const first = rectangles[firstIndex]
                const second = rectangles[secondIndex]
                if (first.parent !== second.parent) continue
                const firstCell = visibleCells.find((cell) => cell.getAttribute("id") === first.id)
                const secondCell = visibleCells.find((cell) => cell.getAttribute("id") === second.id)
                if (!firstCell || !secondCell || isContainer(firstCell, visibleCells) || isContainer(secondCell, visibleCells)) continue
                if (overlaps(first, second)) {
                    issue(errors, "error", "OVERLAP", `Vertices ${first.id} and ${second.id} substantially overlap. Move or resize them so neither node covers the other.`, pageName, [first.id, second.id])
                }
            }
        }
    }

    return {
        passed: errors.length === 0,
        summary,
        errors,
        warnings,
        requirements,
    }
}
