#!/usr/bin/env node
/**
 * Generates the per-code reference in `src/content/docs/errors.mdx` from
 * `ERROR_CATALOG` (`packages/errors/src/catalog.ts`).
 *
 * The catalog is the single source of truth every error surface already reads —
 * the runtime/DO wire mappers, the CLI renderer, the Vite overlay, Studio and
 * the client SDK. The docs page was the one consumer that re-typed it by hand,
 * and it had drifted to 36 of the catalog's 154 codes: the other 118 existed in
 * the product but on no page, so `llms.txt`, `llms-full.txt` and the docs MCP
 * server at `/mcp` — the three ways an AI agent retrieves an explanation — had
 * nothing to return for them.
 *
 * Only the block between the two markers is written. The prose above it (what a
 * `code` is, the `isLunoraError` example, the build-time solutions table) is
 * hand-authored and survives every run.
 *
 * Internal codes are deliberately absent. Their `message` never crosses the
 * wire — the transport redacts it — so an app author never branches on one, and
 * publishing them as user-facing reference invites exactly that.
 *
 * Usage:
 *   node --experimental-strip-types apps/docs/scripts/generate-error-reference.js
 *   node --experimental-strip-types apps/docs/scripts/generate-error-reference.js --check
 *
 * The flag is required because this imports `catalog.ts` directly via Node's
 * built-in type stripping — unflagged only from Node 22.18, and CI's lint jobs
 * pin 22.15. Importing the built `@lunora/errors` instead would put a build step
 * in front of `pnpm dev`; the catalog is a plain annotated object literal, so
 * stripping reads it with no toolchain at all.
 *
 * Run by `apps/docs`'s `build` and `dev` scripts alongside the sibling
 * generators, and by `scripts/check-generated-files.mjs` (`pnpm run
 * lint:generated`), which re-runs every generator in CI and fails on a committed
 * output that does not match.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import prettier from "prettier";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const CATALOG_PATH = path.join(ROOT_DIR, "packages", "errors", "src", "catalog.ts");
const PAGE_PATH = path.join(__dirname, "..", "src", "content", "docs", "errors.mdx");

/**
 * Fences for the generated block. They are MDX expression comments rather than
 * HTML ones: an HTML comment is a parse error in MDX, and this page compiles as
 * MDX.
 */
const MARKER_START = "{/* generated:error-codes — written from packages/errors/src/catalog.ts. Do not edit by hand. */}";
const MARKER_END = "{/* /generated:error-codes */}";

/** The anchor Fumadocs derives from a `### \`CODE\`` heading (github-slugger: backticks dropped, lowercased, `_` kept). */
const anchorFor = (code) => code.toLowerCase();

/**
 * An `ErrorHint` is a Markdown string or an array of lines; both flatten to lines.
 * @param hint
 */
const hintLines = (hint) => (typeof hint === "string" ? hint.split("\n") : [...hint]);

/**
 * Render the generated Markdown for `catalog` — every code `isInternal` does not
 * claim, alphabetically, one `###` section each.
 *
 * A section per code rather than one big table, because the readers that matter
 * here chunk by heading: `llms-full.txt` and the docs MCP's `get_doc` return the
 * section, and `lunora_explain_error` links to its anchor. A table row is a row
 * of a 141-row table wherever it lands.
 *
 * Pure, and takes the catalog rather than reading it, so a test can render a
 * catalog carrying one extra code and assert the drift check would fail.
 * @param catalog
 * @param isInternal
 */
const renderErrorReference = (catalog, isInternal) => {
    const codes = Object.keys(catalog)
        .filter((code) => !isInternal(code))
        .sort((a, b) => a.localeCompare(b));

    const lines = [
        "## Error codes",
        "",
        `All ${codes.length} codes Lunora publishes, generated from the catalog the runtime, CLI, overlay, Studio and client SDK all read.`,
        `Every heading is an anchor, so \`/docs/errors#${anchorFor("CONFLICT")}\` links straight to one.`,
        "",
    ];

    for (const code of codes) {
        const entry = catalog[code];

        lines.push(`### \`${code}\``, "", `\`${entry.status}\` — ${entry.title}`, "");

        if (entry.hint !== undefined) {
            lines.push(...hintLines(entry.hint), "");
        }

        if (entry.docsUrl !== undefined) {
            lines.push(`[Read more](${entry.docsUrl})`, "");
        }
    }

    return lines.join("\n").trimEnd();
};

/**
 * Replace the marked block in `source` with the reference rendered from
 * `catalog`, then format the whole page through the repo's Prettier config —
 * without which `pnpm run lint:prettier` and this generator disagree and every
 * regeneration re-dirties the file.
 * @param source
 * @param catalog
 * @param isInternal
 */
const buildErrorReferencePage = async (source, catalog, isInternal) => {
    const start = source.indexOf(MARKER_START);
    const end = source.indexOf(MARKER_END);

    if (start === -1 || end === -1 || end < start) {
        throw new Error(`errors.mdx is missing the generated-block markers:\n  ${MARKER_START}\n  ...\n  ${MARKER_END}`);
    }

    const next = [source.slice(0, start + MARKER_START.length), "", renderErrorReference(catalog, isInternal), "", source.slice(end)].join("\n");
    const options = await prettier.resolveConfig(PAGE_PATH);

    return prettier.format(next, { ...options, filepath: PAGE_PATH });
};

const main = async () => {
    const check = process.argv.includes("--check");

    const { ERROR_CATALOG, isInternalCode } = await import(pathToFileURL(CATALOG_PATH).href);

    const published = Object.keys(ERROR_CATALOG).filter((code) => !isInternalCode(code)).length;
    const source = await fs.readFile(PAGE_PATH, "utf8");
    const next = await buildErrorReferencePage(source, ERROR_CATALOG, isInternalCode);

    if (source === next) {
        console.log(`errors.mdx is up to date (${published} published codes).`);

        return;
    }

    if (check) {
        process.stderr.write(
            `${path.relative(ROOT_DIR, PAGE_PATH)} is stale — the error catalog changed but the reference did not.\n` +
                `Regenerate it and commit the result:\n\n  node --experimental-strip-types apps/docs/scripts/generate-error-reference.js\n`,
        );
        process.exit(1);
    }

    await fs.writeFile(PAGE_PATH, next);
    console.log(`Generated errors.mdx from the error catalog (${published} published codes).`);
};

// The CLI half runs only when this file IS the entry point, so the drift test can
// import the pure halves. `import.meta.main` is Node 24+; CI's lint jobs pin 22.15.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main();
}

export { anchorFor, buildErrorReferencePage, MARKER_END, MARKER_START, renderErrorReference };
