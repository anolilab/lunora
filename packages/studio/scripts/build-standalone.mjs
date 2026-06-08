// Builds a self-contained, browser-ready studio bundle for the `@cirrus/vite`
// dev route. Unlike `dist/index.mjs` / `dist/mount.mjs` (library output with
// react externalised), this bundle inlines react and every dependency so it can
// be served as a plain static script — no host bundler, no HMR, not editable.
//
// It bundles the *already-built* dist mount entry rather than the TS source, so
// esbuild never has to resolve the project's NodeNext `.js` import specifiers.
// Run after `packem build`. packem's extension depends on its `runtime` setting
// (`browser` → `.js`, `node` → `.mjs`), so detect whichever it produced rather
// than hard-coding one.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

const mountEntry = ["dist/mount.js", "dist/mount.mjs"].find((candidate) => existsSync(join(process.cwd(), candidate)));

if (mountEntry === undefined) {
    throw new Error("build-standalone: no dist/mount.{js,mjs} found — run `packem build` first.");
}

// Synthetic entry: pull the named export from the built library and mount it,
// reading per-server config the host injects on `globalThis` before this loads
// (the `@cirrus/vite` dev route sets the mount basepath and, on loopback, the
// admin token). Both are optional — absent, the studio mounts at the root and
// prompts for a token, as a plain static deploy would.
const entry = [
    `import { mountStudio } from "./${mountEntry}";`,
    "const g = globalThis;",
    "mountStudio({",
    '  basePath: typeof g.__CIRRUS_BASE_PATH__ === "string" ? g.__CIRRUS_BASE_PATH__ : "/",',
    '  adminToken: typeof g.__CIRRUS_ADMIN_TOKEN__ === "string" && g.__CIRRUS_ADMIN_TOKEN__ !== "" ? g.__CIRRUS_ADMIN_TOKEN__ : undefined,',
    "});",
].join("\n");

const baseOptions = {
    stdin: {
        contents: entry,
        loader: "js",
        resolveDir: process.cwd(),
        sourcefile: "standalone-entry.js",
    },
    bundle: true,
    format: "esm",
    minify: true,
    // The studio is a browser SPA.
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
};

// Some bundled deps (e.g. `@base-ui/react`) compile JSX to `jsxDEV`
// (`react/jsx-dev-runtime`), which React only *exports* from its DEVELOPMENT
// build; under `NODE_ENV=production` that module lacks `jsxDEV`, so the bundle
// loads to `jsxDEV is not a function`. The marker lives in a transitive dep, not
// our own dist, so detect it from the actual bundle output rather than guessing:
// probe-build in memory, and only ship the production React paths when nothing in
// the graph needs the dev JSX runtime.
const probe = await build({ ...baseOptions, define: { "process.env.NODE_ENV": '"production"' }, write: false });
const nodeEnv = probe.outputFiles.some((file) => file.text.includes("jsxDEV")) ? "development" : "production";

await build({
    ...baseOptions,
    outfile: "dist/standalone/studio.js",
    // React libraries gate dev-only warnings/checks (and the jsx vs jsxDEV
    // runtime) on this; match it to what the bundle graph actually needs.
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    logLevel: "info",
});

console.log(`build-standalone: NODE_ENV=${nodeEnv}`);
