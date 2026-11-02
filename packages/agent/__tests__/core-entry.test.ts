import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asSchema, jsonSchema as sdkJsonSchema } from "@ai-sdk/provider-utils";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import jsonSchema from "../src/json-schema";

/** Modules that pull the model adapters, the AI SDK or the voice pipeline in with them. */
const HEAVY_MODULE = /src\/(?:agent-loop|generate|voice-do|voice-turn|mcp|code-tool)\.ts$/u;

const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every input reachable from `entry` through static imports — what a Worker evaluates at startup. */
const staticGraph = async (entry: string): Promise<string[]> => {
    const result = await build({
        bundle: true,
        entryPoints: [join(sourceDirectory, entry)],
        format: "esm",
        metafile: true,
        platform: "node",
        // Dynamic `import()` targets stay in the metafile with a `dynamic-import` edge; only
        // the static closure is evaluated eagerly, so that is what is walked below.
        splitting: true,
        outdir: "out",
        write: false,
        // Workspace siblings resolve to their built `dist`, which may be stale or absent here;
        // the guard is about this package's own edges and its third-party imports.
        external: ["@lunora/*", "cloudflare:*", "node:*"],
    });
    const { inputs } = result.metafile;
    const roots = Object.keys(inputs).filter((path) => path.endsWith(`src/${entry}`));
    const seen = new Set<string>();
    const stack = [...roots];

    while (stack.length > 0) {
        const path = stack.pop() as string;

        if (seen.has(path) || inputs[path] === undefined) {
            continue;
        }

        seen.add(path);

        for (const edge of inputs[path].imports) {
            if (edge.kind !== "dynamic-import") {
                stack.push(edge.path);
            }
        }
    }

    return [...seen];
};

describe("@lunora/agent/core", () => {
    it("reaches neither the agent loop nor the AI SDK through static imports", async () => {
        expect.assertions(4);

        const graph = await staticGraph("core.ts");

        expect(graph.some((path) => path.endsWith("src/define-agent.ts"))).toBe(true);
        expect(graph.filter((path) => path.includes("node_modules"))).toStrictEqual([]);
        expect(graph.filter((path) => HEAVY_MODULE.test(path))).toStrictEqual([]);
        // The workflow compiler is static; it reaches the loop only through a dynamic import.
        expect(graph.some((path) => path.endsWith("src/workflow.ts"))).toBe(true);
    });
});

describe(jsonSchema, () => {
    it("is the schema the AI SDK's asSchema accepts as-is, like the SDK's own jsonSchema", () => {
        expect.assertions(3);

        const definition = { properties: { id: { type: "string" as const } }, required: ["id"], type: "object" as const };
        const local = jsonSchema<{ id: string }>(definition);
        const sdk = sdkJsonSchema<{ id: string }>(definition);

        // `asSchema` passes a recognised schema through by identity; an unrecognised object
        // would be called as a lazy-schema thunk and throw.
        expect(asSchema(local)).toBe(local);
        expect(asSchema(local).jsonSchema).toStrictEqual(sdk.jsonSchema);
        expect(Object.getOwnPropertySymbols(local)).toStrictEqual(Object.getOwnPropertySymbols(sdk));
    });
});
