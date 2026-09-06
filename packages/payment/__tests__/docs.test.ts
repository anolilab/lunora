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

    /**
     * The guarded money operations must be shown on the facade, not on `ctx.payments.adapter`. The
     * adapter is the raw provider call: it skips the caller authorization, the over-refund check, the
     * local refund ledger (the only thing stopping a double Polar refund — see `idempotency.ts`), the
     * derived idempotency key, and the store write. Three provider guides documented the adapter as
     * the supported refund path, one of them asserting the facade had no refund method at all.
     */
    it("never documents a money operation on ctx.payments.adapter", () => {
        expect.hasAssertions();

        const offenders = readdirSync(DOCS_DIRECTORY)
            .filter((name) => name.endsWith(".mdx"))
            // A call, not a mention: the guides are free to name the adapter method in prose that
            // steers readers away from it.
            .filter((name) => /ctx\.payments\.adapter\.(?:cancel|capture|refund)Payment\(/.test(readFileSync(join(DOCS_DIRECTORY, name), "utf8")));

        expect(offenders).toStrictEqual([]);
    });

    /**
     * The overview's `ctx.payments` table is the canonical list of what the facade offers, and it is
     * headed by the promise that every method authorizes the caller. A method missing from it reads
     * as a method that does not exist — which is how `refundPayment`, `capturePayment` and
     * `cancelPayment` came to be documented as adapter-only.
     */
    it("lists every facade method in the overview's ctx.payments table", () => {
        expect.hasAssertions();

        const source = readFileSync(join(import.meta.dirname, "..", "src", "create-payment.ts"), "utf8");
        const body = /interface LunoraPayment \{(?<members>[\s\S]*?)\n\}/u.exec(source)?.groups?.members ?? "";
        // Method members only: `name: (args) => …`. The two readonly properties (`adapter`, `store`)
        // are not calls and are documented in their own sections.
        const methods = [...body.matchAll(/^ {4}(?<name>\w+): \(/gmu)].flatMap((match) => match.groups?.name ?? []);

        expect(methods.length).toBeGreaterThan(0);

        const rows = readFileSync(join(DOCS_DIRECTORY, "index.mdx"), "utf8")
            .split("\n")
            .filter((line) => line.startsWith("| `"))
            .join("\n");

        expect(methods.filter((name) => !rows.includes(`\`${name}(`))).toStrictEqual([]);
    });
});
