import { readFileSync } from "node:fs";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * Every dispatch namespace binding in `dispatcher.wrangler.jsonc` must declare the
 * `outbound` parameters the dispatcher sends: `lineage` (plan 365 W5) and
 * `egress` (plan 477 §4.2). Workers for Platforms can drop an undeclared
 * parameter, so a missing one would fail open without an error. This test is the
 * guard the plan names; it reads the real file, in each environment, and fails
 * if the file has no outbound bindings at all.
 */

const REQUIRED_PARAMETERS = ["lineage", "egress"];

interface DispatchNamespaceBinding {
    outbound?: { parameters?: string[]; service?: string };
}

const config = parse(readFileSync(new URL("../dispatcher.wrangler.jsonc", import.meta.url), "utf8"), [], { allowTrailingComma: true }) as {
    dispatch_namespaces?: DispatchNamespaceBinding[];
    env?: Record<string, { dispatch_namespaces?: DispatchNamespaceBinding[] }>;
};

const bindingsByEnvironment = (): [string, DispatchNamespaceBinding[]][] => [
    ["top level", config.dispatch_namespaces ?? []],
    ...Object.entries(config.env ?? {}).map(([name, environment]): [string, DispatchNamespaceBinding[]] => [
        `env.${name}`,
        environment.dispatch_namespaces ?? [],
    ]),
];

describe("dispatcher.wrangler.jsonc outbound parameters", () => {
    it("declares a dispatch namespace in every environment, so none is checked vacuously", () => {
        const environments = bindingsByEnvironment().filter(([, bindings]) => bindings.length > 0);

        expect(environments.map(([name]) => name)).toStrictEqual(["top level", "env.staging", "env.production"]);
    });

    it.each(bindingsByEnvironment())("declares lineage and egress on every outbound entry in %s", (_name, bindings) => {
        const outbound = bindings.map((binding) => binding.outbound);

        expect(outbound.length).toBeGreaterThan(0);

        for (const entry of outbound) {
            expect(entry?.service).toStrictEqual(expect.any(String));
            expect(entry?.parameters ?? []).toStrictEqual(expect.arrayContaining(REQUIRED_PARAMETERS));
        }
    });
});
