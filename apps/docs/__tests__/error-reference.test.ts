import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ERROR_CATALOG, isInternalCode } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { buildErrorReferencePage, MARKER_END, MARKER_START, renderErrorReference } from "../scripts/generate-error-reference";

const PAGE_PATH = fileURLToPath(new URL("../src/content/docs/errors.mdx", import.meta.url));

const page = readFileSync(PAGE_PATH, "utf8");

const codes = Object.keys(ERROR_CATALOG);
const publishedCodes = codes.filter((code) => !isInternalCode(code));
const internalCodes = codes.filter((code) => isInternalCode(code));

/** `code` as a standalone word anywhere on the page — a heading, a table cell, or prose. */
const namesCode = (source: string, code: string): boolean => new RegExp(String.raw`\b${code}\b`, "u").test(source);

describe("generated error reference", () => {
    it("gives every published code its own section", () => {
        expect.assertions(2);

        const missing = publishedCodes.filter((code) => !page.includes(`### \`${code}\``));

        expect(missing).toStrictEqual([]);
        // Guards the guard: an empty catalog would satisfy the line above.
        expect(publishedCodes.length).toBeGreaterThan(100);
    });

    it("never publishes an internal code", () => {
        expect.assertions(2);

        // Internal codes are redacted on the wire — their message never reaches a
        // client — so there is nothing for an app author to branch on, and listing
        // them as user-facing reference invites exactly that.
        expect(internalCodes.filter((code) => namesCode(page, code))).toStrictEqual([]);
        expect(internalCodes.length).toBeGreaterThan(0);
    });

    it("keeps the hand-written prose outside the generated block", () => {
        expect.assertions(3);

        const preamble = page.slice(0, page.indexOf(MARKER_START));

        expect(preamble).toContain('import { isLunoraError } from "@lunora/errors";');
        expect(preamble).toContain("## Throwing your own");
        expect(page.indexOf(MARKER_END)).toBeGreaterThan(page.indexOf(MARKER_START));
    });
});

describe("error-reference drift check", () => {
    it("passes against the committed page", async () => {
        expect.assertions(1);

        expect(await buildErrorReferencePage(page, ERROR_CATALOG, isInternalCode)).toBe(page);
    });

    it("fails once the catalog gains a code and the page is stale", async () => {
        expect.assertions(2);

        const withNewCode = { ...ERROR_CATALOG, ZZ_ADDED_BY_THIS_TEST: { status: 418, title: "Added by this test" } };
        const regenerated = await buildErrorReferencePage(page, withNewCode, isInternalCode);

        // This inequality IS the gate: `--check` compares exactly these two.
        expect(regenerated).not.toBe(page);
        expect(regenerated).toContain("### `ZZ_ADDED_BY_THIS_TEST`");
    });

    it("fails once a published code's status or title changes", async () => {
        expect.assertions(1);

        const retitled = { ...ERROR_CATALOG, CONFLICT: { ...ERROR_CATALOG.CONFLICT, title: "Something else entirely" } };

        expect(await buildErrorReferencePage(page, retitled, isInternalCode)).not.toBe(page);
    });

    it("omits a newly internal code from the render", () => {
        expect.assertions(2);

        const rendered = renderErrorReference(ERROR_CATALOG, (code: string) => isInternalCode(code) || code === "CONFLICT");

        expect(rendered).not.toContain("### `CONFLICT`");
        expect(rendered).toContain("### `NOT_UNIQUE`");
    });

    it("refuses a page whose generated-block markers are gone", async () => {
        expect.assertions(1);

        await expect(buildErrorReferencePage("# no markers here\n", ERROR_CATALOG, isInternalCode)).rejects.toThrow("missing the generated-block markers");
    });
});
