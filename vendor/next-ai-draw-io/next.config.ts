import path from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"
import packageJson from "./package.json"

// RainTool embeds this app as a standalone server built from a nested
// `vendor/` directory. Next.js 16 infers the monorepo root from the nearest
// .git (the RainTool repo root) and nests the standalone output under
// `vendor/next-ai-draw-io/`, so server.js does not land at
// `.next/standalone/server.js` where the root build script and verifier expect
// it. Pin the tracing root to this directory so the standalone layout stays
// flat without touching any runtime code.
//
// This file is part of the next-ai-draw-io source snapshot (Apache-2.0, see
// LICENSES/next-ai-draw-io-APACHE-2.0.txt). RainTool's three configuration
// changes are documented in RAINTOOL_INTEGRATION.md.
const projectRoot = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
    /* config options here */
    output: "standalone",
    outputFileTracingRoot: projectRoot,
    // A packaged/signed app bundle is immutable. Keep Next's image/ISR cache
    // in memory so runtime requests never write into Resources/.next/cache.
    experimental: {
        isrFlushToDisk: false,
    },
    // Support for subdirectory deployment (e.g., https://example.com/nextaidrawio)
    // Set NEXT_PUBLIC_BASE_PATH environment variable to your subdirectory path (e.g., /nextaidrawio)
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
    env: {
        APP_VERSION: packageJson.version,
    },
    // Include instrumentation.ts in standalone build for Langfuse telemetry
    outputFileTracingIncludes: {
        "*": ["./instrumentation.ts"],
    },
}

export default nextConfig

// Initialize OpenNext Cloudflare for local development only
// This must be a dynamic import to avoid loading workerd binary during builds
if (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_RAINTOOL_EMBEDDED !== "true"
) {
    import("@opennextjs/cloudflare").then(
        ({ initOpenNextCloudflareForDev }) => {
            initOpenNextCloudflareForDev()
        },
    )
}
