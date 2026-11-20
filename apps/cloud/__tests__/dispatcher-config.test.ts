import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ParseError } from "jsonc-parser";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * Config conformance for `dispatcher.wrangler.jsonc` (plan 475 §5 B). A
 * misconfigured deployed dispatcher is a money and access bypass, so the rules
 * are checked here, in CI, before any deploy reads the file:
 *
 * - every named environment declares its own `LUNORA_ENVIRONMENT` (matching the
 *   block name), `CONTROL_PLANE_URL` and `LUNORA_APP_DOMAIN`;
 * - `development` is never set in a named environment, so it cannot reach a deploy;
 * - no value is the `example.workers.dev` placeholder, and no unsubstituted
 *   `replace-…` template is left in (`scripts/check-deploy-config.ts` refuses
 *   those at deploy);
 * - the lineage secret is a secret, never a plain `vars` entry.
 *
 * The secrets (`CONTROL_PLANE_TOKEN`) cannot be checked statically; the runtime
 * gate in `src/dispatcher/worker.ts` is their check.
 */

interface DispatcherConfig {
    dispatch_namespaces?: { namespace: string }[];
    env?: Record<string, { vars?: Record<string, string> }>;
    routes?: unknown[];
    vars?: Record<string, string>;
}

const CONFIG_PATH = fileURLToPath(new URL("../dispatcher.wrangler.jsonc", import.meta.url));

const readConfig = (): DispatcherConfig => {
    const errors: ParseError[] = [];
    const config = parse(readFileSync(CONFIG_PATH, "utf8"), errors, { allowTrailingComma: true }) as DispatcherConfig;

    // A partial parse would pass every rule below without checking anything.
    expect(errors).toStrictEqual([]);

    return config;
};

const config = readConfig();

/** Every named environment block, by name. */
const environments = Object.entries(config.env ?? {});

/** Every `vars` value in the file, top level and every environment, labelled for the failure message. */
const everyVar = (): [string, string][] => {
    const top = Object.entries(config.vars ?? {}).map(([name, value]): [string, string] => [`top-level ${name}`, value]);
    const named = environments.flatMap(([envName, block]) =>
        Object.entries(block.vars ?? {}).map(([name, value]): [string, string] => [`${envName} ${name}`, value]),
    );

    return [...top, ...named];
};

describe("dispatcher.wrangler.jsonc conformance", () => {
    it("declares the deployed environments this rule set is written against", () => {
        expect(environments.map(([name]) => name)).toStrictEqual(["staging", "production"]);
    });

    it.each(environments)("%s declares its own environment, control plane URL and app domain", (envName, block) => {
        expect(block.vars?.["LUNORA_ENVIRONMENT"]).toBe(envName);
        expect(block.vars?.["CONTROL_PLANE_URL"]).toBeTypeOf("string");
        expect(block.vars?.["LUNORA_APP_DOMAIN"]).toBeTypeOf("string");
    });

    it("never sets development in a named environment", () => {
        for (const [envName, block] of environments) {
            expect(block.vars?.["LUNORA_ENVIRONMENT"], envName).not.toBe("development");
        }
    });

    it("is development at the top level, the only place a local dev run reads from", () => {
        expect(config.vars?.["LUNORA_ENVIRONMENT"]).toBe("development");
    });

    it("keeps the top level unable to deploy: an unbound sentinel namespace and no routes", () => {
        expect(JSON.stringify(config.dispatch_namespaces)).toContain("lunora-local-dev-unbound");
        expect(config.routes).toBeUndefined();
    });

    it("rejects the example.workers.dev placeholder in every environment", () => {
        const offenders = everyVar()
            .filter(([, value]) => value.includes("example.workers.dev"))
            .map(([label]) => label);

        expect(offenders).toStrictEqual([]);
    });

    it("keeps the lineage secret out of vars", () => {
        expect(everyVar().filter(([label]) => label.endsWith("LUNORA_LINEAGE_SECRET"))).toStrictEqual([]);
    });
});
