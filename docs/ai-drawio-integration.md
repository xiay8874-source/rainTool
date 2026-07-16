# RainTool AI Draw.io integration

## Architecture and ownership

RainTool embeds the complete `next-ai-draw-io` Next.js application instead of
rewriting its AI pipeline. The vendored application continues to own model
providers, streaming chat, Draw.io editing, uploads, AI session/history, and
settings. RainTool owns persistent diagram identity/XML/versioning, the
Electron process, its tool/tab UI, local server lifecycle, IPC/MCP boundaries,
navigation policy, packaging, updating, and shutdown.

```text
RainTool renderer
  ├─ 图纸管理
  └─ one AI 画图 tab per persistent diagramId
       └─ iframe http://127.0.0.1:{6002|13370}/zh
            ├─ Next.js API routes / AI providers
            └─ local /drawio/index.html (offline editor assets)

RainTool main process
  ├─ diagram repository + authenticated MCP bridge (:13371)
  └─ ai-drawio-service
       └─ production (packaged & unpackaged): utilityProcess.fork(.../next-standalone/server.js)
       └─ dev (RAINTOOL_AI_DRAWIO_DEV=1): wait for external Next dev on :6002
```

The upstream Electron window, menu, preload, settings window, proxy manager,
port allocator, updater, and packager are not used. The upstream source delta
is deliberately limited and recorded in
`vendor/next-ai-draw-io/RAINTOOL_INTEGRATION.md`.

## Runtime and data flow

- RainTool creates its main window immediately. It does not start or wait for
  Next.js during application startup.
- Opening **AI 工具 → AI 画图** creates a persistent document and heavyweight
  editor tab. The same `diagramId` is single-instance, while different diagrams
  can remain open in separate keep-alive tabs. Duplicating a page creates a new
  document rather than a second view of the original.
- The component calls the fixed `startAiDrawio()` preload API. Concurrent calls
  share one start promise. No renderer-provided path, port, environment, or
  command is accepted.
- The unified dev command explicitly launches Electron with
  `RAINTOOL_AI_DRAWIO_DEV=1`, which makes it wait for Next dev on
  `127.0.0.1:6002`. Without that marker, unpackaged production checks use
  `build/next-standalone`; packaged builds use `Resources/next-standalone`.
  Both production-style modes fork with `cwd` at the standalone root and poll
  `/zh` plus `/drawio/index.html` for up to 30 seconds.
- Production always uses `127.0.0.1:13370`. A conflict returns `PORT_IN_USE`;
  no fallback port is selected because changing the origin would hide the
  user's browser storage.
- Normal quit awaits the existing RainTool workspace flush and the AI server
  stop together. The update installer does the same before `app.exit(0)`.
  `will-quit` only performs a synchronous best-effort kill fallback.
- Next.js image/ISR disk flushing is disabled for the embedded production
  server. Runtime caches stay in memory, `.next/cache` is excluded from the
  standalone, and verification rejects any cache inside the app bundle. This
  keeps packaged and future signed applications immutable.

The upstream application stores its BYOK model configuration, UI preferences,
AI sessions and templates in browser storage (including IndexedDB) under the
fixed `http://127.0.0.1:13370` origin. RainTool stores canonical diagram XML and
metadata under `~/raintool/diagrams`; a one-time migration copies diagram XML
only and leaves chat/API keys in the upstream origin. API keys therefore have the same
local-at-rest protection as upstream browser localStorage; they are not placed
in macOS Keychain in this version. AI calls require network access, while the
bundled Draw.io editor remains available offline.

## Security and desktop behavior

- The server binds only to loopback. The IPC handler accepts calls only from
  RainTool's top-level renderer and exposes a parameterless start operation.
- The iframe intentionally has no HTML `sandbox`: the trusted, pinned upstream
  app needs uploads, downloads, localStorage/IndexedDB, scripts, and nested
  Draw.io behavior. Clipboard access is declared explicitly.
- Electron allows frame navigation only to local RainTool, AI, and Draw.io
  origins. External HTTP(S) links are denied in-app and opened with the system
  browser. New windows are always denied, so an embedded page cannot replace
  the RainTool top-level page.
- Draw.io `beforeunload` prompts are ignored during RainTool's controlled quit
  flow, preventing an in-progress text edit from trapping application exit.
- The embedded build sets `NEXT_PUBLIC_RAINTOOL_EMBEDDED=true`, the absolute
  local Draw.io URL, and `offline=true`; it does not rely on the unavailable
  upstream `window.electronAPI` inside the iframe.

## Source, development, and packaging

Important paths:

- `vendor/next-ai-draw-io/`: fixed, buildable upstream source snapshot.
- `vendor/next-ai-draw-io/components/raintool-drawio-embed.tsx`: minimal
  message bridge for the nested Draw.io iframe. It must attach its listener
  before the iframe is created; upstream's passive-effect timing can miss the
  local editor's initial `init` event and leave the page gray. It accepts
  messages only from the actual iframe `contentWindow`.
- `electron/ai-drawio-service.ts`: lifecycle and structured start failures.
- `scripts/build-next-standalone.mjs`: fixed Draw.io preparation, `npm ci`,
  embedded Next.js build, standalone assembly, and symlink flattening.
- `scripts/verify-next-standalone.mjs`: source-output completeness, symlink,
  and native Mach-O architecture verification.
- `scripts/verify-packaged-ai.mjs`: post-electron-builder verification of the
  actual app bundle, DMG, licenses, notices, Next runtime, and arm64 binaries.
