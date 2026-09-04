import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodegenResult, PlatformDiagnostic } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy/handler";
import type { FetchLike } from "../../src/commands/run/handler";
import type { HealthFetch } from "../../src/util/health-probe";
import type { Logger } from "../../src/util/logger";
import type { RecordedSpawn, Spawner } from "../../src/util/spawn";
import { createRecordingSpawner } from "../../src/util/spawn";

// A pass-through wrapper around the real `runCodegen` — every existing test in
// this file runs the genuine codegen pass unmodified. Only the platform-
// diagnostics / advisory gate tests below override a single call's result (via
// `mockImplementationOnce`, layered on the REAL result so the rest of the
// deploy pipeline still gets a valid `CodegenResult`) to exercise a diagnostic
// shape the shipped `cloudflare` capability matrix can never actually produce
// (it rates every feature `native`/`emulated`, never `unsupported`).
// eslint-disable-next-line vitest/prefer-import-in-mock -- `vi.mock(import("@lunora/codegen"), ...)` type-checks the mock's shape against the module's `default`-bearing type, which this partial re-export doesn't satisfy
vi.mock("@lunora/codegen", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/codegen")>();

    return { ...actual, runCodegen: vi.fn<typeof actual.runCodegen>(actual.runCodegen) };
});

// Keep the deploy suite hermetic: the deploy-time missing-secret gate lists the
// target's remote secrets via `wrangler secret list`, which would shell out to a
// real wrangler. Stub it to "can't determine" (ok: false) so the gate is a no-op
// and the deploy proceeds, exactly as before the gate existed. Cases that
// exercise the gate inject their own lister.
const noRemoteSecrets = (): Promise<{ names: string[]; ok: boolean }> => Promise.resolve({ names: [], ok: false });

// The container deploy cases run a full ts-morph codegen pass (container
// discovery + class generation), which is fast locally (~0.5s) but can blow past
// the shared 30s CI timeout when the runner is under heavy concurrent load (e.g.
// an affected=all run). Give this suite extra headroom on CI only — locally the
// 10s default still surfaces a genuine hang quickly.
if (process.env.CI) {
    vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });
}

/** Run async `body` while capturing everything written to `process.stdout`. */
const captureStdout = async (body: () => Promise<void>): Promise<string> => {
    let captured = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

        return true;
    });

    try {
        await body();
    } finally {
        spy.mockRestore();
    }

    return captured;
};

/** What a real `wrangler deploy` prints once the Worker is live. */
const WRANGLER_DEPLOY_OUTPUT = `Total Upload: 12.34 KiB / gzip: 4.56 KiB
Uploaded lunora-app (2.21 sec)
Deployed lunora-app triggers (0.85 sec)
  https://lunora-app.acme.workers.dev
Current Version ID: 1f2e3d4c-5b6a-7089-9a0b-1c2d3e4f5a6b
`;

/**
 * A recording spawner that behaves like wrangler: when the descriptor asked for
 * stdout (either capture mode), it resolves with real-looking deploy output so
 * the URL parser has something to read.
 */
const deployingSpawner = (stdout: string = WRANGLER_DEPLOY_OUTPUT, exitCode = 0): { calls: RecordedSpawn[]; spawner: Spawner } => {
    const calls: RecordedSpawn[] = [];

    const spawner: Spawner = (descriptor) => {
        calls.push({ descriptor });

        const captured = descriptor.captureStdout === true || descriptor.captureStdoutSilently === true;

        return Promise.resolve({ code: exitCode, stdout: captured ? stdout : undefined });
    };

    return { calls, spawner };
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

/**
 * `VALID_WRANGLER` plus a declared `env.<name>` block repeating the same
 * (non-inheritable) bindings — real wrangler only WARNS on an undeclared
 * `--env <name>` and then deploys with NO bindings at all (confirmed against
 * wrangler 4.114.0: `wrangler deploy --dry-run --env doesnotexist` prints
 * "No bindings found."), which is exactly the silent failure mode the deploy
 * validator's env-scoping gate exists to turn into a loud one — so any test
 * exercising a real `--env <name>` deploy needs a matching declared block,
 * same as a correctly-configured project would have.
 */
const validWranglerWithEnv = (name: string): string => `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }],
    "env": {
        "${name}": {
            "durable_objects": {
                "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
            },
            "d1_databases": [{ "binding": "DB", "database_name": "x-${name}", "database_id": "real-db-id-${name}" }]
        }
    }
}
`;

const silentLogger = (): { errors: string[]; infos: string[]; logger: Logger; successes: string[]; warns: string[] } => {
    const errors: string[] = [];
    const infos: string[] = [];
    const successes: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        infos,
        logger: {
            error: (message) => errors.push(message),
            info: (message) => infos.push(message),
            success: (message) => successes.push(message),
            warn: (message) => warns.push(message),
        },
        successes,
        warns,
    };
};

let workdir: string;

