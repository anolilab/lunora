import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** `SELECT 1 WHERE 1 IN (?, …)` with `n` bound parameters, all distinct, so the row survives only if the list binds. */
const bindList = (n: number): { params: number[]; text: string } => {
    return {
        params: Array.from({ length: n }, (_, index) => index),
        text: `SELECT 1 AS one WHERE 1 IN (${Array.from<string>({ length: n }).fill("?").join(", ")})`,
    };
};

/** Run the statement on the real D1 binding; return the rows, or the error text the binding raised. */
const runBound = async (n: number): Promise<{ error?: string; rows?: unknown[] }> => {
    const { params, text } = bindList(n);

    try {
        const result = await env.DB.prepare(text)
            .bind(...params)
            .all();

        return { rows: result.results };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

describe("d1 bound-parameter limit (workerd)", () => {
    it("runs a statement with 100 bound parameters", async () => {
        expect.assertions(1);

        await expect(runBound(100)).resolves.toStrictEqual({ rows: [{ one: 1 }] });
    });

    it("refuses a statement with 101 bound parameters with the engine's too-many-variables error", async () => {
        expect.assertions(2);

        // Observed on the real binding: `D1_ERROR: too many SQL variables at offset 328: SQLITE_ERROR`. The offset is
        // position-dependent, so the assertion pins the stable prefix and the absence of any rows.
        const outcome = await runBound(101);

        expect(outcome.rows).toBeUndefined();
        expect(outcome.error).toMatch(/^D1_ERROR: too many SQL variables at offset \d+: SQLITE_ERROR$/u);
    });
});
