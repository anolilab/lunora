import { describe, expect, it } from "vitest";

import type { JsCodeToolResult, WorkerLoaderLike } from "../src/js-code-tool";
import { jsCodeTool } from "../src/js-code-tool";
import type { AgentToolContext } from "../src/types";
import { passthroughStep } from "./loop-harness";

type LoadedCode = Parameters<WorkerLoaderLike["load"]>[0];

const NOPE_PATTERN = /nope/u;
const BIGINT_PATTERN = /BigInt/u;
const MISSING_BINDING_PATTERN = /no Worker Loader binding "LOADER"/u;
const CPU_MS_PATTERN = /`cpuMs` must be a positive integer/u;

/**
 * A Worker Loader double that really runs the generated module — imported from
 * a `data:` URL, so the wrapper's parsing, `console` capture and JSON result are
 * exercised, not assumed. It records what the tool handed the loader.
 */
const fakeLoader = (loaded: LoadedCode[] = []): WorkerLoaderLike => {
    return {
        load: (code) => {
            loaded.push(code);

            return {
                getEntrypoint: () => {
                    return {
                        fetch: async () => {
                            const source = code.modules[code.mainModule] ?? "";
                            const module = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as {
                                default: { fetch: () => Promise<Response> };
                            };

                            return module.default.fetch();
                        },
                    };
                },
            };
        },
    };
};

const contextWith = (env: Record<string, unknown>): AgentToolContext => ({ env, step: passthroughStep }) as unknown as AgentToolContext;

const run = async (code: string, env?: Record<string, unknown>): Promise<JsCodeToolResult> =>
    jsCodeTool().execute({ code }, contextWith(env ?? { LOADER: fakeLoader() }));

describe(jsCodeTool, () => {
    it("returns the script's value and its console output", async () => {
        expect.assertions(1);

        await expect(run('console.log("sum", 1 + 2, { ok: true });\nreturn [1, 2, 3].map((n) => n * 2);')).resolves.toStrictEqual({
            logs: ['sum 3 {"ok":true}'],
            value: [2, 4, 6],
        });
    });

    it("reports a throw, a syntax error and a non-JSON result as `error`, not a rejection", async () => {
        expect.assertions(4);

        const thrown = await run('throw new Error("nope");');
        const unparsed = await run("return (;");
        const bigint = await run("return 1n;");

        expect(thrown.error).toMatch(NOPE_PATTERN);
        expect(unparsed.error).toBeTypeOf("string");
        expect(bigint.error).toMatch(BIGINT_PATTERN);
        expect([thrown.value, unparsed.value, bigint.value]).toStrictEqual([undefined, undefined, undefined]);
    });

    it("loads the script with no network, no bindings and the CPU budget", async () => {
        expect.assertions(1);

        const loaded: LoadedCode[] = [];

        await jsCodeTool({ cpuMs: 250 }).execute({ code: "return 1;" }, contextWith({ LOADER: fakeLoader(loaded) }));

        expect(loaded[0]).toMatchObject({ env: {}, globalOutbound: null, limits: { cpuMs: 250, subRequests: 0 } });
    });

    it("names the missing binding instead of throwing", async () => {
        expect.assertions(2);

        const result = await run("return 1;", {});

        expect(result.error).toMatch(MISSING_BINDING_PATTERN);
        expect(result.logs).toStrictEqual([]);
    });

    it("rejects a non-positive CPU budget at construction", () => {
        expect.assertions(1);

        expect(() => jsCodeTool({ cpuMs: 0 })).toThrow(CPU_MS_PATTERN);
    });
});
