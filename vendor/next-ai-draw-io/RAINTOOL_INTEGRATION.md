# RainTool integration delta

This directory is a source snapshot of `next-ai-draw-io` v0.4.16 at commit
`1115b2d2cdc30ffb7f7b83e1328d3ea00f8de887`. It is intentionally not a copy of
the upstream Electron shell. RainTool builds the upstream Next.js application
as a standalone server and owns the desktop lifecycle.

## Intentional source changes

- `app/[lang]/page.tsx`: recognize `NEXT_PUBLIC_RAINTOOL_EMBEDDED=true` as an
  offline desktop embedding. This enables draw.io's `offline=true` URL
  parameter even though the Next.js iframe does not receive upstream's
  `window.electronAPI`. The existing `NEXT_PUBLIC_DRAWIO_BASE_URL` remains the
  source of the absolute local draw.io URL. The same page implements the
  `raintool-diagram-v1` parent bridge for canonical XML load, autosave, export,
  and one-time diagram-only migration from legacy IndexedDB sessions.
- `packages/mcp-server/src/raintool-index.ts`: retain upstream XML validation
  and ID-based operations but replace the separate browser polling session with
  RainTool's authenticated persistent diagram bridge. It adds diagram library,
  metadata, history and selection tools for ZCode and Codex. Its tool
  descriptions enforce the guided workflow: small initial skeleton, incremental
  edits, structural/layout inspection, rendered preview, then finalization.
- `packages/mcp-server/src/pages.ts`, `edit-gate.ts`, `load-diagram.ts`,
  `diagram-operations.ts`, and `xml-validation.ts`: mechanically imported from
  upstream `main` commit `4b072283202d3fe4869acd847ee897ad1165d73d` on
  2026-07-17. They provide canonical multi-page `<mxfile>` handling, compressed
  `.drawio` loading, page-scoped ID operations, and content-fingerprint edit
  protection. These are an intentional MCP-only forward-port; the embedded
  Next application remains at the pinned v0.4.16 snapshot above.
- `packages/mcp-server/src/diagram-inspection.ts`: RainTool-only deterministic
  quality gate. It reports invalid references/geometry, dangling edges,
  sibling overlaps, overly dense or oversized pages, and label density. It is
  not an AI semantic reviewer: `preview_diagram` deliberately returns a local
  PNG/SVG path for a vision-capable client to compare against user requirements.
- `packages/mcp-server/package.json` and lockfile: override the MCP SDK's AJV
  and fast-uri transitive versions to the reviewed patched releases. Recheck
  these overrides against the target SDK on every upstream upgrade.
- `next.config.ts`: set `outputFileTracingRoot` to this directory. Next.js 16
  otherwise infers the monorepo root from the nearest `.git` (the RainTool
  repo root) and nests the standalone output under `vendor/next-ai-draw-io/`,
  so `server.js` does not land at `.next/standalone/server.js` where the root
  build script and verifier expect it. Pinning the tracing root to this
  directory keeps the standalone layout flat without touching any runtime code.
  The same file also skips the development-only OpenNext Cloudflare initializer
  when `NEXT_PUBLIC_RAINTOOL_EMBEDDED=true`; RainTool runs the ordinary local
  Next server and does not provide a Cloudflare/workerd runtime. Finally,
  `experimental.isrFlushToDisk=false` keeps image/ISR caches in memory so a
  packaged or signed application never writes inside its Resources directory.
- `UPSTREAM_VERSION`: records the exact upstream and draw.io versions consumed
  by the root build scripts.
- This file documents the delta. No AI provider, chat, upload, model setting,
  API route, or AI message-history logic is changed. Diagram XML transport and
  persistence are intentionally integrated with RainTool.

The root build generates `public/drawio/`, `.next/`, and `node_modules/`; they
are build artifacts and must not be committed.

## Build architecture

RainTool ships an arm64 macOS Electron whose bundled Node is arm64
(v20.18.3). The root `scripts/build-next-standalone.mjs` installs vendor
dependencies and builds Next.js under that same arm64 Node so every native
binary matches the packaged runtime:

- `npm ci --cpu=arm64 --os=darwin --ignore-scripts` runs under Electron's Node
  via a `node` PATH shim (`ELECTRON_RUN_AS_NODE=1`). `--cpu` selects arm64
  optional packages; `--ignore-scripts` skips broken cross-arch postinstall
  scripts (esbuild, electron). Native binaries are resolved at runtime via
  `process.arch`, which is `arm64` under Electron Node.
- `next build` runs under the same Electron arm64 Node so `lightningcss` and
  other `process.arch`-aware packages resolve to their arm64 `.node` files.
- The build explicitly loads `sharp` and `lightningcss` under Electron's arm64
  Node before compiling. `scripts/verify-next-standalone.mjs` then inspects the
  file contents of every traced `.node`/`.dylib`/`.so`/`.dll` and fails unless
  it is a Mach-O binary containing an arm64 slice.
- The assembled standalone excludes `.next/cache`; the verifier rejects it so
  build-host or runtime cache data can never enter the application bundle.

`--ignore-scripts` skips every dependency lifecycle script, so an upstream
upgrade must audit newly added scripts before retaining this build strategy.
Do not run `npm ci` directly in this directory with the system Node — it would
install x64 binaries that cannot load under the packaged app.

See `docs/ai-drawio-upgrade.md` in the RainTool repository before replacing
this snapshot. Reapply this small patch after copying a new verified upstream
revision, then run the complete acceptance checklist.
