import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DOCS_DIRECTORY = join(import.meta.dirname, "..", "docs");

/**
 * A webhook route must return `webhookResponse(...)`. Only the JSON payload crosses the `runAction`
 * hop, so a hand-built `Response.json(await ctx.runAction(...))` answers `200` for every outcome —
 * including the deliberate `500` on an orphaned (out-of-order) event, which is the one case the
 * provider must retry. All five provider guides shipped that wiring while the overview forbade it,
 * and nothing caught it: no gate reads the doc code blocks. This one does.
 */
describe("payment docs", () => {
    it("never wires a webhook route with Response.json(await ctx.runAction(...))", () => {
        expect.hasAssertions();

        const offenders = readdirSync(DOCS_DIRECTORY)
            .filter((name) => name.endsWith(".mdx"))
            .filter((name) => /Response\.json\(\s*await ctx\.runAction\(/.test(readFileSync(join(DOCS_DIRECTORY, name), "utf8")));

        expect(offenders).toStrictEqual([]);
    });
});
