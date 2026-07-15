# Upgrading the embedded AI Draw.io

## Pinned baseline

| Component | Version | Immutable revision |
| --- | --- | --- |
| next-ai-draw-io | v0.4.16 | `1115b2d2cdc30ffb7f7b83e1328d3ea00f8de887` |
| jgraph/drawio | v29.0.3 | `e159fbf1b1446a37dd68e952ac3db7519735e4f4` |

The Draw.io archive SHA-256 is
`e6d39c6957a575fafd47c67d69fa550517afca4de0f96e530a18b173b9f41d77`.
RainTool must never build from a floating `main`, `latest`, an unverified tag,
or `git submodule update --remote`. Version updates are explicit source and
package changes reviewed in a dedicated branch. This protects packaging,
browser-origin storage compatibility, and the AI SDK/Next.js runtime contract.

## Upgrade procedure

1. Read the target release notes and commits. Review changes to Next.js/React,
   Vercel AI SDK providers, API routes, `next.config`, `app/[lang]/page.tsx`,
   `react-drawio`, storage schemas/keys, uploads, exports, and Electron build
   preparation. Treat every 0.x release as potentially breaking.
2. Resolve and verify the exact upstream revision before copying:

   ```bash
   git clone --branch <tag> --depth 1 https://github.com/DayuanJiang/next-ai-draw-io.git /tmp/next-ai-draw-io
   git -C /tmp/next-ai-draw-io rev-parse HEAD
   git -C /tmp/next-ai-draw-io describe --tags --exact-match
   ```

   Both outputs must match the approved tag/commit. Do the equivalent for a
   Draw.io upgrade and record the peeled commit. Never infer a commit from a
   release page alone.
3. Save a diff of RainTool's current snapshot against the old upstream commit.
   Replace `vendor/next-ai-draw-io/` with the complete new source, excluding
   `.git`, `node_modules`, `.next`, Electron build output, and other generated
   files. Keep the new upstream `package-lock.json`, tests, LICENSE, and build
   scripts. Do not transplant only selected AI files.
4. Reapply only the documented RainTool delta:

   - embedded detection in `app/[lang]/page.tsx`, preserving the upstream
     `NEXT_PUBLIC_DRAWIO_BASE_URL` behavior and forcing offline mode;
   - `next.config.ts`: pin `outputFileTracingRoot` to the vendor directory so
     the standalone build emits `server.js` at the standalone root (Next.js 16
     otherwise nests it under `vendor/next-ai-draw-io/`), and skip the
     development-only OpenNext Cloudflare initializer when
     `NEXT_PUBLIC_RAINTOOL_EMBEDDED=true`; retain
     `experimental.isrFlushToDisk=false` so packaged/signed Resources remain
     immutable at runtime;
   - `UPSTREAM_VERSION` with exact upstream and Draw.io revisions;
   - `RAINTOOL_INTEGRATION.md` with the new per-file delta.

   Do not modify providers, chat, XML operations, uploads, history, settings,
   API routes, or storage unless an upgrade-specific compatibility fix is
   separately justified and documented.
5. Update the pinned constants and archive checksum in
   `scripts/build-next-standalone.mjs`, this document, integration docs, and
   `THIRD_PARTY_NOTICES.md`. Replace the matching license copies when upstream
   license text changes. A cached Draw.io archive must be re-hashed; an invalid
   cache is never accepted.
6. Review the resulting source diff. It should contain the complete upstream
   update plus a small, obvious RainTool adaptation. Search for accidental
   upstream Electron integration and floating downloads:

   ```bash
   rg -n 'main|latest|update --remote' scripts vendor/next-ai-draw-io/UPSTREAM_VERSION
   git diff -- vendor/next-ai-draw-io
   ```

## Validation and acceptance

Run from clean dependency/build state where practical:

