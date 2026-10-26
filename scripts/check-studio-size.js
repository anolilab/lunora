#!/usr/bin/env node
/**
 * Weighs what a browser must download and evaluate before Lunora Studio
 * (`/__lunora` under `lunora dev`) can paint, and fails when it grows past a
 * committed ceiling — the Studio counterpart of `check-worker-size.js`.
 *
 * The number is the standalone bundle's FIRST-LOAD closure: `studio.js` plus every
 * chunk it reaches through static `import` statements. Dynamic `import()` chunks
 * (the route-level lazy panels, the Home sparkline, the theme indicator) are
 * excluded — they load on demand, and keeping heavy dependencies behind them is
 * exactly what this gate protects. A static import of `recharts` or `motion` from
 * the shell shows up here as a jump of 100+ KiB.
 *
 * gzip is the regression signal (it tracks code, not minifier noise), even though
 * the `lunora dev` hosts serve the files uncompressed; raw bytes are printed too.
 *
 * Usage:
 *   pnpm run studio-size:check     # fail when the first load exceeds the ceiling
 *   pnpm run studio-size:update    # re-baseline after an intentional increase
 *
 * PREREQUISITE: a PRODUCTION build of `@lunora/studio` and its dependencies
 * (`pnpm exec vis run build:prod --query "project=studio"`). A development build
 * of `@lunora/react` makes `build-standalone.mjs` fall back to React's development
 * build — roughly double the entry — which the `jsxDEV` check below refuses to
 * measure.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(rootDir, "studio-size.json");
const standaloneDir = join(rootDir, "packages", "studio", "dist", "standalone");
const update = process.argv.includes("--update");

const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

// esbuild's minified ESM writes static imports as `import{a as b}from"./chunk-X.js"`
// or `import"./chunk-X.js"`; a dynamic import is `import("./chunk-X.js")`, which the
// quote-right-after-`import`/`from` shape deliberately does not match.
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*"\.\/([\w-]+\.js)"/g;

if (!existsSync(join(standaloneDir, "studio.js"))) {
    fail(`check-studio-size: ${join(standaloneDir, "studio.js")} is missing — build @lunora/studio (production) first.`);
}

const closure = new Set();
const visit = (file) => {
    if (closure.has(file)) {
        return;
    }

    closure.add(file);

    for (const match of readFileSync(join(standaloneDir, file), "utf8").matchAll(STATIC_IMPORT)) {
        visit(match[1]);
    }
};

visit("studio.js");

let rawBytes = 0;
let gzipBytes = 0;

for (const file of closure) {
    const bytes = readFileSync(join(standaloneDir, file));

    rawBytes += bytes.length;
    gzipBytes += gzipSync(bytes).length;
}

// Same marker `build-standalone.mjs` keys its NODE_ENV choice on: present, it
// shipped React's development build, and the number would be meaningless.
const devBuild = readdirSync(standaloneDir).some((file) => file.endsWith(".js") && readFileSync(join(standaloneDir, file), "utf8").includes("jsxDEV"));

if (devBuild) {
    fail("check-studio-size: the standalone bundle contains `jsxDEV` — it was built against a development dist. Rebuild with `build:prod`.");
}

const baseline = JSON.parse(readFileSync(fixturePath, "utf8"));
const ceiling = baseline.gzipBytes + baseline.allowanceBytes;

process.stdout.write(
    `studio first load: ${String(closure.size)} files, ${kib(rawBytes)} raw, ${kib(gzipBytes)} gzipped — ` +
        `baseline ${kib(baseline.gzipBytes)}, ceiling ${kib(ceiling)}\n`,
);

if (update) {
    const delta = gzipBytes - baseline.gzipBytes;

    writeFileSync(fixturePath, `${JSON.stringify({ ...baseline, files: closure.size, gzipBytes, rawBytes }, undefined, 4)}\n`, "utf8");
    process.stdout.write(`studio-size.json updated: ${delta >= 0 ? "+" : ""}${kib(delta)} gzipped against the previous baseline.\n`);

    process.exit(0);
}

if (gzipBytes > ceiling) {
    fail(
        `Lunora Studio's first load grew past its ceiling.\n` +
            `  now:      ${kib(gzipBytes)} gzipped (${kib(rawBytes)} raw, ${String(closure.size)} files)\n` +
            `  baseline: ${kib(baseline.gzipBytes)} gzipped, + ${kib(baseline.allowanceBytes)} allowance = ${kib(ceiling)}\n` +
            `Something heavy is now imported statically by the shell. Load it behind a \`React.lazy\` /\n` +
            `\`import()\` boundary, or if the growth is intended, accept it with \`pnpm run studio-size:update\`\n` +
            `so the increase is visible in review rather than buried.`,
    );
}
