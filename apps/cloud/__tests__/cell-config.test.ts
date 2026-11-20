import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ParseError } from "jsonc-parser";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { tailConsumerOf } from "../src/targets/cloudflare-wfp/driver";

/**
 * The control plane (`wrangler.jsonc`) names Workers and datasets that the
 * dispatcher and the tail Worker own in their own configs, per environment.
 * Nothing at deploy time checks the two agree, and a mismatch fails quietly:
 * tenants ship logs to a script that does not exist, or a cell reads another
 * cell's usage.
 */

interface WranglerBlock {
    analytics_engine_datasets?: { binding: string; dataset: string }[];
    name?: string;
    vars?: Record<string, string>;
}

type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

const readConfig = (file: string): WranglerConfig => {
    const errors: ParseError[] = [];
    const config = parse(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"), errors, { allowTrailingComma: true }) as WranglerConfig;

    expect(errors).toStrictEqual([]);

    return config;
};

const controlPlane = readConfig("wrangler.jsonc");
const dispatcher = readConfig("dispatcher.wrangler.jsonc");
const tail = readConfig("tail.wrangler.jsonc");

/** The script name wrangler deploys a block as: its own `name`, else the top-level name suffixed with the env. */
const scriptName = (config: WranglerConfig, environment: string | undefined): string | undefined =>
    environment === undefined ? config.name : (config.env?.[environment]?.name ?? `${config.name ?? ""}-${environment}`);

const deployedEnvironments = Object.keys(controlPlane.env ?? {});

describe("control plane and its sibling Workers' wrangler configs", () => {
    it("deploys the environments these checks are written against", () => {
        expect(deployedEnvironments).toStrictEqual(["staging", "production"]);
    });

    it.each(deployedEnvironments)("names the %s tail Worker as tenants' log consumer", (environment) => {
        const vars = controlPlane.env?.[environment]?.vars ?? {};

        expect(tailConsumerOf(vars)).toBe(scriptName(tail, environment));
    });

    it("names the top-level tail Worker for a bare deploy", () => {
        expect(tailConsumerOf(controlPlane.vars ?? {})).toBe(scriptName(tail, undefined));
    });

    it.each(deployedEnvironments)("reads %s usage from the dataset that environment's dispatcher writes", (environment) => {
        const written = dispatcher.env?.[environment]?.analytics_engine_datasets?.find((dataset) => dataset.binding === "USAGE_ANALYTICS")?.dataset;
        // The driver's default when the var is unset (`cloudflareWfpFleetFromEnv`).
        const read = controlPlane.env?.[environment]?.vars?.["USAGE_ANALYTICS_DATASET"] ?? "lunora_tenant_usage";

        expect(written).toBeDefined();
        expect(read).toBe(written);
    });
});