- `electron/diagram-repository.ts` and `electron/diagram-bridge-server.ts`:
  canonical diagram storage, revision conflicts, and authenticated loopback RPC.
- `vendor/next-ai-draw-io/packages/mcp-server/src/raintool-index.ts`: official
  MCP workflow adapted to the persistent RainTool store, including multi-page
  tools and the guided draft → edit → inspect → preview → finalize flow.
- `vendor/next-ai-draw-io/packages/mcp-server/src/pages.ts`, `edit-gate.ts`,
  `load-diagram.ts`, and `diagram-inspection.ts`: page-scoped XML operations,
  content-fingerprint manual-edit protection, compressed file loading, and
  RainTool's deterministic layout checks.
- `build/next-standalone/`: generated package input; never committed.
- `LICENSES/` and `THIRD_PARTY_NOTICES.md`: distributable notices.

Prerequisites are the root dependency installation (`npm ci`), a Node.js
version supported by Next.js 16, network access for the first fixed Draw.io
archive/dependency download, and macOS for DMG packaging.

```bash
# Vite :5173 + Next dev :6002 + Electron; Ctrl-C cleans up every child process
npm run dev

# RainTool checks (do not build AI standalone)
npm run build
npm run build:electron
npm run test:diagrams
npm run build:mcp
npm run verify:mcp

# Local production-style run; builds and forks build/next-standalone on :13370
npm run start:prod

# Deterministic AI install/build and resource verification
npm run build:ai
npm run verify:ai

# Verify an already-built app bundle and DMG
npm run verify:package:ai

# AI build + RainTool build + Electron build + arm64 DMG + package verification
npm run dist
```

`build:ai` verifies the vendored version metadata, downloads the exact Draw.io
commit archive, validates its pinned SHA-256 and `VERSION`, excludes server-only
`WEB-INF`/`META-INF`, and installs the target dependencies with
`npm ci --cpu=arm64 --os=darwin --ignore-scripts` (never `npm install`). It
loads the required native modules and builds Next under Electron's arm64 Node,
copies `.next/static` and `public`, flattens symlinks, and inspects the actual
native binary contents. It removes `.next/cache`, and both standalone and
package verification reject any writable cache in Resources. The skipped
lifecycle scripts belong to the complete
vendored dependency graph, including upstream desktop-development tooling; a
version upgrade must audit them before keeping this exception.

electron-builder normally excludes a directory named `node_modules` from a
broad resource matcher. `package.json` therefore uses a second explicit
`extraResources` matcher rooted at `build/next-standalone/node_modules`.
It also sets `electronDist=node_modules/electron/dist`, reusing the same
arm64 Electron runtime already inspected by `build:ai` instead of downloading
a second runtime during packaging.
`npm run dist` fails if the resulting app lacks `node_modules/next`, either
license, the third-party notice, the Draw.io assets, an arm64 Electron binary,
or an arm64-compatible standalone native module. Generated Draw.io, `.next`,
`node_modules`, cache, standalone, and DMG outputs are ignored by Git.

The dev launcher binds Vite and Next to loopback, starts Next and all of its
Turbopack children with Electron's arm64 Node through a temporary PATH shim,
and gives each service its own process group. The embedded development mode
skips the unrelated OpenNext Cloudflare initializer. Ctrl-C terminates the
groups (including grandchildren) and treats a remaining listener on 5173 or
6002 as a failure.

## Dependency audit baseline

On 2026-07-16, `npm audit --omit=dev --audit-level=critical` reported no
critical advisory for the pinned upstream dependency graph. npm did report
high-severity advisories in nine packages in the complete upstream graph, but
none of those packages is present in the traced standalone. The packaged tree
does contain Next's PostCSS dependency with a moderate advisory. Do not run an
unreviewed `npm audit fix` against the pinned snapshot; address advisories by
reviewing a fixed upstream revision (or a separately documented minimal lock
file override), rebuilding, and auditing the actual traced package again.

## Failure codes and troubleshooting

- `PORT_IN_USE`: find the owner with `lsof -nP -iTCP:13370 -sTCP:LISTEN`, stop
  it, and click **重试启动**. RainTool will not switch ports.
- `MISSING_RESOURCE`: the app lacks `Resources/next-standalone/server.js`;
  rebuild with `npm run dist` or reinstall a complete DMG.
- `START_TIMEOUT`: the app and local Draw.io pages did not both become ready in
  30 seconds. In development use `npm run dev`; in a package, inspect the
  service's technical details and retry.
- `START_FAILED`: inspect the displayed stdout/stderr tail. Dependency or
  executable incompatibility normally requires rebuilding the package.
- An iframe-only error offers **重新加载** without restarting the server.
- A persistent gray AI canvas after server readiness indicates a Draw.io
  initialization handshake failure. Verify that the locally maintained
  `raintool-drawio-embed.tsx` is still used by `app/[lang]/page.tsx`, then
  rebuild with `npm run build:ai`; do not paper over it by changing ports or
  allowing external Draw.io hosts.
- If manipulating shapes or editing labels is repeatedly interrupted, inspect
  `src/components/tools/ai-drawio.tsx`. The `onDiagramChanged` event that
  acknowledges this renderer's own autosave must update only the local
  revision/XML state; it must not call `loadDocumentIntoFrame`. Reloading the
  iframe is reserved for an external/MCP update or a revision conflict.
- To verify offline editor packaging manually, disconnect the network after
  startup and load `http://127.0.0.1:13370/drawio/index.html`; the editor assets
  must still return locally.

See `docs/ai-drawio-upgrade.md` for version changes and rollback.
