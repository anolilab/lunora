#!/usr/bin/env node
/**
 * Guards against `packages/platform-node/docs/index.mdx`'s capability table
 * and `NODE_CAPABILITIES` (`packages/platform/src/capabilities.ts`) drifting
 * apart.
 *
 * The docs page states plainly (plan 329) that it reproduces the matrix
 * codegen actually gates `ctx.*` surfaces on, not a second hand-maintained
 * copy of it — the exact kind of drift `scripts/check-roadmap-tiers.js`
 * exists to catch for the tier taxonomy. This is the same guard for the
 * feature-by-feature ratings.
 *
 * Imports `capabilities.ts` directly via Node's built-in TypeScript type
 * stripping (no build step: the file is a plain `const` object with type
 * annotations, nothing an unflagged strip can't handle) rather than
 * regex-parsing the source text, because several notes contain quotes,
 * apostrophes and mixed quoting styles that a text-only parser would have to
 * special-case.
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
const docsPath = join(rootDir, "packages", "platform-node", "docs", "index.mdx");

const { NODE_CAPABILITIES } = await import(pathToFileURL(capabilitiesPath).href);

const docsSource = readFileSync(docsPath, "utf8");

/** One row per feature, keyed by feature name, parsed from the markdown table. */
const tableRowPattern = /^\|\s*`([a-zA-Z0-9]+)`\s*\|\s*`(native|emulated|unsupported)`\s*\|\s*(.+?)\s*\|\s*$/gmu;

const rows = new Map();

for (const match of docsSource.matchAll(tableRowPattern)) {
    const [, feature, level, note] = match;

    // The only escape the page needs: a leading `\_` on an identifier that
    // would otherwise open CommonMark emphasis at the start of a table cell.
    rows.set(feature, { level, note: note.replaceAll(String.raw`\_`, "_") });
}

const problems = [];

for (const [feature, capability] of Object.entries(NODE_CAPABILITIES.features)) {
    const row = rows.get(feature);

    if (!row) {
        problems.push(`  ${feature} — in NODE_CAPABILITIES, missing from the docs table`);
        continue;
    }

    if (row.level !== capability.level) {
        problems.push(`  ${feature} — docs says \`${row.level}\`, NODE_CAPABILITIES says \`${capability.level}\``);
    }

    const sourceNote = capability.note ?? "";

    if (row.note !== sourceNote) {
        problems.push(`  ${feature} — docs note text does not match NODE_CAPABILITIES's note text verbatim`);
    }
}

for (const feature of rows.keys()) {
    if (!(feature in NODE_CAPABILITIES.features)) {
        problems.push(`  ${feature} — in the docs table, not a key in NODE_CAPABILITIES.features`);
    }
}

if (problems.length > 0) {
    process.stderr.write(
        `packages/platform-node/docs/index.mdx and NODE_CAPABILITIES (packages/platform/src/capabilities.ts) disagree on ${String(problems.length)} row(s).\n` +
            `The matrix is the source of truth; update the docs table to match it (or, if the code changed on purpose, the notes above it):\n` +
            `${problems.join("\n")}\n`,
    );
    process.exit(1);
}
