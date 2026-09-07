/**
 * The docs page carries a reference table per lint. It drifted: nineteen shipped
 * lints — including one that fires in the Studio's Advisors view — had no entry
 * at all, so the page understated the surface while reading as exhaustive.
 *
 * A table maintained by hand drifts again on the next lint, so this asserts it
 * instead: every registered lint must appear as a row naming it AND its level,
 * and every lint row in the page must name a lint that exists. Adding a lint
 * without a row (or changing a level without touching the page) fails here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_LINTS } from "../src";

const docsPage = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "index.mdx"), "utf8");

/**
 * Lint rows in the reference tables: a row whose first cell is a backticked
 * lint name and whose second is a backticked level. The level column is what
 * separates them from the page's other tables (verdicts, health-map states),
 * whose second cell is prose.
 */
const documented = new Map<string, string>(
    [...docsPage.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*`(ERROR|INFO|WARN)`\s*\|/gm)].map((match) => [match[1] as string, match[2] as string]),
);

describe("docs lint reference", () => {
    it("documents every registered lint with its level", () => {
        expect.assertions(1);

        const drifted = ALL_LINTS.filter((lint) => documented.get(lint.name) !== lint.level).map(
            (lint) => `${lint.name} (expected \`${lint.level}\`, documented ${documented.get(lint.name) ?? "nowhere"})`,
        );

        expect(drifted).toStrictEqual([]);
    });

    it("does not document a lint that no longer exists", () => {
        expect.assertions(1);

        const known = new Set(ALL_LINTS.map((lint) => lint.name));

        expect([...documented.keys()].filter((name) => !known.has(name))).toStrictEqual([]);
    });
});
