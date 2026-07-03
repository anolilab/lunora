// Builds a self-contained, browser-ready studio bundle for the `@lunora/vite`
// dev route. Unlike `dist/index.mjs` / `dist/mount.mjs` (library output with
// react externalised), this bundle inlines react and every dependency so it can
// be served as a plain static script — no host bundler, no HMR, not editable.
//
// It bundles the *already-built* dist mount entry rather than the TS source, so
// esbuild never has to resolve the project's NodeNext `.js` import specifiers.
// Run after `packem build`. packem's extension depends on its `runtime` setting
// (`browser` → `.js`, `node` → `.mjs`), so detect whichever it produced rather
// than hard-coding one.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

const mountEntry = ["dist/mount.js", "dist/mount.mjs"].find((candidate) => existsSync(join(process.cwd(), candidate)));

if (mountEntry === undefined) {
    throw new Error("build-standalone: no dist/mount.{js,mjs} found — run `packem build` first.");
}

// Synthetic entry: pull the named export from the built library and mount it,
// reading per-server config the host injects on `globalThis` before this loads
// (the `@lunora/vite` dev route sets the mount basepath and, on loopback, the
// admin token). Both are optional — absent, the studio mounts at the root and
// prompts for a token, as a plain static deploy would.
const entry = [
    `import { mountStudio } from "./${mountEntry}";`,
    "const g = globalThis;",
    "mountStudio({",
    '  basePath: typeof g.__LUNORA_BASE_PATH__ === "string" ? g.__LUNORA_BASE_PATH__ : "/",',
    '  adminToken: typeof g.__LUNORA_ADMIN_TOKEN__ === "string" && g.__LUNORA_ADMIN_TOKEN__ !== "" ? g.__LUNORA_ADMIN_TOKEN__ : undefined,',
    // Editing and the run-as tool are opt-in: the loopback dev hosts inject
    // `__LUNORA_DATA_EDITABLE__` / `__LUNORA_RUN_AS_IDENTITY__`, so a plain static
    // deploy stays read-only and can't forge an identity unless the embedder opts in.
    "  studio: { dataEditable: g.__LUNORA_DATA_EDITABLE__ === true, runAsIdentity: g.__LUNORA_RUN_AS_IDENTITY__ === true, schemaEditable: g.__LUNORA_SCHEMA_EDITABLE__ === true },",
    // The loopback dev hosts inject `__LUNORA_RULES_INSTALLED__=false` when the
    // project's agent skills are missing; absent (static deploy) means installed.
    "  rulesInstalled: g.__LUNORA_RULES_INSTALLED__ !== false,",
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
    // `minify` mangles top-level function/class names, but some bundled deps
    // (e.g. `@floating-ui/react`, TanStack Router) branch on `Function.name` at
    // runtime — mangling flips those guards into a render loop that hangs the
    // data tab. `keepNames` restores the original `.name` after minification.
    keepNames: true,
    // The studio is a browser SPA.
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
};

// Some bundled deps (e.g. `@base-ui/react`) compile JSX to `jsxDEV`
// (`react/jsx-dev-runtime`), which React only *exports* from its DEVELOPMENT
// eslint-disable-next-line no-secrets/no-secrets -- prose mentioning the prod env flag, not a secret
// build; under `NODE_ENV=production` that module lacks `jsxDEV`, so the bundle
// loads to `jsxDEV is not a function`. The marker lives in a transitive dep, not
// our own dist, so detect it from the actual bundle output rather than guessing:
// probe-build in memory, and only ship the production React paths when nothing in
// the graph needs the dev JSX runtime.
const probe = await build({ ...baseOptions, define: { "process.env.NODE_ENV": '"production"' }, write: false });
const nodeEnv = probe.outputFiles.some((file) => file.text.includes("jsxDEV")) ? "development" : "production";

// esbuild appends to `outdir` without cleaning it, so stale (content-hashed)
// chunks from a previous build would pile up beside the current ones. Wipe the
// directory first so it holds exactly the entry + the chunks this build emits —
// what the three static hosts serve.
rmSync(join(process.cwd(), "dist/standalone"), { force: true, recursive: true });

await build({
    ...baseOptions,
    // Code-split output (not a single `outfile`): the route-level
    // `React.lazy(() => import(...))` boundaries in `app/studio.tsx` (and Home's
    // lazy `recharts` sparkline) become separate `chunk-*.js` files loaded on
    // demand. `splitting` + `outdir` require the esm format (already set) and a
    // directory; `entryNames: "studio"` keeps the entry at the `studio.js` name
    // the HTML `scriptSrc` and the host resolvers hardcode, and the chunks live
    // beside it, imported by relative path so the static hosts serve them from
    // the standalone directory. Heavy deps (`@xyflow/react`, `recharts`) end up
    // only in on-demand chunks, never in Home's first load.
    outdir: "dist/standalone",
    splitting: true,
    entryNames: "studio",
    chunkNames: "chunk-[hash]",
    assetNames: "asset-[hash]",
    // React libraries gate dev-only warnings/checks (and the jsx vs jsxDEV
    // runtime) on this; match it to what the bundle graph actually needs.
    define: { "process.env.NODE_ENV": JSON.stringify(nodeEnv) },
    logLevel: "info",
});

// eslint-disable-next-line no-console -- build-script progress output
console.log(`build-standalone: NODE_ENV=${nodeEnv}`);
