# Third-party notices

RainTool includes the following third-party software in its AI drawing feature.

## next-ai-draw-io

- Project: <https://github.com/DayuanJiang/next-ai-draw-io>
- Version: v0.4.16
- Commit: `1115b2d2cdc30ffb7f7b83e1328d3ea00f8de887`
- License: Apache License 2.0
- License copy: `LICENSES/next-ai-draw-io-APACHE-2.0.txt`

RainTool distributes a modified source snapshot. The functional source changes
are:

- `app/[lang]/page.tsx`: recognize RainTool's embedded mode, use the configured
  local draw.io URL, enable draw.io offline mode, and bridge canonical diagram
  load/autosave/export plus diagram-only legacy migration.
- `packages/mcp-server/src/raintool-index.ts`: reuse upstream XML validation and
  ID-based edit operations with RainTool's authenticated diagram store and MCP
  management tools.
- `packages/mcp-server/package.json`: pin reviewed patched AJV/fast-uri
  transitive versions used by the distributed MCP bundle.
- `next.config.ts`: pin `outputFileTracingRoot` to this directory so the
  standalone build emits `server.js` at the standalone root instead of nesting
  it under `vendor/next-ai-draw-io/` (Next.js 16 otherwise infers the RainTool
  repo root as the monorepo root), skip the unrelated OpenNext Cloudflare
  initializer in RainTool development, and keep image/ISR caches in memory so
  packaged or signed application resources remain immutable.

The snapshot also adds integration/version documentation. RainTool does not
reuse the upstream Electron shell.

## diagrams.net / draw.io

- Project: <https://github.com/jgraph/drawio>
- Version: v29.0.3
- Commit: `e159fbf1b1446a37dd68e952ac3db7519735e4f4`
- License: Apache License 2.0
- License copy: `LICENSES/drawio-APACHE-2.0.txt`

The packaged copy is generated from `src/main/webapp` at the fixed commit.
Server-only `WEB-INF` and `META-INF` directories are excluded. RainTool does
not modify draw.io source files.

The distributed app contains each license under `Resources/licenses/` and this
notice at `Resources/THIRD_PARTY_NOTICES.md`.

The bundled RainTool MCP server also contains the MCP SDK, XML DOM/parser, XML
selector and schema-validation dependencies selected by its esbuild metafile.
Their exact package versions and license texts are generated at build time in
`Resources/raintool-mcp/THIRD_PARTY_LICENSES.txt`.

## AI Platform runtime dependencies

The general AI Assistant (P1) depends on the following Node-20-compatible
runtime packages. They are pinned to the versions below to stay within the
embedded Node 20.18.3 runtime of Electron 33 (see
`docs/ai-platform-p0-spike.md`). No AGPL, Fair Source, or SSPL code is used.

### ai (Vercel AI SDK core)

- Project: <https://github.com/vercel/ai>
- Version: `5.0.216`
- License: Apache License 2.0
- License copy: `LICENSES/ai-APACHE-2.0.txt`
- `engines.node`: `>=18` (verified against the npm registry)

### @ai-sdk/openai

- Project: <https://github.com/vercel/ai> (`packages/openai`)
- Version: `2.0.114` (paired with `ai@5.0.216` — both depend on
  `@ai-sdk/provider@2.0.3` and `@ai-sdk/provider-utils@3.0.30`; later
  `@ai-sdk/openai@3.x` requires `@ai-sdk/provider@3.x` and is incompatible
  with `ai@5`. See `docs/ai-platform-p0-spike.md` §3 P0 correction.)
- License: Apache License 2.0
- License copy: `LICENSES/ai-sdk-openai-APACHE-2.0.txt`
- `engines.node`: `>=18`

Transitive runtime dependencies pulled by `ai` and `@ai-sdk/openai`
(`@ai-sdk/provider@2.0.3`, `@ai-sdk/provider-utils@3.0.30`,
`@ai-sdk/gateway@2.0.115`) are likewise Apache-2.0 and declare
`engines.node: ">=18"`. They are not distributed as source; their license
texts ship inside `node_modules` at install time.

### zod

- Project: <https://github.com/colinhacks/zod>
- Version: `3.25.76`
- License: MIT
- License copy: `LICENSES/zod-MIT.txt`

### @modelcontextprotocol/sdk (MCP TypeScript SDK)

- Project: <https://github.com/modelcontextprotocol/typescript-sdk>
- Version: `1.29.0` (P4: production-stable v1.x; do NOT upgrade to v2/main)
- License: MIT
- License copy: `LICENSES/modelcontextprotocol-sdk-MIT.txt`
- Scope: main-process MCP client (stdio + loopback HTTP). The SDK's HTTP
  server/OAuth/sampling dependencies are transitive and not imported by
  RainTool; an esbuild metafile of the vendored raintool-mcp server (which
  pins the same `^1.0.4` range) confirms the stdio path does not pull them in.

## Git Workbench runtime dependencies

The Git Workbench (Task 2) renders unified diffs in an embedded Monaco
DiffEditor. Monaco loads from the bundled package (offline; no CDN).

### monaco-editor

- Project: <https://github.com/microsoft/monaco-editor>
- Version: `0.52.2`
- License: MIT
- License copy: `LICENSES/monaco-editor-MIT.txt`
- Scope: the DiffEditor widget used by the Git Workbench. Loaded in the
  renderer via the local bundle (see `loader.config` in
  `src/components/tools/git-workbench.tsx`); no network requests.

### @monaco-editor/react

- Project: <https://github.com/suren-atoyan/monaco-react>
- Version: `4.7.0`
- License: MIT
- License copy: `LICENSES/monaco-editor-react-MIT.txt`
- Scope: React wrapper that mounts the Monaco DiffEditor. Its `loader` is
  configured to resolve `monaco-editor` from the local bundle.

The distributed app contains each license under `Resources/licenses/`.
