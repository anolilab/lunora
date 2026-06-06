// Builds a self-contained, browser-ready dashboard bundle for the `@cirrus/vite`
// dev route. Unlike `dist/index.mjs` / `dist/mount.mjs` (library output with
// react externalised), this bundle inlines react and every dependency so it can
// be served as a plain static script — no host bundler, no HMR, not editable.
//
// It bundles the *already-built* dist mount entry rather than the TS source, so
// esbuild never has to resolve the project's NodeNext `.js` import specifiers.
// Run after `packem build`. packem's extension depends on its `runtime` setting
// (`browser` → `.js`, `node` → `.mjs`), so detect whichever it produced rather
// than hard-coding one.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { join } from "node:path";

const mountEntry = ["dist/mount.js", "dist/mount.mjs"].find((candidate) => existsSync(join(process.cwd(), candidate)));

if (mountEntry === undefined) {
    throw new Error("build-standalone: no dist/mount.{js,mjs} found — run `packem build` first.");
}

// Synthetic entry: pull the named export from the built library and mount it,
// reading per-server config the host injects on `globalThis` before this loads
// (the `@cirrus/vite` dev route sets the mount basepath and, on loopback, the
// admin token). Both are optional — absent, the dashboard mounts at the root and
// prompts for a token, as a plain static deploy would.
const entry = [
    `import { mountDashboard } from "./${mountEntry}";`,
    "const g = globalThis;",
    "mountDashboard({",
    '  basePath: typeof g.__CIRRUS_BASE_PATH__ === "string" ? g.__CIRRUS_BASE_PATH__ : "/",',
    '  adminToken: typeof g.__CIRRUS_ADMIN_TOKEN__ === "string" && g.__CIRRUS_ADMIN_TOKEN__ !== "" ? g.__CIRRUS_ADMIN_TOKEN__ : undefined,',
    "});",
].join("\n");

await build({
    stdin: {
        contents: entry,
        loader: "js",
        resolveDir: process.cwd(),
        sourcefile: "standalone-entry.js",
    },
    bundle: true,
    format: "esm",
    outfile: "dist/standalone/dashboard.js",
    minify: true,
    // React libraries gate dev-only warnings/checks on this; set it so the
    // bundle ships the production code paths.
    define: { "process.env.NODE_ENV": '"production"' },
    // The dashboard is a browser SPA.
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
    logLevel: "info",
});
