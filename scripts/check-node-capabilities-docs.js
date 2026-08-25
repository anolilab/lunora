#!/usr/bin/env node
/**
 * Guards against a host package's `docs/index.mdx` capability table and its
 * matrix in `packages/platform/src/capabilities.ts` drifting apart. Every host
 * that publishes such a page is checked — `platform-node` against
 * `NODE_CAPABILITIES`, `platform-rivet` against `RIVET_CAPABILITIES`.
 *
 * The filename still says "node" because a CI job
 * (`.github/workflows/lint.yml`), a path filter (`.github/file-filters.yml`)
 * and a root script name all key off it; renaming those is churn with no
 * safety gained. Add a host by adding a row to `HOSTS` below.
 *
 * The docs page states plainly (plan 329) that it reproduces the matrix
 * codegen actually gates `ctx.*` surfaces on, not a second hand-maintained
 * copy of it — the exact kind of drift `scripts/check-roadmap-tiers.js`
 * exists to catch for the tier taxonomy. This is the same guard for the
 * feature-by-feature ratings.
 *
 * Imports `capabilities.ts` directly via Node's built-in TypeScript type
 * stripping (no build step: the file is a plain `const` object with type
 * annotations) rather than regex-parsing the source text, because several
 * notes contain quotes, apostrophes and mixed quoting styles that a
 * text-only parser would have to special-case.
 *
 * Type stripping is unflagged by default only from Node 22.18 — CI's lint
 * jobs pin 22.15 (`.github/workflows/lint.yml`), which still needs the
 * `--experimental-strip-types` flag or this import throws
 * `ERR_UNKNOWN_FILE_EXTENSION`. `pnpm run lint:node-capabilities-docs`
 * (the only way this script runs — see the CI job in lint.yml) passes it;
 * don't invoke this file with a bare `node` on <22.18 without it.
 *
 * `pnpm run lint:node-capabilities-docs` — deliberately not wired into
 * `postinstall`: that chain fails every CI job at its setup step, and the
 * cause reads as "install failed" from wherever the job that ran it reports
 * from.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const capabilitiesPath = join(rootDir, "packages", "platform", "src", "capabilities.ts");

const capabilities = await import(pathToFileURL(capabilitiesPath).href);

/** Each host package that publishes a capability page, and the export it must match. */
const HOSTS = [
    { directory: "platform-node", matrix: "NODE_CAPABILITIES" },
    { directory: "platform-rivet", matrix: "RIVET_CAPABILITIES" },
];

/** One row per feature, keyed by feature name, parsed from the markdown table. */
const tableRowPattern = /^\|\s*`([a-zA-Z0-9]+)`\s*\|\s*`(native|emulated|unsupported)`\s*\|\s*(.+?)\s*\|\s*$/gmu;

let failed = false;

for (const { directory, matrix } of HOSTS) {
    const docsPath = join(rootDir, "packages", directory, "docs", "index.mdx");
    const features = capabilities[matrix]?.features;

    if (!features) {
        process.stderr.write(`check-node-capabilities-docs: packages/platform/src/capabilities.ts exports no \`${matrix}\`.\n`);
        failed = true;
        continue;
    }

    const docsSource = readFileSync(docsPath, "utf8");
    const rows = new Map();

    for (const match of docsSource.matchAll(tableRowPattern)) {
        const [, feature, level, note] = match;

        // The only escape a page needs: a leading `\_` on an identifier that
        // would otherwise open CommonMark emphasis at the start of a table cell.
        rows.set(feature, { level, note: note.replaceAll(String.raw`\_`, "_") });
    }

    const problems = [];

    for (const [feature, capability] of Object.entries(features)) {
        const row = rows.get(feature);

        if (!row) {
            problems.push(`  ${feature} — in ${matrix}, missing from the docs table`);
            continue;
        }

        if (row.level !== capability.level) {
            problems.push(`  ${feature} — docs says \`${row.level}\`, ${matrix} says \`${capability.level}\``);
        }

        if (row.note !== (capability.note ?? "")) {
            problems.push(`  ${feature} — docs note text does not match ${matrix}'s note text verbatim`);
        }
    }

    for (const feature of rows.keys()) {
        if (!(feature in features)) {
            problems.push(`  ${feature} — in the docs table, not a key in ${matrix}.features`);
        }
    }

    if (problems.length > 0) {
        failed = true;
        process.stderr.write(
            `packages/${directory}/docs/index.mdx and ${matrix} (packages/platform/src/capabilities.ts) disagree on ${String(problems.length)} row(s).\n` +
                `The matrix is the source of truth; update the docs table to match it (or, if the code changed on purpose, the notes above it):\n` +
                `${problems.join("\n")}\n`,
        );
    }
}

if (failed) {
    process.exit(1);
}