```bash
npm ci
npm run build:ai
npm run verify:ai
# Use a native arm64 Node that satisfies the vendored development-tool engines
# (Node 22.12+; Node 24 LTS is recommended). Do not use Electron's Node 20 for
# Vitest 4, and do not use an x64/Rosetta system Node with arm64 dependencies.
ARM64_NODE=/absolute/path/to/native-arm64-node
(cd vendor/next-ai-draw-io && "$ARM64_NODE" node_modules/@biomejs/biome/bin/biome ci)
(cd vendor/next-ai-draw-io && "$ARM64_NODE" node_modules/vitest/vitest.mjs --run)
(cd vendor/next-ai-draw-io && npm audit --omit=dev --audit-level=critical)
npm run build
npm run build:electron
npm run dist
npm run verify:package:ai
```

`build:ai` installs vendor dependencies with `npm ci --cpu=arm64 --os=darwin
--ignore-scripts` under Electron's bundled arm64 Node (via a `node` PATH shim),
then runs `next build` under the same arm64 Node. This guarantees every native
binary (`.node`/`.dylib`) targets arm64, matching the packaged Electron
runtime. `--ignore-scripts` skips all dependency lifecycle scripts because the
complete upstream dependency graph includes desktop-development installers
that cannot safely install another Electron bundle inside Electron Node.
RainTool compensates by loading required native modules under arm64, completing
`next build`, inspecting every traced native binary's file contents, and
verifying the packaged app. During every upgrade, audit all new or changed
lifecycle scripts; remove this exception or add an explicit safe replacement
if a newly required build/runtime step appears. Do not run
`npm --prefix vendor/next-ai-draw-io ci` directly — it would install the system
Node's architecture and can produce x64 binaries for the arm64 package.
`build:ai` also rejects a root Electron binary without an arm64 slice. On an
Intel-only build host, provision an arm64-capable Electron/Node build runtime
before packaging; do not weaken the architecture check. electron-builder
reuses that inspected runtime through `build.electronDist`, so packaging does
not fetch an unverified second Electron distribution.

Review the complete audit output even when the configured severity threshold
passes, then compare every reported package with the traced
`build/next-standalone/node_modules` tree. Never apply `npm audit fix` blindly:
it can replace pinned framework/provider versions or introduce breaking
changes. Record accepted residual advisories and their shipped reachability in
the release notes.

Then install and launch the generated DMG, and verify:

- RainTool opens immediately; AI service starts only on first AI tab open.
- The AI tool is single-instance across open, duplicate, favorites, and restart.
- `/zh` and `/drawio/index.html` load from loopback; Draw.io still opens with
  external network disabled.
- A real BYOK provider streams a new diagram, edits it over multiple turns, and
  reports model errors clearly.
- Existing model settings, sessions/history, templates, theme, and language
  remain visible after upgrade. Any upstream storage migration is tested with
  a copy of real previous-version browser data.
- Image/PDF upload, clipboard, `.drawio`/PNG/SVG export and download work.
- External links open in the system browser and cannot navigate RainTool.
- Occupying `127.0.0.1:13370` produces `PORT_IN_USE` and never another port.
- Concurrent start requests create one server; retry succeeds after a resolved
  failure; quit and update installation leave no listener on port 13370.
- `Resources/next-standalone`, `Resources/next-standalone/node_modules/next`,
  licenses, and notices exist in the installed app. Both `npm run verify:ai`
  and `npm run verify:package:ai` report no standalone symlinks and no
  mismatched-architecture native binaries, and reject `.next/cache`.
- Hash or snapshot the packaged `Resources/next-standalone` tree before and
  after GUI smoke testing; it must not change.

Record tested macOS architecture, provider/model, DMG size, upstream test
exceptions with exact logs, and the approved RainTool commit in the release
notes. Automated dependency/release checks may open an issue or draft PR, but
must never merge or publish an upgrade automatically.

## Rollback

Revert the vendor snapshot, `UPSTREAM_VERSION`, build-script pins/checksum,
licenses/notices, and documentation to the last accepted RainTool commit, then
rebuild the DMG from clean dependencies. Do not change port 13370 during
rollback: retaining the origin is what makes the user's existing localStorage
and IndexedDB visible. If the new upstream performed a one-way storage schema
migration, document and test its supported downgrade path before release;
otherwise restore browser data from the pre-upgrade backup.
