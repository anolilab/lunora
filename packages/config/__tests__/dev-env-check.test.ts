import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV_CONTRACT } from "../../../shared/env-contract";
import type { DevEnvCheckOptions } from "../src/dev-env-check";
import { checkDevEnv, describeDevEnvCheck } from "../src/dev-env-check";

/** A branded stand-in for a `defineEnv` accessor whose contract answers `check`. */
const accessorWith = (check: (env: Record<string, unknown>) => unknown) => Object.defineProperty((env: unknown) => env, ENV_CONTRACT, { value: check });

/** A stand-in for a `defineEnv` accessor: each listed key must be a non-empty string. */
const requireKeys = (...keys: string[]) =>
    accessorWith((env) =>
        keys
            .filter((key) => typeof env[key] !== "string" || env[key] === "")
            .map((key) => {
                return { key, message: `Expected string at <root>, received ${typeof env[key]}` };
            }),
    );

/** A contract that records the env it was checked against and passes it. */
const capture = (): { accessor: unknown; seen: () => Record<string, unknown> | undefined } => {
    let seen: Record<string, unknown> | undefined;

    return {
        accessor: accessorWith((env) => {
            seen = env;

            return [];
        }),
        seen: () => seen,
    };
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

    const check = async (accessor: unknown, options: Partial<DevEnvCheckOptions> = {}) =>
        checkDevEnv({
            load: async () => {
                return { env: accessor };
            },
            processEnv: {},
            projectRoot,
            schemaDirectory: "lunora",
            ...options,
        });

    /** The env the worker would see, as the contract receives it. */
    const envSeen = async (options: Partial<DevEnvCheckOptions> = {}): Promise<Record<string, unknown> | undefined> => {
        const { accessor, seen } = capture();

        await check(accessor, options);

        return seen();
    };

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

        await expect(check(requireKeys("PROBE"), { processEnv: { PROBE: "from-shell" } })).resolves.toMatchObject({ kind: "invalid" });
    });

    it("skips .env when CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV is false, as wrangler does", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".env"), "STRIPE_KEY=sk_test\n");

        await expect(envSeen({ processEnv: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } })).resolves.toStrictEqual({});
    });

    it("merges the shell environment under .env when CLOUDFLARE_INCLUDE_PROCESS_ENV is true, and expands references", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".env"), "API_URL=https://$HOST/v1\n");
        writeFileSync(join(projectRoot, ".env.local"), "REGION=eu\n");

        await expect(envSeen({ processEnv: { CLOUDFLARE_INCLUDE_PROCESS_ENV: "true", HOST: "api.test" } })).resolves.toMatchObject({
            API_URL: "https://api.test/v1",
            HOST: "api.test",
            REGION: "eu",
        });
    });

    it("keeps only vars and secrets.required from the loaded values when wrangler declares secrets", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "vars": { "MODE": "dev" }, "secrets": { "required": ["STRIPE_KEY"] } }`);
        writeFileSync(join(projectRoot, ".env"), ["STRIPE_KEY=sk_test", "MODE=local", "STRAY=1", ""].join("\n"));

        await expect(envSeen({ processEnv: { SHELL_ONLY: "1" } })).resolves.toStrictEqual({ MODE: "local", STRIPE_KEY: "sk_test" });
    });

    it("takes a required secret from the shell environment when wrangler declares secrets and there is no .dev.vars", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "secrets": { "required": ["STRIPE_KEY"] } }`);

        await expect(envSeen({ processEnv: { STRIPE_KEY: "sk_test", UNRELATED: "1" } })).resolves.toStrictEqual({ STRIPE_KEY: "sk_test" });
    });

    it("reads the CLOUDFLARE_ENV environment's own vars and its .dev.vars file", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "vars": { "TOP": "1" }, "env": { "staging": { "vars": { "STAGE": "1" } } } }`);
        writeFileSync(join(projectRoot, ".dev.vars"), "PLAIN=1\n");
        writeFileSync(join(projectRoot, ".dev.vars.staging"), "STAGED=1\n");

        await expect(envSeen({ processEnv: { CLOUDFLARE_ENV: "staging" } })).resolves.toStrictEqual({ STAGE: "1", STAGED: "1" });
    });

    it("answers unloadable where wrangler would refuse to start: a flag that is not true or false", async () => {
        expect.assertions(1);

        await expect(check(requireKeys("API_URL"), { processEnv: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "nope" } })).resolves.toMatchObject({
            kind: "unloadable",
        });
    });

    it("still checks the env past a binding section of the wrong shape", async () => {
        expect.assertions(1);

        // `kv_namespaces` as an object used to throw out of the binding read, so
        // the whole check came back unloadable. Wrangler names the bad key itself;
        // the well-formed sections still count as bindings.
        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "kv_namespaces": {}, "r2_buckets": [{ "binding": "FILES" }] }`);

        await expect(check(requireKeys("API_URL", "FILES"))).resolves.toMatchObject({
            failures: [{ key: "API_URL" }],
            kind: "invalid",
        });
    });

    it("answers unloadable, never throws, on a .dev.vars it cannot read", async () => {
        expect.assertions(1);

        mkdirSync(join(projectRoot, ".dev.vars"));

        await expect(check(requireKeys("API_URL"))).resolves.toMatchObject({ kind: "unloadable" });
    });

    it("redacts a credential out of the reason it could not check", async () => {
        expect.assertions(2);

        // Assembled so the literal is not a secret-scanner hit in this file.
        const secret = ["sk", "live", "x".repeat(24)].join("_");
        const result = await check(
            accessorWith(() => {
                throw new Error(`bad key ${secret}`);
            }),
        );

        expect(result).toMatchObject({ kind: "unloadable" });
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("masks the key's own value in a validator message, whatever the key is named", async () => {
        expect.assertions(3);

        writeFileSync(join(projectRoot, ".dev.vars"), "DATABASE_URL=postgres://app:p@ss!@db.local/app\n");

        const result = await check(
            accessorWith((env) => [{ key: "DATABASE_URL", message: `bad host in ${String(env["DATABASE_URL"])} (password p@ss! rejected)` }]),
        );

        expect(result).toMatchObject({ kind: "invalid" });

        const message = result.kind === "invalid" ? (result.failures[0]?.message ?? "") : "";

        expect(message).not.toContain("p@ss!");
        expect(message).toContain("postgres://app:[redacted]@db.local/app");
    });

    it("masks a plain value where it stands alone, and keeps the options an enum lists readable", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".dev.vars"), "WORKER_ENV=prod\n");

        const result = await check(
            accessorWith((env) => [{ key: "WORKER_ENV", message: `expected one of "production" | "development", received "${String(env["WORKER_ENV"])}"` }]),
        );

        expect(result).toMatchObject({
            failures: [{ key: "WORKER_ENV", message: 'expected one of "production" | "development", received "[redacted]"' }],
            kind: "invalid",
        });
    });

    it("masks a short secret under a plain name, which no name or shape rule catches", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".dev.vars"), "UPSTREAM=p4ss!\n");

        const result = await check(accessorWith(() => [{ key: "UPSTREAM", message: "not a URL: p4ss!" }]));

        expect(result).toMatchObject({ failures: [{ key: "UPSTREAM", message: "not a URL: [redacted]" }], kind: "invalid" });
    });

    it("masks the whole value of a secret-named key", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".dev.vars"), "AUTH_SECRET=hunter2\n");

        const result = await check(accessorWith(() => [{ key: "AUTH_SECRET", message: "too short: hunter2" }]));

        expect(result).toMatchObject({ failures: [{ key: "AUTH_SECRET", message: "too short: [redacted]" }], kind: "invalid" });
    });

    it("ignores an export that only looks like an accessor", async () => {
        expect.assertions(1);

        const duck = Object.assign((env: unknown) => env, {
            parse: () => {
                throw Object.assign(new Error("Invalid environment"), { failures: [{ key: "API_URL", message: "missing" }] });
            },
        });

        await expect(check(duck)).resolves.toStrictEqual({ kind: "absent" });
    });

    it("does not count a key the worker gets as a binding", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "kv_namespaces": [{ "binding": "CACHE" }] }`);

        await expect(check(requireKeys("CACHE"))).resolves.toStrictEqual({ kind: "valid" });
    });

    it("still counts a key that only shares its name with a consumed queue", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "queues": { "consumers": [{ "queue": "API_URL" }] } }`);

        await expect(check(requireKeys("API_URL"))).resolves.toMatchObject({ kind: "invalid" });
    });

    it("answers unloadable for a worker config that does not exist, rather than checking the project's files", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".dev.vars"), "API_URL=https://api.test\n");

        await expect(check(requireKeys("API_URL"), { configPath: join(projectRoot, "wrangler.custom.jsonc") })).resolves.toMatchObject({
            error: expect.stringContaining("does not exist") as unknown,
            kind: "unloadable",
        });
    });

    it("counts a binding the dev session withholds from the worker as missing", async () => {
        expect.assertions(1);

        // A logged-out session leaves `ai` out of the worker, so `env.AI` is undefined at runtime.
        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "ai": { "binding": "AI" } }`);

        await expect(check(requireKeys("AI"), { withheld: ["AI"] })).resolves.toMatchObject({ failures: [{ key: "AI" }], kind: "invalid" });
    });

    it("reads the config the dev worker runs, with the vars it is started with, instead of the project's", async () => {
        expect.assertions(2);

        // The SvelteKit / Nuxt sidecar: `wrangler dev -c wrangler.dev.jsonc --var WORKER_ENV:development`.
        writeFileSync(join(projectRoot, "wrangler.jsonc"), `{ "name": "app", "vars": { "DEPLOY_ONLY": "x" } }`);
        writeFileSync(join(projectRoot, "wrangler.dev.jsonc"), `{ "name": "app-dev", "vars": { "SIDECAR_ONLY": "y" } }`);

        const options = { configPath: join(projectRoot, "wrangler.dev.jsonc"), vars: { WORKER_ENV: "development" } };

        await expect(check(requireKeys("SIDECAR_ONLY", "WORKER_ENV"), options)).resolves.toStrictEqual({ kind: "valid" });
        await expect(check(requireKeys("DEPLOY_ONLY"), options)).resolves.toMatchObject({ failures: [{ key: "DEPLOY_ONLY" }], kind: "invalid" });
    });

    it("lets a started-with var win over the config's own vars", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), JSON.stringify({ name: "app", vars: { WORKER_ENV: "production" } }));

        await expect(envSeen({ vars: { WORKER_ENV: "development" } })).resolves.toMatchObject({ WORKER_ENV: "development" });
    });

    it("lets a var the env files set win over a started-with var, as wrangler does", async () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, ".dev.vars"), "WORKER_ENV=staging\n");

        await expect(envSeen({ vars: { WORKER_ENV: "development" } })).resolves.toMatchObject({ WORKER_ENV: "staging" });
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

    it("redacts a credential out of an import failure", async () => {
        expect.assertions(1);

        const result = await checkDevEnv({
            load: async () => {
                throw new Error("connect failed: postgres://app:hunter2@db.local/app");
            },
            projectRoot,
            schemaDirectory: "lunora",
        });

        expect(JSON.stringify(result)).not.toContain("hunter2");
    });

    it("loads a real lunora/env.ts by default", async () => {
        expect.assertions(1);

        writeFileSync(
            join(projectRoot, "lunora", "env.ts"),
            `const check = (env: Record<string, unknown>) => (env["API_URL"] === undefined ? [{ key: "API_URL", message: "missing" }] : []);

export const env = Object.defineProperty((value: unknown) => value, Symbol.for("lunora.env"), { value: check });
`,
        );

        await expect(checkDevEnv({ processEnv: {}, projectRoot, schemaDirectory: "lunora" })).resolves.toMatchObject({
            failures: [{ key: "API_URL" }],
            kind: "invalid",
        });
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

    it("retracts the last warning when the contract it came from is gone", () => {
        expect.assertions(2);

        expect(describeDevEnvCheck({ kind: "absent" }, "lunora", { wasInvalid: true })).toMatchObject({ level: "info" });
        expect(describeDevEnvCheck({ kind: "absent" }, "lunora", { wasInvalid: true })?.message).toMatch(/no env contract is loaded any more/u);
    });

    it("says so when a contract the last check failed passes again", () => {
        expect.assertions(1);

        expect(describeDevEnvCheck({ kind: "valid" }, "lunora", { wasInvalid: true })).toStrictEqual({
            level: "info",
            message: "lunora/env.ts: the dev env satisfies the contract again",
        });
    });
});
