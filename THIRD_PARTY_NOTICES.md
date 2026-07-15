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
  local draw.io URL, and enable draw.io offline mode.
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
