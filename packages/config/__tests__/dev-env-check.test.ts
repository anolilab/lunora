import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDevEnv, describeDevEnvCheck } from "../src/dev-env-check";

/** A stand-in for a `defineEnv` accessor: each listed key must be a non-empty string. */
const requireKeys = (...keys: string[]) => {
    const parse = (env: unknown): unknown => {
        const record = env as Record<string, unknown>;
        const failures = keys
            .filter((key) => typeof record[key] !== "string" || record[key] === "")
            .map((key) => {
                return { key, message: `Expected string at <root>, received ${typeof record[key]}` };
            });

        if (failures.length > 0) {
            throw Object.assign(new Error("Invalid environment"), { failures });
        }

        return record;
    };

    return Object.assign((env: unknown) => env, { parse });
};

describe(checkDevEnv, () => {
    let projectRoot: string;

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-dev-env-check-"));
        mkdirSync(join(projectRoot, "lunora"));
        writeFileSync(join(projectRoot, "lunora", "env.ts"), "// loaded through the injected loader\n");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    const check = async (accessor: unknown) =>
        checkDevEnv({
            load: async () => {
                return { env: accessor };
            },
            projectRoot,
            schemaDirectory: "lunora",
        });

    it("reports nothing for a project without lunora/env.ts", async () => {
        expect.assertions(1);

        rmSync(join(projectRoot, "lunora", "env.ts"));

        await expect(checkDevEnv({ projectRoot, schemaDirectory: "lunora" })).resolves.toStrictEqual({ kind: "absent" });
    });

    it("names each key the dev env is missing, and where it looked", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".dev.vars"), "API_URL=https://api.test\n");

        await expect(check(requireKeys("API_URL", "STRIPE_KEY"))).resolves.toStrictEqual({
            failures: [{ key: "STRIPE_KEY", message: "Expected string at <root>, received undefined" }],
            kind: "invalid",
            sources: [".dev.vars"],
        });
    });

    it("reads wrangler vars under .dev.vars, and .env only when there is no .dev.vars", async () => {
        expect.assertions(2);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "vars": { "API_URL": "https://api.test" } }`);
        writeFileSync(join(projectRoot, ".env"), "STRIPE_KEY=sk_test\n");

        await expect(check(requireKeys("API_URL", "STRIPE_KEY"))).resolves.toStrictEqual({ kind: "valid" });

        // `.dev.vars` present: the worker never sees `.env`.
        writeFileSync(join(projectRoot, ".dev.vars"), "OTHER=1\n");

        await expect(check(requireKeys("API_URL", "STRIPE_KEY"))).resolves.toMatchObject({
            failures: [{ key: "STRIPE_KEY" }],
            kind: "invalid",
            sources: ["wrangler vars", ".dev.vars"],
        });
    });

    it("does not merge the shell environment the worker never sees", async () => {
        expect.assertions(1);

        process.env["LUNORA_DEV_ENV_CHECK_PROBE"] = "from-shell";

        try {
            await expect(check(requireKeys("LUNORA_DEV_ENV_CHECK_PROBE"))).resolves.toMatchObject({ kind: "invalid" });
        } finally {
            delete process.env["LUNORA_DEV_ENV_CHECK_PROBE"];
        }
    });

    it("does not count a key the worker gets as a binding", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "kv_namespaces": [{ "binding": "CACHE" }] }`);

        await expect(check(requireKeys("CACHE"))).resolves.toStrictEqual({ kind: "valid" });
    });

    it("answers unloadable, never throws, when the contract cannot be imported on the host", async () => {
        expect.assertions(1);

        await expect(
            checkDevEnv({
                load: async () => {
                    throw new Error('Cannot find module "cloudflare:workers"');
                },
                projectRoot,
                schemaDirectory: "lunora",
            }),
        ).resolves.toStrictEqual({ error: 'Cannot find module "cloudflare:workers"', kind: "unloadable" });
    });

    it("loads a real lunora/env.ts by default", async () => {
        expect.assertions(1);

        writeFileSync(
            join(projectRoot, "lunora", "env.ts"),
            `const parse = (env: Record<string, unknown>): unknown => {
    if (env["API_URL"] === undefined) {
        throw Object.assign(new Error("Invalid environment"), { failures: [{ key: "API_URL", message: "missing" }] });
    }

    return env;
};

export const env = Object.assign((value: unknown) => value, { parse });
`,
        );

        await expect(checkDevEnv({ projectRoot, schemaDirectory: "lunora" })).resolves.toMatchObject({ failures: [{ key: "API_URL" }], kind: "invalid" });
    });
});

describe(describeDevEnvCheck, () => {
    it("warns with one line per failing key", () => {
        expect.assertions(1);

        expect(
            describeDevEnvCheck(
                { failures: [{ key: "STRIPE_KEY", message: "Expected string" }], kind: "invalid", sources: ["wrangler vars", ".dev.vars"] },
                "lunora",
            ),
        ).toStrictEqual({
            level: "warn",
            message:
                "lunora/env.ts: 1 key(s) missing or invalid in the dev env (wrangler vars + .dev.vars) — the first request that reads one will fail:\n  - STRIPE_KEY: Expected string",
        });
    });

    it("says nothing for a valid or absent contract", () => {
        expect.assertions(2);

        expect(describeDevEnvCheck({ kind: "valid" }, "lunora")).toBeUndefined();
        expect(describeDevEnvCheck({ kind: "absent" }, "lunora")).toBeUndefined();
    });
});