describe("lunora deploy", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-deploy-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("lunora deploy", () => {
        describe("deploy target", () => {
            it("rejects an unregistered target declared in lunora.json", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                writeFileSync(join(workdir, "lunora.json"), `{ "target": "clouflare" }`, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, logger, secretLister: noRemoteSecrets, spawner });

                // Deploy used to read only the `--target` flag, so a typo in the
                // committed config failed `codegen`/`prepare`/`dev` and shipped
                // fine from here — the one command where the fallback matters.
                expect(result.code).toBe(1);
                expect(result.error).toMatch(/unknown deploy target "clouflare"/);

                // And it must abort BEFORE spawning wrangler: the resolution
                // happens up front so nothing is written or published first.
                expect(calls).toHaveLength(0);
            });

            it("lets --target override lunora.json", async () => {
                expect.assertions(1);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                writeFileSync(join(workdir, "lunora.json"), `{ "target": "clouflare" }`, "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, logger, secretLister: noRemoteSecrets, spawner, target: "cloudflare" });

                expect(result.code).toBe(0);
            });
        });

        it("--dry-run leaves the committed wrangler.jsonc byte-identical", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, dryRun: true, logger, secretLister: noRemoteSecrets, spawner });

            expect(result.code).toBe(0);
            // A dry run answers "would this deploy?" — it must not edit a
            // hand-maintained, committed config to get there.
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(VALID_WRANGLER);
        });

        it("runs codegen, validates wrangler, then spawns `pnpm exec wrangler deploy`", async () => {
            expect.assertions(5);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(0);
            expect(result.validation.problems).toEqual([]);
            expect(calls).toHaveLength(1);

            const args = calls[0]?.descriptor.args.join(" ") ?? "";

            expect(args).toContain("wrangler");
            expect(args).toContain("deploy");
        });

        it("--preview uploads a version (wrangler versions upload), not a live deploy", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, preview: true, spawner });

            expect(result.code).toBe(0);

            const args = calls[0]?.descriptor.args.join(" ") ?? "";

            expect(args).toContain("wrangler versions upload");
            expect(args).not.toContain("wrangler deploy");
        });

        it("skipCodegen (the --prebuilt path) deploys without running codegen", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            // Remove the schema so codegen would fail if it ran — skipCodegen must bypass it.
            rmSync(join(workdir, "lunora"), { force: true, recursive: true });

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, skipCodegen: true, spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
        });

        it("blocks the deploy when containers build from a Dockerfile but Docker is unavailable", async () => {
            expect.assertions(3);

            const wranglerWithContainer = VALID_WRANGLER.replace(
                '"durable_objects":',
                `"containers": [{ "class_name": "TranscoderContainer", "image": "./containers/transcoder/Dockerfile", "max_instances": 2 }],
    "durable_objects":`,
            );

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWithContainer, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, dockerAvailable: () => false, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.join(" ")).toContain("no Docker-compatible engine");
        });

        it("does not require Docker when the container image is a registry reference", async () => {
            expect.assertions(1);

            const wranglerWithRegistryContainer = VALID_WRANGLER.replace(
                '"durable_objects":',
                `"observability": { "enabled": true },
    "containers": [{ "class_name": "TranscoderContainer", "image": "docker.io/acme/transcoder:1.4", "max_instances": 2 }],
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "TranscoderContainer"] }],
    "durable_objects": {
        "bindings": [
            { "name": "SHARD", "class_name": "ShardDO" },
            { "name": "CONTAINER_TRANSCODER", "class_name": "TranscoderContainer" }
        ]
    },
    "unused_durable_objects":`,
            );

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWithRegistryContainer, "utf8");

            const { spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, dockerAvailable: () => false, logger, spawner });

            expect(result.code).toBe(0);
        });

        it("builds + pushes a Railpack { build } container before wrangler deploy", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "lunora", "containers.ts"),
                `import { defineContainer } from "@lunora/container";
export const worker = defineContainer({ image: { build: "./services/worker" } });
`,
                "utf8",
            );
            mkdirSync(join(workdir, "services", "worker"), { recursive: true });

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                dockerAvailable: () => true,
                logger,
                railpackAvailable: () => true,
                spawner,
            });

            expect(result.code).toBe(0);
            // railpack build → wrangler containers push → wrangler deploy.
            expect(calls.map((call) => call.descriptor.command)).toStrictEqual(["railpack", "pnpm", "pnpm"]);
            expect(calls[0]?.descriptor.args).toStrictEqual(["build", "./services/worker", "--name", "lunora-worker:build"]);
        });

        it("--dry-run neither builds nor pushes a container image", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "lunora", "containers.ts"),
                `import { defineContainer } from "@lunora/container";
export const worker = defineContainer({ image: { build: "./services/worker" } });
`,
                "utf8",
            );
            mkdirSync(join(workdir, "services", "worker"), { recursive: true });

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                dryRun: true,
                secretLister: noRemoteSecrets,
                dockerAvailable: () => true,
                logger,
                railpackAvailable: () => true,
                spawner,
            });

            expect(result.code).toBe(0);
            // `wrangler containers push` uploads to the Cloudflare Registry — a
            // dry run must reach neither it nor the railpack build.
            expect(
                calls.map((call) => call.descriptor.args.join(" ")).filter((line) => line.includes("containers push") || line.startsWith("build ")),
            ).toStrictEqual([]);
        });

        it("blocks the deploy when a { build } container needs Railpack but it is unavailable", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "lunora", "containers.ts"),
                `import { defineContainer } from "@lunora/container";
export const worker = defineContainer({ image: { build: "./services/worker" } });
`,
                "utf8",
            );
            mkdirSync(join(workdir, "services", "worker"), { recursive: true });

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                dockerAvailable: () => true,
                logger,
                railpackAvailable: () => false,
                spawner,
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
        });

        it("blocks deploy when a Railpack build directory is missing", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "lunora", "containers.ts"),
                `import { defineContainer } from "@lunora/container";
export const worker = defineContainer({ image: { build: "./services/worker" } });
`,
                "utf8",
            );
            // NOTE: ./services/worker is deliberately NOT created.

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                dockerAvailable: () => true,
                logger,
                railpackAvailable: () => true,
                spawner,
            });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.join(" ")).toContain("build directory");
        });

        it("blocks deploy when a container's Dockerfile is missing", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "lunora", "containers.ts"),
                `import { defineContainer } from "@lunora/container";
export const transcoder = defineContainer({ image: "./containers/transcoder" });
`,
                "utf8",
            );
            // NOTE: ./containers/transcoder/Dockerfile is deliberately NOT created.

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, dockerAvailable: () => true, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.join(" ")).toContain("Dockerfile");
        });

        it("bundles src/worker.ts as the deploy entry for class-B composition when present", async () => {
            expect.assertions(3);

            // Class-B (SvelteKit/Astro): the framework's CF adapter owns wrangler
            // `main`, so the composed worker lives at src/worker.ts and must be
            // passed positionally to override `main`.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            mkdirSync(join(workdir, "src"), { recursive: true });
            writeFileSync(join(workdir, "src", "worker.ts"), "export default { fetch() {} };\nexport const ShardDO = class {};", "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { infos, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(0);

            const args = calls[0]?.descriptor.args ?? [];

            expect(args).toContain("src/worker.ts");
            expect(infos.some((line) => line.includes("class-B composition"))).toBe(true);
        });

        it("does not add a positional entry when src/worker.ts is absent (class-A/C)", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(0);
            // exec wrangler deploy — three args, no positional entry path
            expect(calls[0]?.descriptor.args).toStrictEqual(["exec", "wrangler", "deploy"]);
        });

        it("forwards --env to wrangler", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), validWranglerWithEnv("production"), "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, env: "production", logger, spawner });

            const args = calls[0]?.descriptor.args ?? [];

            expect(args).toContain("--env");
            expect(args).toContain("production");
        });

        describe("env-scoped wrangler validation (CONFIG-02)", () => {
            it("blocks --env production when the SHARD binding exists only at the top level (env.production has none)", async () => {
                expect.assertions(3);

                // Top-level-only bindings, `env.production` declares nothing —
                // the exact shape a `deploy --env production` gate used to wave
                // through despite wrangler deploying with NO bindings at all for
                // that environment (durable_objects is non-inheritable).
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }],
    "env": { "production": {} }
}
`,
                    "utf8",
                );

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, env: "production", logger, secretLister: noRemoteSecrets, spawner });

                expect(result.code).toBe(1);
                expect(result.error).toBe("wrangler validation failed");
                // Never reached the wrangler spawn.
                expect(calls).toHaveLength(0);
            });

            it("deploys once env.production repeats its own bindings", async () => {
                expect.assertions(1);

                writeFileSync(join(workdir, "wrangler.jsonc"), validWranglerWithEnv("production"), "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, env: "production", logger, secretLister: noRemoteSecrets, spawner });

                expect(result.code).toBe(0);
            });

            // `vars`, `d1_databases` and `containers` are all non-inheritable in
            // wrangler: `deploy --env <name>` uses the env block's value and
            // ignores the top level. The three read-only preflights used to read
            // the TOP LEVEL regardless of `--env`, so an env-scoped placeholder /
            // loopback origin shipped silently, and the reverse layout (real
            // values in the env block, dev values at the top) was falsely blocked.
            it("blocks a placeholder database_id declared only in env.production", async () => {
                expect.assertions(2);

                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }],
    "env": {
        "production": {
            "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
            "d1_databases": [{ "binding": "DB", "database_name": "x-prod", "database_id": "<replace-with-d1-create-id>" }]
        }
    }
}
`,
                    "utf8",
                );

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                await runDeployCommand({ cwd: workdir, env: "production", logger, secretLister: noRemoteSecrets, spawner });

                expect(calls).toHaveLength(0);
                expect(errors.join(" ")).toContain("placeholder database_id");
            });

            it("blocks a localhost origin var declared only in env.production", async () => {
                expect.assertions(2);

                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }],
    "vars": { "LUNORA_ORIGIN_URL": "https://app.example.com" },
    "env": {
        "production": {
            "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
            "d1_databases": [{ "binding": "DB", "database_name": "x-prod", "database_id": "real-db-id-prod" }],
            "vars": { "LUNORA_ORIGIN_URL": "http://localhost:8787" }
        }
    }
}
`,
                    "utf8",
                );

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                await runDeployCommand({ cwd: workdir, env: "production", logger, secretLister: noRemoteSecrets, spawner });

                expect(calls).toHaveLength(0);
                expect(errors.join(" ")).toContain("point at localhost");
            });

            it("does not block on a localhost origin the deployed environment overrides", async () => {
                expect.assertions(1);

                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }],
    "vars": { "LUNORA_ORIGIN_URL": "http://localhost:8787" },
    "env": {
        "production": {
            "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
            "d1_databases": [{ "binding": "DB", "database_name": "x-prod", "database_id": "real-db-id-prod" }],
            "vars": { "LUNORA_ORIGIN_URL": "https://app.example.com" }
        }
    }
}
`,
                    "utf8",
                );

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, env: "production", logger, secretLister: noRemoteSecrets, spawner });

                expect(result.code).toBe(0);
            });

            it("surfaces validator warnings on the command that actually ships", async () => {
                expect.assertions(2);

                // The unexported-class check is deliberately a WARNING so a
                // scanner miss cannot block a working deploy — but `deploy`
                // printed `report.errors` only, so on the one command that ships
                // a Worker the warning was invisible and wrangler failed instead.
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), "export const ShardDO = class {};\nexport default { fetch() {} };\n", "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger, warns } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, logger, secretLister: noRemoteSecrets, spawner });

                expect(result.code).toBe(0);
                expect(warns.join("\n")).toContain("SchedulerDO");
            });

            it("blocks --env <name> that names no declared environment", async () => {
                expect.assertions(3);

                // No "env" block at all in the config.
                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, env: "canary", logger, secretLister: noRemoteSecrets, spawner });

                expect(result.code).toBe(1);
                expect(calls).toHaveLength(0);
                expect(errors.some((line) => line.includes("names no environment declared"))).toBe(true);
            });
        });

        it("forwards --temporary to wrangler", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner, temporary: true });

            const args = calls[0]?.descriptor.args ?? [];

            expect(args).toContain("--temporary");
        });

        it("omits --temporary by default", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            const args = calls[0]?.descriptor.args ?? [];

            expect(args).not.toContain("--temporary");
        });

        it("auto-provisions missing bindings from inference, then blocks on D1 placeholder", async () => {
            expect.assertions(5);

            // A worker entry that exports ShardDO triggers binding inference.
            // The simple fixture has .global() tables so reconcile will write the
            // DB binding with the placeholder database_id — which must then BLOCK
            // the deploy with a clear error.
            mkdirSync(join(workdir, "src", "server"), { recursive: true });
            writeFileSync(join(workdir, "src", "server", "index.ts"), "export const ShardDO = class {};\nexport default { fetch() {} };", "utf8");
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "main": "src/server/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            // Bindings were written into wrangler.jsonc by reconcile
            const written = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            expect(written).toContain("ShardDO");
            expect(written).toContain('"DB"');

            // But deploy is blocked on the placeholder — wrangler is never spawned
            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("placeholder database_id") || line.includes("wrangler d1 create"))).toBe(true);
        });

        it("proceeds when D1 binding has a real database_id (not the placeholder)", async () => {
            expect.assertions(3);

            // Wrangler already has all bindings, including a real D1 database_id.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
            expect(result.error).toBeUndefined();
        });

        it("aborts when wrangler has a problem inference cannot fix", async () => {
            expect.assertions(3);

            // A stale compatibility_date is outside what reconcile touches, so
            // even after binding provisioning the validator must still abort.
            // We pre-write the SHARD binding and a real DB id so the D1
            // placeholder check is not triggered before the validator runs.
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "2020-01-01",
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-id-xyz" }]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("compatibility_date"))).toBe(true);
        });

        it("blocks deploy when D1 binding has placeholder database_id", async () => {
            expect.assertions(4);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "lunora-app", "database_id": "<replace-with-d1-create-id>" }]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("placeholder database_id"))).toBe(true);
            expect(errors.some((line) => line.includes("wrangler d1 create"))).toBe(true);
        });

        // A hand-written `"d1_databases": [null]` type-checks as an array, so the
        // `Array.isArray` normalisation let it through and the placeholder gate
        // then dereferenced `entry.database_id` — a TypeError out of a preflight
        // instead of the validator's report on the malformed config.
        it("reports the malformed config instead of throwing on a null d1_databases entry", async () => {
            expect.assertions(3);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [null]
}`,
                "utf8",
            );

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(1);
            expect(calls).toHaveLength(0);
            // The validator's own report, not a stack trace out of the gate.
            expect(errors.join(" ")).not.toContain("Cannot read properties");
        });

        it("syncs code-first cron schedules into wrangler.jsonc triggers.crons", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
            writeFileSync(
                join(workdir, "lunora", "crons.ts"),
                `import { cronJobs } from "@lunora/scheduler";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.cron("ping", "0 * * * *", internal.messages.list, {});

export default crons;
`,
                "utf8",
            );

            const { spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(0);

            const written = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            expect(written).toContain("0 * * * *");
        });

        it("clears a stale triggers.crons array when the project declares no crons", async () => {
            expect.assertions(2);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                VALID_WRANGLER.replace('"d1_databases"', '"triggers": { "crons": ["0 0 * * *"] },\n    "d1_databases"'),
                "utf8",
            );

            const { spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            expect(result.code).toBe(0);

            const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers?: { crons?: string[] } };

            expect(parsed.triggers?.crons).toEqual([]);
        });

        it("preserves committed triggers.crons on the --prebuilt (skipCodegen) path", async () => {
            expect.assertions(2);

            // --prebuilt skips codegen, so no cron schedules are discovered. The
            // committed triggers.crons must be left untouched — clearing it would
            // silently stop every production cron. Remove the lunora/ schema so
            // codegen would fail if it ran, proving the path really is skipped.
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                VALID_WRANGLER.replace('"d1_databases"', '"triggers": { "crons": ["*/5 * * * *"] },\n    "d1_databases"'),
                "utf8",
            );
            rmSync(join(workdir, "lunora"), { force: true, recursive: true });

            const { spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, skipCodegen: true, spawner });

            expect(result.code).toBe(0);

            const parsed = parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as { triggers?: { crons?: string[] } };

            expect(parsed.triggers?.crons).toEqual(["*/5 * * * *"]);
        });

        it("does not run migrations when --migrate is not set", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { logger } = silentLogger();

            const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });

            // Only one spawn call (wrangler deploy); no migration RPC calls
            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
        });

        it("skips migration phase when deploy fails (non-zero exit)", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            // A spawner that simulates a failed deploy
            const { spawner: failingSpawner } = createRecordingSpawner(1);
            const { logger, infos } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                logger,
                migrate: true,
                migrateToken: "test-token",
                migrateUrl: "https://my-worker.workers.dev",
                migrateYes: true,
                spawner: failingSpawner,
            });

            expect(result.code).toBe(1);
            // No migration info messages — migration phase was skipped
            expect(infos.some((line) => line.includes("--migrate"))).toBe(false);
        });

        it("--migrate: blocks before deploy when production migration confirmation is missing", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                logger,
                migrate: true,
                migrateToken: "test-token",
                migrateUrl: "https://my-worker.workers.dev",
                spawner,
            });

            expect(result.code).toBe(1);
            expect(result.descriptor).toBeUndefined();
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("--migrate-yes"))).toBe(true);
        });

        it("--migrate: blocks before deploy when the worker migration URL is missing", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();
            const { errors, logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                logger,
                migrate: true,
                migrateToken: "test-token",
                migrateYes: true,
                spawner,
            });

            expect(result.code).toBe(1);
            expect(result.descriptor).toBeUndefined();
            expect(calls).toHaveLength(0);
            expect(errors.some((line) => line.includes("--migrate-url"))).toBe(true);
        });

        it("--migrate: runs all declared migrations after a successful deploy", async () => {
            expect.assertions(4);

            // Write a migrations.ts so discoverMigrations finds at least one id
            const lunoraDirectory = join(workdir, "lunora");
            const migrationsFile = join(lunoraDirectory, "migrations.ts");

            writeFileSync(
                migrationsFile,
                `import { defineMigration } from "@lunora/server";

export const backfillNames = defineMigration({
    id: "backfill-names",
    table: "users",
    up: (doc) => doc,
});
`,
                "utf8",
            );

            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { calls, spawner } = createRecordingSpawner();

            // Provide a fetch stub so runMigrateDataCommand succeeds without a
            // real worker. The RPC endpoint returns a 200 JSON body.
            const fetchStub: FetchLike = () =>
                Promise.resolve({
                    ok: true,
                    text: () => Promise.resolve(JSON.stringify({ status: "ok" })),
                } as Response);

            const { infos, logger } = silentLogger();

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                fetchImpl: fetchStub,
                logger,
                migrate: true,
                migrateToken: "test-token",
                migrateUrl: "https://my-worker.workers.dev",
                migrateYes: true,
                spawner,
            });

            // Deploy succeeded
            expect(result.code).toBe(0);
            // wrangler deploy was spawned exactly once
            expect(calls).toHaveLength(1);
            // Migration log messages emitted
            expect(infos.some((line) => line.includes("--migrate"))).toBe(true);
            expect(infos.some((line) => line.includes("backfill-names"))).toBe(true);
        });

        it("--migrate does not claim migrations were applied when none were", async () => {
            expect.assertions(3);

            // No `lunora/migrations.ts`: discovery finds nothing to run.
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const { spawner } = createRecordingSpawner();
            const { infos, logger, warns } = silentLogger();
            const fetchStub: FetchLike = () => Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: "ok" })) } as Response);

            const result = await runDeployCommand({
                cwd: workdir,
                secretLister: noRemoteSecrets,
                fetchImpl: fetchStub,
                logger,
                migrate: true,
                migrateToken: "test-token",
                migrateUrl: "https://my-worker.workers.dev",
                migrateYes: true,
                spawner,
            });

            expect(result.code).toBe(0);
            // The truthful line is there — discovery found nothing to run…
            expect([...infos, ...warns].some((line) => line.includes("migration"))).toBe(true);
            // …and the summary does not contradict it from the flag alone.
            expect(infos.some((line) => line.includes("migrations: applied"))).toBe(false);
        });

        describe("--format json", () => {
            it("emits a single parseable JSON document with the structured result", async () => {
                expect.assertions(4);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, format: "json", logger, spawner });
                });

                const parsed = JSON.parse(stdout) as { code: number; descriptor: { args: string[] } | null; validation: { problems: unknown[] } };

                expect(parsed.code).toBe(0);
                expect(parsed).toHaveProperty("validation");
                expect(parsed.validation.problems).toEqual([]);
                expect(parsed.descriptor?.args).toContain("deploy");
            });

            it("captures the spawned wrangler's stdout SILENTLY so it can't corrupt the JSON document", async () => {
                // Regression: `wrangler deploy`'s progress + deployed-URL output
                // must never interleave with the JSON on stdout, or
                // `lunora deploy --format json | jq` breaks. json mode therefore
                // captures without teeing (`captureStdoutSilently`); the plain
                // `captureStdout` used in pretty mode WOULD tee, and corrupt it.
                expect.assertions(5);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = deployingSpawner();
                const { logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, format: "json", logger, spawner });
                });

                expect(calls[0]?.descriptor.captureStdoutSilently).toBe(true);
                expect(calls[0]?.descriptor.captureStdout).toBe(false);

                // Exactly one JSON document, with no wrangler text mixed in.
                expect(stdout).not.toContain("Total Upload");
                expect(JSON.parse(stdout)).toHaveProperty("deployment");

                // Pretty mode tees, so the user still watches live progress.
                const pretty = deployingSpawner();

                await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner: pretty.spawner });

                expect(pretty.calls[0]?.descriptor.captureStdout).toBe(true);
            });

            it("routes a postcodegen script's stdout to stderr in json mode", async () => {
                expect.assertions(4);

                // Same reservation as wrangler's output above: in `--format json`
                // stdout carries one JSON document, so a `postcodegen` script that
                // prints anything would interleave with and corrupt it.
                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                writeFileSync(
                    join(workdir, "package.json"),
                    JSON.stringify({ dependencies: { "@lunora/d1": "1.0.0" }, name: "app", scripts: { postcodegen: "node ./patch.mjs" } }),
                    "utf8",
                );

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, format: "json", logger, spawner });
                });

                const hookCall = calls.find((call) => call.descriptor.args.includes("postcodegen"));

                expect(hookCall).toBeDefined();
                expect(hookCall?.descriptor.stdoutToStderr).toBe(true);

                // Pretty mode leaves the script's output on stdout, where the user reads it.
                const pretty = createRecordingSpawner();

                await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner: pretty.spawner });

                const prettyHookCall = pretty.calls.find((call) => call.descriptor.args.includes("postcodegen"));

                expect(prettyHookCall).toBeDefined();
                expect(prettyHookCall?.descriptor.stdoutToStderr).toBe(false);
            });

            it("serializes the error into the JSON document when validation fails", async () => {
                expect.assertions(2);

                // No wrangler.jsonc → validation failure, deploy never spawns.
                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, format: "json", logger, spawner });
                });

                const parsed = JSON.parse(stdout) as { code: number; error?: string };

                expect(parsed.code).toBe(1);
                expect(parsed.error).toBeDefined();
            });

            it("reports the deployed URL in the document, so an automation never has to read it with its eyes", async () => {
                expect.assertions(5);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner();
                const { logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, env: undefined, secretLister: noRemoteSecrets, format: "json", logger, spawner });
                });

                const parsed = JSON.parse(stdout) as {
                    deployment?: { deployedAt: string; dryRun: boolean; preview: boolean; url?: string; workerName?: string };
                };

                expect(parsed.deployment?.url).toBe("https://lunora-app.acme.workers.dev");
                expect(parsed.deployment?.workerName).toBe("lunora-app");
                expect(parsed.deployment?.dryRun).toBe(false);
                expect(parsed.deployment?.preview).toBe(false);
                expect(Number.isNaN(Date.parse(parsed.deployment?.deployedAt ?? ""))).toBe(false);
            });

            it("--preview --format json reports the preview URL", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner("Worker Version ID: abc\n  https://preview-abc-lunora-app.acme.workers.dev\n");
                const { logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, format: "json", logger, preview: true, spawner });
                });

                const parsed = JSON.parse(stdout) as { deployment?: { preview: boolean; url?: string } };

                expect(parsed.deployment?.url).toBe("https://preview-abc-lunora-app.acme.workers.dev");
                expect(parsed.deployment?.preview).toBe(true);
                // A preview never becomes the checkout's recorded target.
                expect(existsSync(join(workdir, ".lunora", "project.json"))).toBe(false);
            });

            it("--dry-run reports the discriminator and no URL — nothing was published", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = deployingSpawner();
                const { logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    await runDeployCommand({ cwd: workdir, dryRun: true, secretLister: noRemoteSecrets, format: "json", logger, spawner });
                });

                const parsed = JSON.parse(stdout) as { deployment?: { dryRun: boolean; url?: string } };

                expect(parsed.deployment?.dryRun).toBe(true);
                expect(parsed.deployment?.url).toBeUndefined();
                // Nothing to read → wrangler's stdout is not captured at all.
                expect(calls[0]?.descriptor.captureStdoutSilently).toBe(false);
            });

            it("rejects an unknown --format the same way logs does", async () => {
                expect.assertions(5);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                const stdout = await captureStdout(async () => {
                    const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, format: "yaml", logger, spawner });

                    expect(result.code).toBe(1);
                    expect(result.error).toBeDefined();
                });

                expect(stdout).toBe("");
                expect(errors.some((line) => line.includes('unknown --format "yaml" — expected pretty | json'))).toBe(true);
                expect(calls).toHaveLength(0);
            });
        });

        describe("link capture", () => {
            it("records the deployed URL after a real deploy", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner });
                const written = JSON.parse(readFileSync(join(workdir, ".lunora", "project.json"), "utf8")) as { workerUrl?: string };

                expect(result.code).toBe(0);
                expect(written.workerUrl).toBe("https://lunora-app.acme.workers.dev");
            });

            it("--temporary reports the URL but never records it as the checkout's target", async () => {
                expect.assertions(2);

                // The account is deleted in ~60 minutes; a link pointing at it
                // would silently misroute `run` / `logs` / `--migrate` afterwards.
                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, secretLister: noRemoteSecrets, logger, spawner, temporary: true });

                expect(result.deployment?.url).toBe("https://lunora-app.acme.workers.dev");
                expect(existsSync(join(workdir, ".lunora", "project.json"))).toBe(false);
            });
        });

        describe("--health-check", () => {
            it("passes when the new version answers", async () => {
                expect.assertions(4);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner();
                const { logger } = silentLogger();
                const healthFetch = vi.fn<HealthFetch>(async () => {
                    return { ok: true, status: 200 };
                });

                const result = await runDeployCommand({ cwd: workdir, healthCheck: true, healthFetch, secretLister: noRemoteSecrets, logger, spawner });

                expect(result.code).toBe(0);
                expect(result.healthCheck?.ok).toBe(true);
                // Probed at the URL THIS run published to, readiness gate first.
                expect(healthFetch).toHaveBeenCalledWith("https://lunora-app.acme.workers.dev/_lunora/health/ready");
                expect(result.healthCheck?.error).toBeUndefined();
            });

            it("fails the command when the probe never goes green, and says the deploy itself succeeded", async () => {
                expect.assertions(4);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner();
                const { errors, logger } = silentLogger();
                const healthFetch = vi.fn<HealthFetch>(async () => {
                    return { ok: false, status: 503 };
                });

                const result = await runDeployCommand({
                    cwd: workdir,
                    healthCheck: true,
                    healthFetch,
                    healthSleep: async () => {},
                    secretLister: noRemoteSecrets,
                    logger,
                    spawner,
                });

                expect(result.code).toBe(1);
                expect(result.healthCheck?.error).toContain("returned HTTP 503");
                // The deploy succeeded and the probe did not — different facts.
                expect(errors.join("\n")).toContain("the deploy succeeded, but the new version did not answer");
                // The identity is still reported: the version IS out there.
                expect(result.deployment?.url).toBe("https://lunora-app.acme.workers.dev");
            });

            it("is skipped (with a warning) on a dry run, which publishes nothing to probe", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = deployingSpawner();
                const { logger, warns } = silentLogger();
                const healthFetch = vi.fn<HealthFetch>(async () => {
                    return { ok: true, status: 200 };
                });

                const result = await runDeployCommand({
                    cwd: workdir,
                    dryRun: true,
                    healthCheck: true,
                    healthFetch,
                    secretLister: noRemoteSecrets,
                    logger,
                    spawner,
                });

                expect(result.code).toBe(0);
                expect(healthFetch).not.toHaveBeenCalled();
                expect(warns.join("\n")).toContain("--health-check skipped");
            });

            it("refuses rather than guessing an origin when no URL can be resolved", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                // wrangler printed no URL (custom-route-only worker) and the
                // checkout has no link → nothing safe to probe.
                const { spawner } = deployingSpawner("Total Upload: 1 KiB\nDeployed lunora-app triggers\n");
                const { errors, logger } = silentLogger();
                const healthFetch = vi.fn<HealthFetch>(async () => {
                    return { ok: true, status: 200 };
                });

                const result = await runDeployCommand({ cwd: workdir, healthCheck: true, healthFetch, secretLister: noRemoteSecrets, logger, spawner });

                expect(result.code).toBe(1);
                expect(healthFetch).not.toHaveBeenCalled();
                expect(errors.join("\n")).toContain("no URL to probe could be resolved");
            });
        });

        describe("missing-secret gate", () => {
            it("mints a missing secret, records it in .dev.vars, and never logs the value", async () => {
                expect.assertions(6);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { errors, infos, logger, successes } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    // Remote has no secrets → the core LUNORA_ADMIN_TOKEN is missing + mintable,
                    // and .dev.vars has no value for it yet → a fresh value is minted.
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(0);
                // The result carries the (filename-only) record location so the caller
                // (the end-of-deploy summary) can point at it too.
                expect(result.mintedSecretsFile).toBe(".dev.vars");

                const secretPush = calls.find((call) => call.descriptor.args.join(" ").includes("secret put LUNORA_ADMIN_TOKEN"));

                // `wrangler secret put` is write-only — the ONLY place this value can
                // still be read back from is the file it was disclosed into.
                expect(secretPush?.descriptor.input).toMatch(/^[a-f0-9]{64}$/u);

                const mintedValue = secretPush?.descriptor.input ?? "";

                expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).toContain(`LUNORA_ADMIN_TOKEN="${mintedValue}"`);

                // Never printed, logged, or otherwise disclosed anywhere but the file.
                expect([...errors, ...infos, ...successes].join("\n")).not.toContain(mintedValue);
                // The success line names the key and points at the file — never the value.
                expect(successes.some((line) => line.includes("LUNORA_ADMIN_TOKEN") && line.includes(".dev.vars"))).toBe(true);
            });

            it("the end-of-deploy summary points at the file a minted secret was recorded into", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = createRecordingSpawner();
                const { infos, logger } = silentLogger();

                await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                // The summary is where an operator looks after a long deploy — it must
                // name the file too, not just the log line printed minutes earlier.
                expect(infos.some((line) => line.includes("secrets:") && line.includes(".dev.vars"))).toBe(true);
                expect(infos.some((line) => line.includes("deploy complete") || line.includes("worker:"))).toBe(true);
            });

            it("--env production's summary points at the .dev.vars.production sibling, not the bare file", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), validWranglerWithEnv("production"), "utf8");

                const { spawner } = createRecordingSpawner();
                const { infos, logger } = silentLogger();

                await runDeployCommand({
                    cwd: workdir,
                    env: "production",
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(infos.some((line) => line.includes("secrets:") && line.includes(".dev.vars.production"))).toBe(true);
                // Never claims the bare, environment-agnostic file for a named --env.
                expect(infos.some((line) => line.includes("secrets:") && !line.includes(".dev.vars.production"))).toBe(false);
            });

            it("writes the minted secret file owner-only (mode 0o600), not world-readable", async () => {
                expect.assertions(1);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                // eslint-disable-next-line no-bitwise -- checking the permission bits is the point of this test
                expect(statSync(join(workdir, ".dev.vars")).mode & 0o777).toBe(0o600);
            });

            it("never reuses an existing local .dev.vars value — always mints fresh, even for a non-placeholder key", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                // A real (non-placeholder) value already sits in .dev.vars for the
                // missing key. Reusing it — the behaviour this test guards against —
                // would let a real-but-weak shared dev secret quietly become the
                // value protecting the deploy target.
                const existingValue = "existing-local-dev-token";

                writeFileSync(join(workdir, ".dev.vars"), `LUNORA_ADMIN_TOKEN="${existingValue}"\n`, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(0);

                const secretPush = calls.find((call) => call.descriptor.args.join(" ").includes("secret put LUNORA_ADMIN_TOKEN"));

                // A fresh value was minted — never the pre-existing local one.
                expect(secretPush?.descriptor.input).toMatch(/^[a-f0-9]{64}$/u);
                expect(secretPush?.descriptor.input).not.toBe(existingValue);
            });

            it("--env production writes the minted secret into a sibling .dev.vars.production, leaving bare .dev.vars untouched", async () => {
                expect.assertions(4);

                writeFileSync(join(workdir, "wrangler.jsonc"), validWranglerWithEnv("production"), "utf8");

                // A pre-existing bare .dev.vars (local dev's own file) must not be
                // touched by a secret minted for a DIFFERENT, named environment.
                // eslint-disable-next-line no-secrets/no-secrets -- test fixture literal, not a real secret
                const localDevVars = 'SOME_OTHER_LOCAL_VAR="untouched"\n';

                writeFileSync(join(workdir, ".dev.vars"), localDevVars, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    env: "production",
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(0);

                const secretPush = calls.find((call) => call.descriptor.args.join(" ").includes("secret put LUNORA_ADMIN_TOKEN"));
                const mintedValue = secretPush?.descriptor.input ?? "";

                expect(mintedValue).toMatch(/^[a-f0-9]{64}$/u);
                // The env-scoped sibling file gets the minted value...
                expect(readFileSync(join(workdir, ".dev.vars.production"), "utf8")).toContain(`LUNORA_ADMIN_TOKEN="${mintedValue}"`);
                // ...and the bare, environment-agnostic .dev.vars is left exactly as it was.
                expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).toBe(localDevVars);
            });

            it("makes the file it records a minted secret in un-committable first", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), validWranglerWithEnv("production"), "utf8");
                // What every scaffolded project ships: `.dev.vars` exactly, which
                // git matches by exact name — it does NOT cover `.dev.vars.production`.
                writeFileSync(join(workdir, ".gitignore"), "node_modules\n.dev.vars\n", "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    env: "production",
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(0);
                expect(existsSync(join(workdir, ".dev.vars.production"))).toBe(true);
                expect(readFileSync(join(workdir, ".gitignore"), "utf8")).toContain(".dev.vars.*");
            });

            it("interactively generates + pushes a missing mintable secret before deploying", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    // Remote has no secrets → the core LUNORA_ADMIN_TOKEN is missing + mintable.
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                const argv = calls.map((call) => call.descriptor.args.join(" "));

                expect(result.code).toBe(0);
                // The mintable secret was generated + pushed (via stdin) before the deploy spawn.
                expect(argv.some((line) => line.includes("wrangler secret put LUNORA_ADMIN_TOKEN"))).toBe(true);
                expect(argv.some((line) => line.includes("wrangler deploy"))).toBe(true);
            });

            it("aborts an interactive deploy when the confirmed secret push fails instead of deploying anyway", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                // Every spawn (including the confirmed `wrangler secret put`) fails.
                const { calls, spawner } = createRecordingSpawner(1);
                const { errors, logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(1);
                // Never reached the wrangler deploy spawn — a failed secret push must
                // not fall through to shipping a worker still missing that secret.
                expect(calls.some((call) => call.descriptor.args.join(" ").includes("wrangler deploy"))).toBe(false);
                expect(errors.some((line) => line.includes("failed to push required secret"))).toBe(true);
            });

            it("launches wrangler through npx (secret-push + deploy) when the project declares npm", async () => {
                expect.assertions(5);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                // `detectPackageManager` reads the nearest package.json's `packageManager`.
                // The manifest must also declare the fixture's add-ons: this schema has
                // `.global()` tables, and codegen's required-package gate reads a manifest
                // that exists as authoritative ("declares nothing"), not as "cannot tell".
                writeFileSync(join(workdir, "package.json"), `{ "dependencies": { "@lunora/d1": "*" }, "packageManager": "npm@10.9.0" }\n`, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    interactive: true,
                    logger,
                    secretConfirm: () => Promise.resolve(true),
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(0);

                // Every wrangler invocation now goes through `npx -- wrangler …`.
                const secretPush = calls.find((call) => call.descriptor.args.includes("secret"));
                const deploySpawn = calls.find((call) => call.descriptor.args.includes("deploy"));

                // The secret value travels over stdin (`input`), never on argv.
                expect(secretPush?.descriptor).toMatchObject({ args: ["--", "wrangler", "secret", "put", "LUNORA_ADMIN_TOKEN"], command: "npx" });
                expect(typeof secretPush?.descriptor.input).toBe("string");
                expect(secretPush?.descriptor.args).not.toContain(secretPush?.descriptor.input);

                expect(deploySpawn?.descriptor).toMatchObject({ args: ["--", "wrangler", "deploy"], command: "npx" });
            });

            it("aborts a non-interactive deploy when a required secret is missing on the target", async () => {
                expect.assertions(3);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    interactive: false,
                    logger,
                    // Worker exists (ok) but has no secrets → can't prompt → must abort.
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(1);
                // Never reached the wrangler deploy spawn.
                expect(calls.some((call) => call.descriptor.args.join(" ").includes("wrangler deploy"))).toBe(false);
                expect(errors.some((line) => line.includes("missing required secret"))).toBe(true);
            });

            it("a staging deploy's missing-secret remediation names --env staging, not --prod", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), validWranglerWithEnv("staging"), "utf8");

                const { spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    env: "staging",
                    interactive: false,
                    logger,
                    secretLister: () => Promise.resolve({ names: [], ok: true }),
                    spawner,
                });

                expect(result.code).toBe(1);
                expect(errors.some((line) => line.includes("lunora env push --yes --env staging") && !line.includes("--prod"))).toBe(true);
            });
        });

        describe("platform-diagnostics / advisory gate", () => {
            /** Append an index referencing a column that doesn't exist — `index_references_unknown_field` is an ERROR-level advisory. */
            const addBogusIndexToSchema = (dir: string): void => {
                const schemaPath = join(dir, "lunora", "schema.ts");
                const schema = readFileSync(schemaPath, "utf8");
                const patched = schema.replace(
                    `.searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),`,
                    `.searchIndex("by_text", { field: "text", filterFields: ["channelId"] })\n        .index("by_bogus", ["doesNotExist"]),`,
                );

                expect(patched).not.toBe(schema);

                writeFileSync(schemaPath, patched, "utf8");
            };

            it("deploys a clean project with the gate in place", async () => {
                expect.assertions(1);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, logger, secretLister: noRemoteSecrets, spawner, strictAdvisories: true });

                expect(result.code).toBe(0);
            });

            it("aborts a strict deploy on an ERROR-level codegen advisory", async () => {
                expect.assertions(5);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                addBogusIndexToSchema(workdir);

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, logger, secretLister: noRemoteSecrets, spawner, strictAdvisories: true });

                expect(result.code).toBe(1);
                expect(calls).toHaveLength(0);
                expect(result.error).toContain("ERROR-level");
                expect(errors.some((line) => line.includes("index_references_unknown_field"))).toBe(true);
            });

            it("--no-strict-advisories deploys anyway despite the same ERROR-level advisory", async () => {
                expect.assertions(2);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
                addBogusIndexToSchema(workdir);

                const { spawner } = createRecordingSpawner();
                const { logger } = silentLogger();

                const result = await runDeployCommand({ cwd: workdir, logger, secretLister: noRemoteSecrets, spawner, strictAdvisories: false });

                expect(result.code).toBe(0);
            });

            it("aborts on an error-level platform diagnostic even with the advisory opt-out set", async () => {
                expect.assertions(4);

                writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

                // The shipped `cloudflare` capability matrix rates every feature
                // native/emulated — never unsupported — so a real project can't
                // produce this diagnostic today. Layer it onto the REAL codegen
                // result (one call only) so the rest of the pipeline still sees a
                // valid `CodegenResult`.
                const actual = await vi.importActual<typeof import("@lunora/codegen")>("@lunora/codegen");
                const diagnostic: PlatformDiagnostic = {
                    level: "error",
                    message: `ctx.ai is used, but target "cloudflare" does not support it`,
                    name: "platform_unsupported_feature",
                    remediation: "remove the usage, or choose a target that supports it",
                    target: "cloudflare",
                };

                vi.mocked(runCodegen).mockImplementationOnce((options): CodegenResult => {
                    return { ...actual.runCodegen(options), platformDiagnostics: [diagnostic] };
                });

                const { calls, spawner } = createRecordingSpawner();
                const { errors, logger } = silentLogger();

                const result = await runDeployCommand({
                    cwd: workdir,
                    logger,
                    secretLister: noRemoteSecrets,
                    spawner,
                    // The opt-out downgrades ERROR advisories, never platform
                    // diagnostics — those mean the emitted surface doesn't match
                    // what the target can actually serve.
                    strictAdvisories: false,
                });

                expect(result.code).toBe(1);
                expect(calls).toHaveLength(0);
                expect(result.error).toContain("ctx.ai");
                expect(errors.some((line) => line.includes("platform_unsupported_feature"))).toBe(true);
            });
        });
    });
});
