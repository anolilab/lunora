import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** A top-level `import` / `export` statement; `import()` is lazy and never matches. */
const STATEMENT = /^(?:import|export)\b(?<clause>[^;]*);/gmu;

/** The module a statement's clause loads: `… from "x"` or a bare `"x"`. */
const SPECIFIER = /(?:^|\sfrom)\s*"(?<specifier>[^"]+)"$/u;

const resolveRelative = (from: string, specifier: string): string => {
    const base = resolve(dirname(from), specifier);
    const candidate = [`${base}.ts`, join(base, "index.ts")].find((path) => existsSync(path));

    if (candidate === undefined) {
        throw new Error(`cannot resolve ${specifier} from ${from}`);
    }

    return candidate;
};

/** Every bare (package) specifier evaluated when `entry` is imported. */
const packagesLoadedBy = (entry: string): Set<string> => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = [entry];

    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (seen.has(file)) {
            continue;
        }

        seen.add(file);

        for (const statement of readFileSync(file, "utf8").matchAll(STATEMENT)) {
            const clause = (statement.groups?.["clause"] ?? "").trim();
            // Type-only imports and re-exports are erased at build time.
            const specifier = clause.startsWith("type ") ? undefined : SPECIFIER.exec(clause)?.groups?.["specifier"];

            if (specifier === undefined) {
                continue;
            }

            if (specifier.startsWith(".")) {
                queue.push(resolveRelative(file, specifier));
            } else {
                packages.add(specifier);
            }
        }
    }

    return packages;
};

describe("@lunora/config/cli import graph", () => {
    // The CLI evaluates this entry on every invocation, `--help` included. A
    // constant once pulled `reconcile-bindings` (and with it codegen and
    // ts-morph) in through the driver registry, which doubled CLI start time.
    it("loads neither @lunora/codegen nor ts-morph", () => {
        expect.assertions(1);

        const loaded = [...packagesLoadedBy(join(sourceRoot, "cli/index.ts"))];

        expect(loaded.filter((specifier) => /^(?:@lunora\/codegen|ts-morph)(?:\/|$)/u.test(specifier))).toStrictEqual([]);
    });
});
