import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";

import { emitShard } from "../src/index";

interface Deferred {
    key: string;
    resolve: (value: unknown) => void;
}

/**
 * Lift the emitted `evaluateFlags` override out of the generated ShardDO and run
 * it against a fake flags client, so the test observes what the generated code
 * does rather than what its text looks like.
 */
const loadEvaluateFlags = (
    output: string,
    createFlags: () => unknown,
): ((context?: Record<string, unknown>) => Promise<{ flags: { key: string; value: unknown }[] }>) => {
    const start = output.indexOf("protected override async evaluateFlags(");
    const end = output.indexOf("\n        }\n", start);
    const method = output.slice(start, end + "\n        }".length).replace("protected override ", "");
    const keysStart = output.indexOf("const LUNORA_FLAG_KEYS = ");
    const keys = output.slice(keysStart, output.indexOf(";\n", keysStart) + 1);
    const source = `${keys}\nclass Host { env = {}; ${method} }\nreturn new Host();`;
    const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- executes the emitted method body under test; the source is this test's own codegen output
    const host = new Function("createFlags", "flagsConfig", "config", js)(createFlags, {}, {}) as {
        evaluateFlags: (context?: Record<string, unknown>) => Promise<{ flags: { key: string; value: unknown }[] }>;
    };

    return host.evaluateFlags.bind(host);
};

describe("emitShard — evaluateFlags", () => {
    it("evaluates every discovered flag concurrently and keeps their order", async () => {
        expect.assertions(2);

        const output = emitShard({
            flagKeys: [
                { key: "dark-mode", type: "boolean" },
                { key: "page-size", type: "number" },
                { key: "theme", type: "string" },
            ],
            hasFlags: true,
            schema: { tables: [], vectorIndexes: [] },
        });

        const inFlight: Deferred[] = [];
        const read = async (key: string): Promise<unknown> =>
            new Promise((resolve) => {
                inFlight.push({ key, resolve });
            });
        const details = { boolean: read, number: read, object: read, string: read };
        const evaluateFlags = loadEvaluateFlags(output, () => {
            return { details };
        });

        const pending = evaluateFlags();

        // Every provider read must be issued before any of them settles: a remote
        // provider would otherwise cost one serial round trip per flag.
        expect(inFlight.map(({ key }) => key)).toStrictEqual(["dark-mode", "page-size", "theme"]);

        // Settle out of order; the result still follows LUNORA_FLAG_KEYS.
        for (const { key, resolve } of inFlight.toReversed()) {
            resolve({ reason: "STATIC", value: key });
        }

        const result = await pending;

        expect(result.flags.map(({ key, value }) => [key, value])).toStrictEqual([
            ["dark-mode", "dark-mode"],
            ["page-size", "page-size"],
            ["theme", "theme"],
        ]);
    });
});
