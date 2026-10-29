import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/worker/index.ts");
const STATIC_SPECIFIER = /(?:from|import)\s*["']([^"']+)["']/g;

/** Every bare/`node:` specifier reachable from `file` through static relative imports. */
const externalSpecifiers = (file: string, seen = new Set<string>()): Set<string> => {
    const found = new Set<string>();

    if (seen.has(file)) {
        return found;
    }

    seen.add(file);

    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(STATIC_SPECIFIER)) {
        const specifier = match[1] as string;

        if (specifier.startsWith(".")) {
            const base = resolve(dirname(file), specifier);
            const target = [`${base}.ts`, resolve(base, "index.ts")].find((candidate) => existsSync(candidate));

            if (target !== undefined) {
                for (const nested of externalSpecifiers(target, seen)) {
                    found.add(nested);
                }
            }
        } else {
            found.add(specifier);
        }
    }

    return found;
};

describe("@lunora/mcp/worker exports", () => {
    it("exposes the per-function server, and not the stdio helper", async () => {
        expect.assertions(2);

        const worker = await import("../src/worker/index");

        expect(worker.createFunctionMcpServer).toBeTypeOf("function");
        expect(worker).not.toHaveProperty("connectFunctionStdio");
    });
});

describe("@lunora/mcp/worker module graph", () => {
    it("statically imports no node:* module and no stdio transport", () => {
        expect.assertions(2);

        const specifiers = [...externalSpecifiers(entry)];

        expect(specifiers.filter((specifier) => specifier.startsWith("node:"))).toStrictEqual([]);
        expect(specifiers.filter((specifier) => specifier.includes("stdio"))).toStrictEqual([]);
    });
});
