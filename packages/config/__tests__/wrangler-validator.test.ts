import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WranglerConfig, WranglerValidationReport } from "../src/cloudflare/wrangler-validator";
import {
    REQUIRED_COMPATIBILITY_DATE,
    REQUIRED_FLAG,
    validateWrangler,
    validateWranglerConfig,
    validateWranglerProject,
    withTailConsumer,
} from "../src/cloudflare/wrangler-validator";

const SHARD_BINDING_ERROR_RE = /SHARD.+ShardDO/u;
const WRANGLER_NOT_FOUND_RE = /wrangler\.jsonc not found/u;

const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    }).global(),
});
`;

const SCHEMA_NO_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

const SCHEMA_WITH_VECTOR = `import { defineSchema, defineTable, v } from "@lunora/server";
import { embed } from "../app/embed";

export const schema = defineSchema({
    docs: defineTable({
        body: v.string(),
        workspaceId: v.id("workspaces"),
    })
        .shardBy("workspaceId")
        .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", embed }),
});
`;

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["nodejs_compat", "${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "lunora-global", "database_id": "x" }]
}
`;

let workdir: string;

const writeSchema = (source: string): void => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), source, "utf8");
};

/**
 * Write the `src/index.ts` these fixtures point `main` at. A `main` with no file
 * behind it draws a warning of its own, so a fixture that declares one ships it
 * rather than asserting around the noise.
 */
const writeMainEntry = (): void => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "index.ts"), `export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`, "utf8");
};

describe("wrangler-validator", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-config-wrangler-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("validateWranglerConfig (pure)", () => {
        it("returns valid:true when all required bindings/flags are present", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            };

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        });

        it("reports the SHARD binding when missing", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
            });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("does not require the compatibility flag when compatibility_date is recent enough", () => {
            expect.assertions(2);

            // web_socket_auto_reply_to_close became the default on REQUIRED_COMPATIBILITY_DATE,
            // so it should not be required (and workerd warns when it's set redundantly).
            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: ["nodejs_compat"],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            });

            expect(report.valid).toBe(true);
            expect(report.errors.some((line) => line.includes(REQUIRED_FLAG))).toBe(false);
        });

        it("reports a malformed compatibility_date that is not YYYY-MM-DD", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: "2026-4-7",
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("YYYY-MM-DD"))).toBe(true);
        });

        it("does not throw and reports a tail_consumers entry that is null", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                tail_consumers: [null],
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("tail_consumers[0]"))).toBe(true);
        });

        it("does not throw when a vectorize entry is null", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vectorize: [null],
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler, { hasD1GlobalTable: false, hasHyperdriveGlobalTable: false, vectorIndexNames: ["docs-body"] });

            // The null entry is skipped; the declared index is simply unmatched.
            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("docs-body"))).toBe(true);
        });

        it("does not throw when durable_objects.bindings contains a null entry (JSONC trailing comma)", () => {
            expect.assertions(2);

            // `"durable_objects": { "bindings": [null] }` — a stray trailing comma in JSONC
            // parses to exactly this. The validator must report the missing SHARD binding,
            // not crash with a raw TypeError dereferencing `binding.name`.
            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [null] },
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("does not throw when durable_objects.bindings is a non-array value", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: "SHARD" },
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("does not throw when d1_databases contains a null entry for a global-table schema", () => {
            expect.assertions(2);

            const wrangler = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                d1_databases: [null],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            } as unknown as WranglerConfig;

            const report = validateWranglerConfig(wrangler, { hasD1GlobalTable: true, hasHyperdriveGlobalTable: false, vectorIndexNames: [] });

            // The null entry is skipped; the missing "DB" binding is reported structurally.
            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        describe("the SchedulerDO dispatch origin", () => {
            // The DO reads LUNORA_ORIGIN_URL from its own env and refuses to
            // schedule without it, and nothing provisions the var — so an app can
            // ship with every ctx.scheduler.runAfter failing. A WARNING, never an
            // error: `vars` cannot see a secret or a dashboard value.
            const ORIGIN_VAR = "LUNORA_ORIGIN_URL";

            const withScheduler = (extra: Partial<WranglerConfig> = {}, binding: Record<string, unknown> = {}): WranglerConfig => {
                return {
                    compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                    compatibility_flags: [REQUIRED_FLAG],
                    durable_objects: {
                        bindings: [
                            { class_name: "ShardDO", name: "SHARD" },
                            { class_name: "SchedulerDO", name: "SCHEDULER", ...binding },
                        ],
                    },
                    migrations: [{ new_sqlite_classes: ["ShardDO", "SchedulerDO"] }],
                    ...extra,
                };
            };

            const originWarnings = (report: WranglerValidationReport): string[] => report.warnings.filter((line) => line.includes(ORIGIN_VAR));

            it("warns — never errors — when a declared SchedulerDO has no origin var", () => {
                expect.assertions(3);

                const report = validateWranglerConfig(withScheduler());

                // Erroring would block a deploy whose origin is a `wrangler secret
                // put` value, and kill the dev server on the run that wrote the binding.
                expect(report.valid).toBe(true);
                expect(originWarnings(report)).toHaveLength(1);
                expect(originWarnings(report)[0]).toContain(`vars.${ORIGIN_VAR} is unset`);
            });

            it("stays silent once the var carries a non-empty value", () => {
                expect.assertions(1);

                expect(originWarnings(validateWranglerConfig(withScheduler({ vars: { LUNORA_ORIGIN_URL: "https://app.example" } })))).toEqual([]);
            });

            it("treats an empty or non-string value as unset", () => {
                expect.assertions(2);

                expect(originWarnings(validateWranglerConfig(withScheduler({ vars: { LUNORA_ORIGIN_URL: "" } })))).toHaveLength(1);
                expect(originWarnings(validateWranglerConfig(withScheduler({ vars: { LUNORA_ORIGIN_URL: 123 } })))).toHaveLength(1);
            });

            it("ignores a SchedulerDO owned by another script — that Worker's env holds the var", () => {
                expect.assertions(1);

                // Same carve-out the migration and unexported-class checks make: a
                // `script_name` binding names a class this config does not deploy,
                // so this config's `vars` say nothing about its origin.
                expect(originWarnings(validateWranglerConfig(withScheduler({}, { script_name: "scheduler-worker" })))).toEqual([]);
            });

            it("stays silent for a project with no SchedulerDO binding", () => {
                expect.assertions(1);

                const report = validateWranglerConfig({
                    compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                    compatibility_flags: [REQUIRED_FLAG],
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                });

                expect(originWarnings(report)).toEqual([]);
            });

            it("names the environment under --env, where vars do not inherit", () => {
                expect.assertions(2);

                // The top level has the var; env.production does not inherit it
                // (`vars` is non-inheritable), so a message naming the bare `vars`
                // would point at a block that already looks correct.
                const config = withScheduler({
                    env: { production: { durable_objects: { bindings: [{ class_name: "SchedulerDO", name: "SCHEDULER" }] } } },
                    vars: { LUNORA_ORIGIN_URL: "https://app.example" },
                });

                const warnings = originWarnings(validateWranglerConfig(config, undefined, "production"));

                expect(warnings).toHaveLength(1);
                expect(warnings[0]).toContain(`env.production.vars.${ORIGIN_VAR}`);
            });

            it("scopes the secret remedy to the same environment", () => {
                expect.assertions(2);

                // Wrangler secrets are non-inheritable too, so an unscoped
                // `secret put` writes the top-level worker and leaves the
                // environment the warning is about exactly as it was.
                const config = withScheduler({
                    env: { production: { durable_objects: { bindings: [{ class_name: "SchedulerDO", name: "SCHEDULER" }] } } },
                });

                expect(originWarnings(validateWranglerConfig(config, undefined, "production"))[0]).toContain(`secret put ${ORIGIN_VAR} --env production`);
                expect(originWarnings(validateWranglerConfig(config))[0]).not.toContain("--env");
            });
        });

        it("rejects a wildcard CORS origin paired with credentials in vars", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: "https://app.example.com, *", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
            });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(true);
        });

        it("allows a wildcard origin without credentials, and credentials without a wildcard", () => {
            expect.assertions(2);

            const wildcardOnly = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: "*" },
            });

            const credentialsOnly = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: "https://app.example.com", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
            });

            expect(wildcardOnly.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(false);
            expect(credentialsOnly.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(false);
        });

        it("does not throw when vars is absent or non-string", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                vars: { LUNORA_ALLOWED_ORIGINS: 123, LUNORA_CORS_ALLOW_CREDENTIALS: true },
            });

            expect(report.errors.some((line) => line.includes("LUNORA_ALLOWED_ORIGINS"))).toBe(false);
        });

        it("reports an outdated compatibility_date", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: "2024-01-01",
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            });

            expect(report.errors.some((line) => line.includes("compatibility_date"))).toBe(true);
        });

        it("requires a DB binding when the schema has any .global() table", () => {
            expect.assertions(1);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            };

            const report = validateWranglerConfig(wrangler, { hasD1GlobalTable: true, hasHyperdriveGlobalTable: false });

            expect(report.errors.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        it("requires a matching vectorize binding for each declared vector index", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            };

            const report = validateWranglerConfig(wrangler, { hasD1GlobalTable: false, hasHyperdriveGlobalTable: false, vectorIndexNames: ["docs-body"] });

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("docs-body"))).toBe(true);
        });

        it("passes when a vectorize binding declares the index_name", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                vectorize: [{ binding: "DOCS_BODY", index_name: "docs-body" }],
            };

            const report = validateWranglerConfig(wrangler, { hasD1GlobalTable: false, hasHyperdriveGlobalTable: false, vectorIndexNames: ["docs-body"] });

            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        });

        it("accepts a well-formed tail_consumers entry", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                tail_consumers: [{ service: "log-forwarder" }],
            };

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(true);
            expect(report.errors).toEqual([]);
        });

        it("reports a tail_consumers entry missing its service", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                tail_consumers: [{ environment: "production" }],
            };

            const report = validateWranglerConfig(wrangler);

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("tail_consumers[0]"))).toBe(true);
        });

        it("validateWrangler is an alias for validateWranglerConfig", () => {
            expect.assertions(1);

            expect(validateWrangler).toBe(validateWranglerConfig);
        });

        it("treats a non-object wrangler as invalid", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(undefined);

            expect(report.valid).toBe(false);
            expect(report.errors.length).toBeGreaterThan(0);
        });
    });

    describe("validateWranglerConfig — environment-scoped (env.<name>)", () => {
        /** A top level with every binding this suite exercises, valid on its own. */
        const topLevel = (): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                d1_databases: [{ binding: "DB", database_name: "top-level-db" }],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                kv_namespaces: [{ binding: "CACHE", id: "top-level-kv-id" }],
                // migrations is INHERITABLE (see INHERITABLE_KEYS) — declared once
                // here so every env-scoped case below, none of which override it,
                // still resolves ShardDO's binding against a known class.
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                observability: { enabled: true },
                queues: { producers: [{ binding: "EMAILS", queue: "emails" }] },
                r2_buckets: [{ binding: "UPLOADS", bucket_name: "top-level-uploads" }],
                vars: { LUNORA_ENV: "shared" },
            };
        };

        it("ignores env entirely when environment is not requested (unchanged default)", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = { production: {} };

            expect(validateWranglerConfig(wrangler).valid).toBe(true);
        });

        it("errors distinctly when --env names an undeclared environment", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = { staging: {} };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("names no environment declared") && line.includes("staging"))).toBe(true);
        });

        it("errors the same way when no env block is declared at all", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(topLevel(), undefined, "production");

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("no environments are declared"))).toBe(true);
        });

        // durable_objects — NON-inheritable: a SHARD binding at the top level
        // must NOT satisfy env.production when that environment doesn't repeat
        // it — wrangler deploys env.production with no SHARD binding at all.
        it("durable_objects: a top-level-only SHARD binding fails env.production validation", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = { production: {} };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("durable_objects: passes once env.production repeats its own SHARD binding", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = { production: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } };

            expect(validateWranglerConfig(wrangler, undefined, "production").valid).toBe(true);
        });

        // d1_databases — inferred non-inheritable (see NON_INHERITABLE_KEYS doc
        // comment): a schema with a .global() table needs env.production's OWN DB
        // binding, not the top level's.
        it("d1_databases: a top-level-only DB binding fails env.production when the schema has a .global() table", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = { production: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } };

            const report = validateWranglerConfig(wrangler, { hasD1GlobalTable: true, hasHyperdriveGlobalTable: false }, "production");

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes('d1_databases must include a binding named "DB"'))).toBe(true);
        });

        it("d1_databases: passes once env.production repeats its own DB binding", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = {
                production: {
                    d1_databases: [{ binding: "DB", database_name: "prod-db" }],
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                },
            };

            expect(validateWranglerConfig(wrangler, { hasD1GlobalTable: true, hasHyperdriveGlobalTable: false }, "production").valid).toBe(true);
        });

        // kv_namespaces — NON-inheritable, hint-only (warns on a missing id,
        // doesn't error): env.production's OWN (id-less) entry must be what
        // gets validated — the top level's entry (which DOES have an id) must
        // not silently paper over it.
        it("kv_namespaces: env.production's own id-less entry warns, even though the top level's has an id", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = {
                production: {
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    kv_namespaces: [{ binding: "CACHE" }],
                },
            };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            // Still valid (kv_namespaces is a hint, not a hard error) — but the
            // warning must fire, proving the merged view used env.production's
            // id-less entry rather than the top level's complete one.
            expect(report.valid).toBe(true);
            expect(report.warnings.some((line) => line.toLowerCase().includes("kv") && line.includes("id"))).toBe(true);
        });

        // r2_buckets — NON-inheritable, self-describing (shape-only, no remote
        // id to warn about) — this asserts the merge drops the top-level entry
        // rather than that anything currently errors on a missing one.
        it("r2_buckets: env.production's merged view has no bucket when it doesn't declare one", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = { production: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } };

            // No direct assertion surface on r2_buckets in the report (shape-only,
            // self-describing) — exercised via vars below instead, which DOES
            // have an observable effect (the CORS lint).
            expect(validateWranglerConfig(wrangler, undefined, "production").valid).toBe(true);
        });

        // vars — NON-inheritable: a CORS-unsafe combination declared ONLY under
        // env.production must still be caught; the top level's (safe) vars must
        // not mask it.
        it("vars: env.production's own (unsafe) vars are validated, not the top level's (safe) ones", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = {
                production: {
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    vars: { LUNORA_ALLOWED_ORIGINS: "*", LUNORA_CORS_ALLOW_CREDENTIALS: "true" },
                },
            };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("wildcard"))).toBe(true);
        });

        it("vars: the top level's unsafe vars do NOT leak into an env.production that declares its own safe vars", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.vars = { LUNORA_ALLOWED_ORIGINS: "*", LUNORA_CORS_ALLOW_CREDENTIALS: "true" };
            wrangler.env = {
                production: {
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    vars: { LUNORA_ALLOWED_ORIGINS: "https://app.example.com" },
                },
            };

            expect(validateWranglerConfig(wrangler, undefined, "production").valid).toBe(true);
        });

        // queues — NON-inheritable: exercised for shape only (no direct error
        // surface here), asserting the merge behavior via warnings/valid stays
        // sane rather than throwing.
        it("queues: env.production without its own producers/consumers does not crash and stays valid", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = { production: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } };

            expect(validateWranglerConfig(wrangler, undefined, "production").valid).toBe(true);
        });

        // compatibility_date / observability — INHERITABLE: env.production
        // inherits the top level's value when it doesn't override it.
        it("compatibility_date: inherits the top level's value into env.production", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = { production: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } };

            // The top level's REQUIRED_COMPATIBILITY_DATE is >= the minimum, so
            // this only passes if it was actually carried over into the merged view.
            expect(validateWranglerConfig(wrangler, undefined, "production").errors.some((line) => line.includes("compatibility_date must be"))).toBe(false);
        });

        it("compatibility_date: env.production's own override is used over the top level's", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = {
                production: { compatibility_date: "2020-01-01", durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } },
            };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            expect(report.valid).toBe(false);
            expect(report.errors.some((line) => line.includes("compatibility_date must be"))).toBe(true);
        });

        it("observability: inherits the top level's enabled:true into env.production (no cache/observability error)", () => {
            expect.assertions(1);

            const wrangler = topLevel();

            wrangler.env = { production: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } } };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            expect(report.errors.some((line) => line.toLowerCase().includes("observability"))).toBe(false);
        });

        it("warns once (not per-key) when env.production overrides a key with no verified inheritance rule", () => {
            expect.assertions(2);

            const wrangler = topLevel();

            wrangler.env = {
                production: {
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    // `hyperdrive` is a real WranglerConfig key with no verified
                    // entry in either NON_INHERITABLE_KEYS or INHERITABLE_KEYS.
                    hyperdrive: [{ binding: "HYPERDRIVE", id: "env-only-id" }],
                },
            };

            const report = validateWranglerConfig(wrangler, undefined, "production");

            expect(report.warnings.some((line) => line.includes("hyperdrive") && line.includes("TOP-LEVEL value only"))).toBe(true);
            // Exactly one such warning, not one per unverified key.
            expect(report.warnings.filter((line) => line.includes("TOP-LEVEL value only"))).toHaveLength(1);
        });
    });

    describe("withTailConsumer", () => {
        it("appends a tail consumer when none is wired", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = { compatibility_date: REQUIRED_COMPATIBILITY_DATE };
            const next = withTailConsumer(wrangler, { service: "log-forwarder" });

            expect(next.tail_consumers).toEqual([{ service: "log-forwarder" }]);
            // The input is left untouched (pure).
            expect(wrangler.tail_consumers).toBeUndefined();
        });

        it("is idempotent for the same service + environment", () => {
            expect.assertions(1);

            const wrangler: WranglerConfig = { tail_consumers: [{ environment: "production", service: "log-forwarder" }] };
            const next = withTailConsumer(wrangler, { environment: "production", service: "log-forwarder" });

            expect(next).toBe(wrangler);
        });

        it("does not throw when existing tail_consumers contains a null entry", () => {
            expect.assertions(1);

            const wrangler = { tail_consumers: [null] } as unknown as WranglerConfig;
            const next = withTailConsumer(wrangler, { service: "log-forwarder" });

            expect(next.tail_consumers).toHaveLength(2);
        });

        it("adds a distinct entry when the environment differs", () => {
            expect.assertions(1);

            const wrangler: WranglerConfig = { tail_consumers: [{ environment: "production", service: "log-forwarder" }] };
            const next = withTailConsumer(wrangler, { environment: "staging", service: "log-forwarder" });

            expect(next.tail_consumers).toHaveLength(2);
        });
    });

    describe("validateWranglerProject (file-system aware)", () => {
        it("passes when wrangler.jsonc declares everything the schema implies", () => {
            expect.assertions(3);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeMainEntry();
            writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
            expect(result.report.valid).toBe(true);
            expect(result.wranglerPath).toBe(join(workdir, "wrangler.jsonc"));
        });

        describe("environment argument (env.<name>)", () => {
            // Top level declares everything (so a top-level-only validation
            // passes); env.production and env.staging each declare their OWN
            // (non-inheritable) durable_objects — staging's is deliberately
            // missing the SHARD binding to prove the merge is per-environment.
            const MULTI_ENV_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["nodejs_compat", "${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "lunora-global", "database_id": "top-level-only" }],
    "env": {
        "production": {
            "durable_objects": {
                "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
            },
            "d1_databases": [{ "binding": "DB", "database_name": "lunora-prod", "database_id": "prod-id" }]
        },
        "staging": {
            "vars": { "LUNORA_ENV": "staging" }
        }
    }
}
`;

            it("validating the top level (no --environment) still passes — unchanged default", () => {
                expect.assertions(1);

                writeSchema(SCHEMA_WITH_GLOBAL);
                writeMainEntry();
                writeFileSync(join(workdir, "wrangler.jsonc"), MULTI_ENV_WRANGLER, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.valid).toBe(true);
            });

            it("validating --env production inspects env.production's own bindings and passes", () => {
                expect.assertions(1);

                writeSchema(SCHEMA_WITH_GLOBAL);
                writeMainEntry();
                writeFileSync(join(workdir, "wrangler.jsonc"), MULTI_ENV_WRANGLER, "utf8");

                const result = validateWranglerProject({ environment: "production", projectRoot: workdir });

                expect(result.report.valid).toBe(true);
            });

            it("validating --env staging fails — a missing SHARD there errors even though the top level has one", () => {
                expect.assertions(3);

                writeSchema(SCHEMA_WITH_GLOBAL);
                writeFileSync(join(workdir, "wrangler.jsonc"), MULTI_ENV_WRANGLER, "utf8");

                const result = validateWranglerProject({ environment: "staging", projectRoot: workdir });

                expect(result.report.valid).toBe(false);
                expect(result.problems.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
                // Also missing its own DB binding (schema has a .global() table).
                expect(result.problems.some((line) => line.includes('d1_databases must include a binding named "DB"'))).toBe(true);
            });

            it("does not throw on a malformed non-array workflows/containers block", () => {
                expect.assertions(2);

                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["nodejs_compat", "${REQUIRED_FLAG}"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "workflows": {},
    "containers": {}
}
`,
                    "utf8",
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.problems.join(" ")).toContain("workflows must be an array");
                expect(result.problems.join(" ")).toContain("containers must be an array");
            });

            it("an undeclared --env errors distinctly, without running the rest of validation", () => {
                expect.assertions(3);

                writeSchema(SCHEMA_WITH_GLOBAL);
                writeFileSync(join(workdir, "wrangler.jsonc"), MULTI_ENV_WRANGLER, "utf8");

                const result = validateWranglerProject({ environment: "canary", projectRoot: workdir });

                expect(result.report.valid).toBe(false);
                expect(result.problems).toHaveLength(1);
                expect(result.problems[0]).toContain("names no environment declared");
            });
        });

        describe("a schema with vector indexes no source chains .vectors() onto", () => {
            // The generated builder throws for this from `buildWorkerOptions` — on
            // the first REQUEST. codegen, build, verify, tsc and the test suite all
            // pass on a tree where every request 500s, `/_lunora/health` included.
            const COMPOSING_SOURCE = `import { defineApp } from "../lunora/_generated/app";\n\nexport default defineApp().shard((env) => env.SHARD);\n`;

            const writeVectorProject = (entry: string, options: { entryFile?: string; main?: string } = {}): void => {
                const entryFile = options.entryFile ?? "index.ts";

                writeSchema(SCHEMA_WITH_VECTOR);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "${options.main ?? `src/${entryFile}`}",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "vectorize": [{ "binding": "DOCS_BODY", "index_name": "docs-body" }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", entryFile), entry, "utf8");
            };

            it("errors, naming the index and the chain that binds it", () => {
                expect.assertions(3);

                writeVectorProject(
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD);\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.valid).toBe(false);
                expect(result.report.errors.join("\n")).toContain("docs-body");
                expect(result.report.errors.join("\n")).toContain("nothing chains .vectors(...)");
            });

            it("passes once the chain binds them", () => {
                expect.assertions(1);

                writeVectorProject(
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD).vectors((env) => ({ "docs-body": env.DOCS_BODY }));\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });

            it("says nothing when a neighbouring module chains it — the builder returns `this`", () => {
                expect.assertions(1);

                // `configureVectors(app)` in a sibling file is a supported wiring.
                // A check that only read the entry would hard-error a correct tree
                // and tell the author to add a call they had already written.
                writeVectorProject(
                    `import { defineApp } from "../lunora/_generated/app";\nimport { configureVectors } from "./vectors";\n\nconst app = configureVectors(defineApp().shard((env) => env.SHARD));\nexport const { ShardDO } = app;\nexport default app;\n`,
                );
                writeFileSync(
                    join(workdir, "src", "vectors.ts"),
                    `export const configureVectors = (app) => app.vectors((env) => ({ "docs-body": env.DOCS_BODY }));\n`,
                    "utf8",
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });

            it("still fires when the composing file imports defineApp under an alias", () => {
                expect.assertions(1);

                // The composition marker is a parsed CALL, so it has to resolve
                // `createApp()` back to the imported `defineApp` — an ordinary
                // import style, and a silent no-op for anyone using it if the
                // callee text alone were matched.
                writeVectorProject(
                    `import { defineApp as createApp } from "../lunora/_generated/app";\n\nconst app = createApp().shard((env) => env.SHARD);\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("nothing chains .vectors(...)");
            });

            it("says nothing about a project that composes its worker elsewhere", () => {
                expect.assertions(1);

                // The worker is built in another package and re-exported here, so
                // nothing in this project's own sources names `defineApp`. The
                // check must not block what it cannot see.
                writeVectorProject(`export { default } from "@acme/worker";\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });

            it("fires when `main` names no file at all, as a Vite-first app's does", () => {
                expect.assertions(1);

                // `main: "virtual:lunora/worker"` resolves to no entry, so a check
                // keyed on the entry reported nothing at all here.
                writeVectorProject(COMPOSING_SOURCE, { entryFile: "server.ts", main: "virtual:lunora/worker" });

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("nothing chains .vectors(...)");
            });

            it("fires when the generated `src/worker.ts` only re-exports the composed app", () => {
                expect.assertions(1);

                // The class-B composed entry wins over `main`, and it composes
                // nothing itself — the app is built in `src/server.ts` next to it.
                writeVectorProject(COMPOSING_SOURCE, { entryFile: "server.ts" });
                writeFileSync(join(workdir, "src", "worker.ts"), `export { default } from "./server";\n`, "utf8");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("nothing chains .vectors(...)");
            });

            it("says nothing about a file that only mentions the factory's name", () => {
                expect.assertions(1);

                // The composition marker ARMS a deploy-blocking error, so a bare
                // substring must never be enough. Nuxt's own `defineAppConfig`
                // contains it, and two of this repo's templates name `defineApp()`
                // in prose — neither is a project anyone could edit their way out of.
                writeVectorProject(`export { default } from "@acme/worker";\n`);
                writeFileSync(join(workdir, "app.config.ts"), `export default defineAppConfig({ theme: "dark" });\n`, "utf8");
                writeFileSync(join(workdir, "src", "notes.ts"), `// The worker is composed with defineApp() over in @acme/worker.\n`, "utf8");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });

            it("still fires when only a comment or a string mentions the chain", () => {
                expect.assertions(1);

                // The file that chains `.vectors()` is the likeliest one to carry a
                // comment saying so, so "delete the call, keep the warning about
                // deleting the call" is the realistic path back to the outage — and
                // a substring match cleared the gate on exactly that tree.
                writeVectorProject(
                    `import { defineApp } from "../lunora/_generated/app";\n` +
                        `\n` +
                        `// Load-bearing: without .vectors((env) => ({ "docs-body": env.DOCS_BODY }))\n` +
                        `// every request 500s.\n` +
                        `const hint = "add .vectors(...) to the chain";\n` +
                        `const app = defineApp().shard((env) => env.SHARD);\n` +
                        `export const { ShardDO } = app;\nexport default app;\nexport { hint };\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("nothing chains .vectors(...)");
            });

            it("says nothing when the chain lives in a .server directory or a .mjs module", () => {
                expect.assertions(2);

                // Both are real layouts — `.server/` is the React Router v7 / Remix
                // convention — and a chain the scan cannot see hard-errors a project
                // that is correctly wired.
                for (const [directory, file] of [
                    [".server", "vectors.ts"],
                    ["config", "vectors.mjs"],
                ]) {
                    writeVectorProject(COMPOSING_SOURCE, { entryFile: "server.ts" });
                    mkdirSync(join(workdir, "src", String(directory)), { recursive: true });
                    writeFileSync(
                        join(workdir, "src", String(directory), String(file)),
                        `export const configureVectors = (app) => app.vectors((env) => ({ "docs-body": env.DOCS_BODY }));\n`,
                        "utf8",
                    );

                    const result = validateWranglerProject({ projectRoot: workdir });

                    expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
                }
            });

            it("says nothing when whitespace separates the chain from its parentheses", () => {
                expect.assertions(1);

                // The text prefilter only decides which files are worth parsing;
                // the parse decides the answer. An exact `.vectors(` substring made
                // the prefilter STRICTER than the parser, so a formatting variant
                // skipped the file and hard-errored a correctly wired project.
                writeVectorProject(
                    `import { defineApp } from "../lunora/_generated/app";\n` +
                        `\n` +
                        `const app = defineApp()\n    .shard((env) => env.SHARD)\n    . vectors ((env) => ({ "docs-body": env.DOCS_BODY }));\n` +
                        `export const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });
        });

        describe("a schema with .global() tables no source chains .global() onto", () => {
            // Without the chain the shard gets no D1 writer, so every read or write
            // of a global table throws INTERNAL — `lunora build`, `verify` and tsc
            // all pass first. The wrangler check next to this one proves the `DB`
            // BINDING exists, which is the half a project usually gets right.
            const writeGlobalProject = (entry: string): void => {
                writeSchema(SCHEMA_WITH_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "00000000-0000-0000-0000-000000000000" }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), entry, "utf8");
            };

            it("errors — and the schema's own `defineTable(...).global()` does not clear it", () => {
                expect.assertions(2);

                // `.global()` names two builders. The table form is what MAKES the
                // schema declare a global table, so it is present in every project
                // this check can fire on — matching it would mean the check never
                // fires at all.
                writeGlobalProject(
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD);\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.valid).toBe(false);
                expect(result.report.errors.join("\n")).toContain("nothing chains .global(...)");
            });

            it("passes once the app chains it", () => {
                expect.assertions(1);

                writeGlobalProject(
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD).global({ d1: (env) => env.DB });\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });

            it("still errors when the table builder is imported under an alias", () => {
                expect.assertions(1);

                // The table-form exclusion reads the file's LOCAL names for
                // `defineTable`, the same way the `defineApp` probe does. Keying
                // it on the bare identifier let `import { defineTable as table }`
                // hide the table form, so `table({...}).global()` counted as the
                // APP chaining `.global(...)` and the gate cleared on the schema
                // itself — silence for a shard with no global writer.
                writeGlobalProject(
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD);\nexport const { ShardDO } = app;\nexport default app;\n`,
                );
                writeSchema(
                    `import { defineSchema, defineTable as table, v } from "@lunora/server";\n\nexport const schema = defineSchema({\n    users: table({ email: v.string() }).global(),\n});\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("nothing chains .global(...)");
            });
        });

        describe("a schema whose .global() tables are Hyperdrive-backed", () => {
            // `.global({ backend: "hyperdrive" })` lives on Postgres/MySQL behind a
            // Hyperdrive binding: no D1 database, and a DIFFERENT builder method.
            // Reading "declares a global table" as "needs D1" demanded a `DB`
            // binding of a project that has none.
            const HYPERDRIVE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
    }).global({ backend: "hyperdrive" }),
});
`;

            const writeHyperdriveProject = (entry: string, { binding = true }: { binding?: boolean } = {}): void => {
                writeSchema(HYPERDRIVE_SCHEMA);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]${binding ? ',\n    "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "hd_123" }]' : ""}
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), entry, "utf8");
            };

            it("demands the .hyperdriveGlobal(...) chain, not a D1 binding or .global(...)", () => {
                expect.assertions(5);

                writeHyperdriveProject(
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD);\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });
                const errors = result.report.errors.join("\n");

                expect(errors).toContain("nothing chains .hyperdriveGlobal(...)");
                expect(errors).not.toContain('d1_databases must include a binding named "DB"');
                expect(errors).not.toContain("nothing chains .global(...)");
                // The suggested fix has to match `HyperdriveGlobalDeclaration`
                // (`engine` + `exec`). The D1 line's `d1: (env) => env.DB` shape
                // does not exist on this builder, and a blocking error whose fix
                // does not compile costs the round trip it exists to save.
                expect(errors).toContain('.hyperdriveGlobal({ engine: "postgres", exec:');
                expect(errors).not.toContain("hyperdrive: (env) => env.HYPERDRIVE");
            });

            it("passes once the app chains .hyperdriveGlobal(...)", () => {
                expect.assertions(1);

                writeHyperdriveProject(
                    // The real `HyperdriveGlobalDeclaration` shape (`engine` +
                    // `exec`), not a `hyperdrive:` selector — detection only
                    // reads the method name, so a wrong fixture would pass while
                    // pinning a remediation string that does not compile.
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD).hyperdriveGlobal({ engine: "postgres", exec: (env) => buildPgExec(env.HYPERDRIVE) });\nexport const { ShardDO } = app;\nexport default app;\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("nothing chains"))).toEqual([]);
            });

            it("demands SOME hyperdrive binding, without naming which", () => {
                expect.assertions(3);

                // Dropping the `DB` demand for these tables left them with no
                // wrangler-level check at all: the chain is present, every gate
                // passes, and `env.<BINDING>` is `undefined` at the first global
                // read — inside the user's own `exec`, where nothing here can say
                // what went wrong.
                //
                // Unlike D1 the name is not fixed: `.hyperdriveGlobal({ exec })`
                // builds the driver from the user's selector, so naming one would
                // false-error a project that called its binding something else.
                const CHAIN = `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD).hyperdriveGlobal({ engine: "postgres", exec: (env) => buildPgExec(env.PG) });\nexport const { ShardDO } = app;\nexport default app;\n`;

                writeHyperdriveProject(CHAIN, { binding: false });

                const missing = validateWranglerProject({ projectRoot: workdir });

                expect(missing.report.valid).toBe(false);
                expect(missing.report.errors.join("\n")).toContain("wrangler must declare a hyperdrive binding");

                // A differently-named binding satisfies it; only absence is the defect.
                writeHyperdriveProject(CHAIN);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "hyperdrive": [{ "binding": "PG", "id": "hd_123" }]
}
`,
                    "utf8",
                );

                const named = validateWranglerProject({ projectRoot: workdir });

                expect(named.report.errors.join("\n")).not.toContain("wrangler must declare a hyperdrive binding");
            });

            it("says nothing about a hyperdrive binding for a D1-backed global schema", () => {
                expect.assertions(1);

                // The mirror of the D1 check's own scoping: a `.global()` table on
                // D1 needs no Hyperdrive binding, and demanding one would block the
                // common case.
                writeSchema(SCHEMA_WITH_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "00000000-0000-0000-0000-000000000000" }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(
                    join(workdir, "src", "index.ts"),
                    `import { defineApp } from "../lunora/_generated/app";\n\nconst app = defineApp().shard((env) => env.SHARD).global({ d1: (env) => env.DB });\nexport const { ShardDO } = app;\nexport default app;\n`,
                    "utf8",
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).not.toContain("wrangler must declare a hyperdrive binding");
            });
        });

        describe("main naming a file that does not exist", () => {
            const writeMain = (main: string): void => {
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "${main}",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`,
                    "utf8",
                );
            };

            it("warns on a TypeScript main that is absent — wrangler cannot resolve it", () => {
                expect.assertions(2);

                // Renaming the entry and forgetting `main` deploys nothing while
                // `verify` calls the project valid. A warning rather than an
                // error: a tree passes THROUGH this state, and `@lunora/vite`
                // throws on an error here.
                writeMain("src/serverr.ts");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.join("\n")).toContain("main is set but no readable file is there");
                expect(result.report.errors.filter((error) => error.includes("no readable file"))).toEqual([]);
            });

            it("does not divert the export cross-check onto a fallback when main is absent", () => {
                expect.assertions(2);

                // The warning above exists BECAUSE this must not happen: probing
                // the conventional locations for a mistyped `main` read an
                // unrelated `src/index.ts` as the worker and reported its
                // declared classes missing — a hard error, on a tree one
                // keystroke from correct.
                writeMain("src/serverr.ts");
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), `export const unrelated = 1;\n`, "utf8");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors).toEqual([]);
                expect(result.report.valid).toBe(true);
            });

            it("says nothing about an adapter build output that has not been built yet", () => {
                expect.assertions(1);

                // `templates/sveltekit` points `main` at the adapter's output,
                // which only exists after a build. Warning on that would nag
                // every correct project before its first build — and the path is
                // build output either way, so there is no missing file to report.
                writeMain(".svelte-kit/cloudflare/_worker.js");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.filter((warning) => warning.includes("no readable file"))).toEqual([]);
            });

            it("says nothing about the class-A virtual specifier, which names no file", () => {
                expect.assertions(1);

                writeMain("virtual:lunora/worker");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.filter((warning) => warning.includes("no readable file"))).toEqual([]);
            });
        });

        describe("durable object / workflow classes the entry does not export", () => {
            // `.scheduler()` / `.workflow()` write the binding and the migration
            // entry but cannot add the `export { SchedulerDO }` the entry needs,
            // so the wiring is half done and wrangler refuses to bundle:
            // "Your Worker depends on the following Durable Objects, which are
            // not exported in your entrypoint file". `verify` and `doctor` both
            // reported a clean tree in the meantime.
            const writeWrangler = (extra: string): void => {
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }${extra}] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
            };

            const writeEntry = (source: string): void => {
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), source, "utf8");
            };

            it("errors when a declared class is not exported by the entry", () => {
                expect.assertions(3);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./lunora/_generated/shard";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                // An ERROR: `verify` used to exit 0 on a tree `lunora build`
                // rejects, so a PR check went green and the deploy job failed.
                expect(result.report.valid).toBe(false);
                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
                expect(result.report.errors.join("\n")).toContain("does not export it");
            });

            it("passes once the class is exported", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(
                    `export { ShardDO } from "./lunora/_generated/shard";\nexport { SchedulerDO } from "@lunora/scheduler";\nexport default { fetch() {} };\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("treats a type-only export as unexported — it compiles away", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport type { SchedulerDO } from "@lunora/scheduler";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("does not accept a commented-out export, or the class named in prose", () => {
                expect.assertions(1);

                // A worker entry that discusses its Durable Objects in comments is
                // the normal case, so a scan that counts them would silently pass
                // on exactly the tree this check exists to catch.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(
                    `export { ShardDO } from "./shard";\n` +
                        `// export { SchedulerDO } from "@lunora/scheduler";\n` +
                        `/** The SchedulerDO dispatches HTTP callbacks back to this origin. */\n` +
                        `export default { fetch() {} };\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("accepts a multi-line export list — the way prettier formats three or more", () => {
                expect.assertions(1);

                // A proximity regex bounded at the newline read this as "not
                // exported", so a correctly-wired project got a hard error from
                // prepare/verify/deploy and `lunora dev` refused to start. It
                // fails CLOSED, which is the worst direction for this check.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export {\n    ShardDO,\n    SchedulerDO,\n} from "./lunora/_generated/shard";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("does not let a type-only re-export elsewhere suppress a real value export", () => {
                expect.assertions(1);

                // The type check used to be whole-file, so an unrelated
                // `export type { SchedulerDO as … }` poisoned the real export.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(
                    `export { ShardDO } from "./shard";\n` +
                        `export type { SchedulerDO as SchedulerDOType } from "./types";\n` +
                        `export { SchedulerDO } from "./scheduler";\n` +
                        `export default { fetch() {} };\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("resolves `export { Local as Bound }` by the EXPORTED name, which is what wrangler binds", () => {
                expect.assertions(2);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport { InternalScheduler as SchedulerDO } from "./s";\nexport default { fetch() {} };\n`);

                const accepted = validateWranglerProject({ projectRoot: workdir });

                expect(accepted.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);

                // The LOCAL name is not what is bound, so aliasing it away is a miss.
                writeEntry(`export { ShardDO } from "./shard";\nexport { SchedulerDO as SomethingElse } from "./s";\nexport default { fetch() {} };\n`);

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("stays silent when the entry has a star re-export", () => {
                expect.assertions(1);

                // A star re-export forwards names no per-name scan can see, so
                // absence proves nothing. A false error here would block a
                // deploy that works — worse than missing one.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./lunora/_generated/workflows";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("accepts the app builder's own `export const { ShardDO } = app`", () => {
                expect.assertions(1);

                // The check now BLOCKS, so every form a real entry uses has to
                // be understood. This one is generated, not hand-written.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`const app = createApp();\nexport const { SchedulerDO, ShardDO } = app;\nexport default app;\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("accepts a class declared and exported in the entry itself", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport class SchedulerDO extends Base {}\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("does not accept `export default class SchedulerDO` — that binds `default`", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport default class SchedulerDO extends Base {}\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("does not treat `export * as ns from` as opaque — it binds only `ns`", () => {
                expect.assertions(1);

                // Unlike a bare star re-export, a namespace re-export forwards
                // no top-level name, so absence is still a fact.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport * as scheduler from "./scheduler";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("is not switched off by an `export {}` — only a star re-export is opaque", () => {
                expect.assertions(1);

                // `export {}` lists no names, exactly like `export * from`, but it
                // forwards nothing and is a routine way to mark a file as a
                // module. Treating it as opaque turned the whole check off and
                // read as a pass — worse than the bug the check exists to catch.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export {};\nexport { ShardDO } from "./shard";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("does not count a locally declared class that an export clause aliases away", () => {
                expect.assertions(1);

                // ts-morph answers `isExported()` true for a class named by ANY
                // export clause, alias and all — so this read as exporting
                // `SchedulerDO`, the one name wrangler does not bind.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nclass SchedulerDO {}\nexport { SchedulerDO as SomethingElse };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("reports nothing when the entry does not parse — a blocking check must be sure", () => {
                expect.assertions(2);

                // ts-morph error-RECOVERS instead of throwing, and a recovered
                // parse drops statements. Blocking on a half-typed file would
                // stop `lunora dev` mid-keystroke.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport const broken = (\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
                expect(result.report.valid).toBe(true);
            });

            it("does not judge a built worker artifact named by main", () => {
                expect.assertions(1);

                // A class-B `main` can name the framework adapter's build output,
                // which exports only the SSR fetch handler — every declared class
                // reads as unexported there.
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "dist/_worker.js",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "dist"), { recursive: true });
                writeFileSync(join(workdir, "dist", "_worker.js"), `export default { fetch() {} };\n`, "utf8");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("follows a bare star re-export into a relative module", () => {
                expect.assertions(2);

                // A bare star used to read as opaque and switch the whole check
                // off — and a barrel entry is an ordinary shape, so a project
                // written that way had no cross-check at all.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./durable-objects";\nexport default { fetch() {} };\n`);
                writeFileSync(join(workdir, "src", "durable-objects.ts"), `export class ShardDO {}\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");

                writeFileSync(join(workdir, "src", "durable-objects.ts"), `export class ShardDO {}\nexport class SchedulerDO {}\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("follows the `.js` specifier codegen itself tells the entry to write", () => {
                expect.assertions(1);

                // `@lunora/codegen` emits `export * from "./lunora/_generated/workflows.js"`
                // as the instruction to copy, and that specifier names a `.ts`
                // file. Not mapping the extension left the commonest star in a
                // Lunora entry unresolvable, which reads as opaque.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./generated/classes.js";\nexport default { fetch() {} };\n`);
                mkdirSync(join(workdir, "src", "generated"), { recursive: true });
                writeFileSync(join(workdir, "src", "generated", "classes.ts"), `export class ShardDO {}\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("resolves a star re-export of a directory through its index file", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./objects";\nexport default { fetch() {} };\n`);
                mkdirSync(join(workdir, "src", "objects"), { recursive: true });
                writeFileSync(join(workdir, "src", "objects", "index.ts"), `export class ShardDO {}\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("stays silent when a star re-export names a bare specifier", () => {
                expect.assertions(1);

                // `export * from "@lunora/scheduler"` (or a `~/…` alias) names a
                // module whose location this check does not know, so the absence
                // of a class name proves nothing. A false error here blocks a
                // deploy that works.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "@lunora/scheduler";\nexport { ShardDO } from "./shard";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("stays silent when a followed module does not parse", () => {
                expect.assertions(2);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./durable-objects";\nexport default { fetch() {} };\n`);
                writeFileSync(join(workdir, "src", "durable-objects.ts"), `export class ShardDO {\n`, "utf8");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
                expect(result.report.valid).toBe(true);
            });

            it("still decides a barrel chain far longer than a real project's", () => {
                expect.assertions(1);

                // The ceiling was 24, which a barrel-heavy tree reaches — and
                // reaching it turns the check off with no signal, including for
                // classes the entry declares inline. 40 modules deep is already
                // unrealistic and must still decide.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./m0";\nexport class ShardDO {}\nexport default { fetch() {} };\n`);

                for (let index = 0; index < 40; index += 1) {
                    const next = index === 39 ? "" : `export * from "./m${String(index + 1)}";\n`;

                    writeFileSync(join(workdir, "src", `m${String(index)}.ts`), next, "utf8");
                }

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("terminates on a star re-export cycle instead of hanging", () => {
                expect.assertions(1);

                // `a` stars `b` stars `a` is legal and forwards no new names.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./a";\nexport default { fetch() {} };\n`);
                writeFileSync(join(workdir, "src", "a.ts"), `export * from "./b";\nexport class ShardDO {}\n`, "utf8");
                writeFileSync(join(workdir, "src", "b.ts"), `export * from "./a";\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("honours a `./`-prefixed main instead of reading it as build output", () => {
                expect.assertions(2);

                // `"./src/entry.ts"` is idiomatic and wrangler accepts it. The
                // build-output gate split on separators and tested every segment
                // for a leading dot, so `.` matched — the DECLARED entry was
                // discarded and whichever fallback existed got judged in its place,
                // blocking the deploy while naming the wrong file.
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "./src/entry.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "entry.ts"), `export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`, "utf8");
                // A sibling that WOULD be probed, and would answer differently.
                writeFileSync(join(workdir, "src", "index.ts"), `export const clientEntry = 1;\nexport default { fetch() {} };\n`, "utf8");

                const reported = validateWranglerProject({ projectRoot: workdir })
                    .report.errors.filter((error) => error.includes("does not export it"))
                    .join("\n");

                // Judged against the declared entry: it really is missing SchedulerDO…
                expect(reported).toContain("src/entry.ts");
                // …and never against the file the probe would have found.
                expect(reported).not.toContain("src/index.ts");
            });

            it("reads a hand-written JS main rather than diverting off it", () => {
                expect.assertions(2);

                // `WORKER_ENTRY_SOURCE_EXTENSIONS` excludes JS because a bundled
                // `_worker.js` exports only the SSR handler — but `src/worker.js`
                // is an ordinary authored entry (`parseSource` sets `allowJs`).
                // Treating "not TypeScript" as "unreadable" probed the fallbacks
                // and reported this project's correctly exported ShardDO missing.
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/worker.js",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), `export const unrelated = 1;\n`, "utf8");
                writeFileSync(join(workdir, "src", "worker.js"), `export class ShardDO {}\nexport default { fetch() {} };\n`, "utf8");

                const missing = validateWranglerProject({ projectRoot: workdir });

                // The JS entry itself is judged: it really is missing SchedulerDO,
                // and the message names `src/worker.js`, not the fallback.
                expect(missing.report.errors.join("\n")).toContain("src/worker.js");

                writeFileSync(
                    join(workdir, "src", "worker.js"),
                    `export class ShardDO {}\nexport class SchedulerDO {}\nexport default { fetch() {} };\n`,
                    "utf8",
                );

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("does not judge a probed entry that exports no default — it is not a worker", () => {
                expect.assertions(2);

                // A probe is a GUESS. `src/index.ts` is the client entry in a
                // class-A app and an ordinary barrel in plenty of others, and
                // reading one as the worker hard-errored correct projects. A
                // Cloudflare module worker must export `default`, so that is the
                // discriminator.
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "dist/_worker.js",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "index.ts"), `export { App } from "./app";\n`, "utf8");

                const barrel = validateWranglerProject({ projectRoot: workdir });

                expect(barrel.report.errors).toEqual([]);

                // The same probe, on a file that IS a worker, is judged.
                writeFileSync(join(workdir, "src", "index.ts"), `export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("resolves a dotted filename rather than stripping the suffix as an extension", () => {
                expect.assertions(2);

                // `./do.server` is the React Router / Remix convention. Treating
                // `.server` as an extension hid the real `do.server.ts` AND
                // probed a `do/index.ts` sibling in its place — reporting a
                // correctly wired project broken, or reading the wrong module.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./do.server";\nexport default { fetch() {} };\n`);
                writeFileSync(join(workdir, "src", "do.server.ts"), `export class ShardDO {}\nexport class SchedulerDO {}\n`, "utf8");
                mkdirSync(join(workdir, "src", "do"), { recursive: true });
                writeFileSync(join(workdir, "src", "do", "index.ts"), `export const unrelated = 1;\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);

                // And the real file is what decides a genuine miss.
                writeFileSync(join(workdir, "src", "do.server.ts"), `export class ShardDO {}\n`, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
            });

            it("cross-checks the authored entry when main names the adapter build output", () => {
                expect.assertions(2);

                // The build output is not lexed (above), but giving up there
                // switched the check off for every class-B layout whose `main`
                // is adapter-owned and whose composition lives in a sibling
                // source file — `verify` passed a tree `wrangler` rejects.
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "dist/_worker.js",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "dist"), { recursive: true });
                writeFileSync(join(workdir, "dist", "_worker.js"), `export default { fetch() {} };\n`, "utf8");
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "server.ts"), `export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`, "utf8");

                const missing = validateWranglerProject({ projectRoot: workdir });

                expect(missing.report.errors.join("\n")).toContain("SchedulerDO");

                writeFileSync(
                    join(workdir, "src", "server.ts"),
                    `export { ShardDO } from "./shard";\nexport { SchedulerDO } from "@lunora/scheduler";\nexport default { fetch() {} };\n`,
                    "utf8",
                );

                expect(validateWranglerProject({ projectRoot: workdir }).report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
            });

            it("cross-checks src/server.ts when wrangler declares no main", () => {
                expect.assertions(1);

                // `@cloudflare/vite-plugin` supplies the entry, so a class-B
                // project can legitimately ship no `main` — and `src/server.ts`
                // was missing from the fallback probe, which is where the astro /
                // solid-v2 / standalone templates compose.
                writeSchema(SCHEMA_NO_GLOBAL);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }, { "name": "SCHEDULER", "class_name": "SchedulerDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                    "utf8",
                );
                mkdirSync(join(workdir, "src"), { recursive: true });
                writeFileSync(join(workdir, "src", "server.ts"), `export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`, "utf8");

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.join("\n")).toContain("SchedulerDO");
            });

            describe("the class-A composed entry (main: virtual:lunora/worker)", () => {
                // `@lunora/vite` GENERATES this entry, so there is no file to add
                // a re-export to — which is exactly why the finding matters here:
                // the user cannot wire their way out of it, and `verify` used to
                // report nothing at all because the entry names no file to read.
                const writeClassAProject = (extra: string): void => {
                    writeSchema(SCHEMA_NO_GLOBAL);
                    writeFileSync(
                        join(workdir, "wrangler.jsonc"),
                        `{
    "name": "x",
    "main": "virtual:lunora/worker",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }${extra}] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "SchedulerDO"] }]
}
`,
                        "utf8",
                    );
                };

                it("reports a class the composed entry cannot export, with the class-A remedy", () => {
                    expect.assertions(3);

                    // `SessionDO`, not `SchedulerDO`: declaring the scheduler
                    // binding is now what makes the composed entry re-export it,
                    // so it can no longer reach this error. Auth's Durable Object
                    // still has no route on class-A.
                    writeClassAProject(`, { "name": "SESSION", "class_name": "SessionDO" }`);
                    mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });

                    const result = validateWranglerProject({ projectRoot: workdir });
                    const reported = result.report.errors.filter((error) => error.includes("does not export it")).join("\n");

                    expect(result.report.valid).toBe(false);
                    expect(reported).toContain("SessionDO");
                    // "Re-export it from the module that defines it" is unactionable
                    // advice for a generated entry, so the remedy must NOT be the
                    // authored one. Asserted on the instruction, not the prose.
                    expect(reported).not.toContain("export { SessionDO } from");
                });

                it("accepts a class the composed entry star-re-exports from a generated module", () => {
                    expect.assertions(1);

                    // The composed entry carries `export * from "…/_generated/agents"`
                    // for every generated class kind the project declares, and a
                    // voice agent's `VoiceSessionDO` subclass is a real Durable
                    // Object that needs its own binding.
                    writeClassAProject(`, { "name": "SUPPORT_VOICE", "class_name": "SupportVoiceDO" }`);
                    mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });
                    writeFileSync(join(workdir, "lunora", "_generated", "agents.ts"), `export class SupportAgent {}\nexport class SupportVoiceDO {}\n`, "utf8");

                    const result = validateWranglerProject({ projectRoot: workdir });

                    expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
                });

                it("counts SchedulerDO as exported once codegen has written the scheduler module", () => {
                    expect.assertions(2);

                    // `@lunora/vite` star-re-exports every `_generated/` class
                    // module that exists, so the presence of `scheduler.ts` IS the
                    // fact — and codegen writes it off the same `hasScheduler`
                    // that decides whether the builder has a `.scheduler()` method
                    // at all. Keying this on the wrangler binding instead made the
                    // plugin and the validator disagree under `--env`, and let a
                    // binding-only project compose a call onto a builder without
                    // the method.
                    writeClassAProject(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                    mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });
                    writeFileSync(join(workdir, "lunora", "_generated", "scheduler.ts"), `export { SchedulerDO } from "@lunora/scheduler";\n`, "utf8");

                    expect(validateWranglerProject({ projectRoot: workdir }).report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);

                    // Without that module the class is genuinely not exported.
                    rmSync(join(workdir, "lunora", "_generated", "scheduler.ts"));

                    expect(validateWranglerProject({ projectRoot: workdir }).report.errors.join("\n")).toContain("SchedulerDO");
                });

                it("does not tell a framework Durable Object to declare itself as an agent or container", () => {
                    expect.assertions(3);

                    // A framework class is not a `defineAgent` /
                    // `defineContainer` / `defineWorkflow` declaration, so
                    // "declare it in one of those" was hours of dead end: codegen
                    // will never emit it.
                    writeClassAProject(`, { "name": "SESSION", "class_name": "SessionDO" }`);
                    mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });

                    const reported = validateWranglerProject({ projectRoot: workdir })
                        .report.errors.filter((error) => error.includes("does not export it"))
                        .join("\n");

                    expect(reported).toContain("SessionDO");
                    expect(reported).not.toContain("re-run `lunora codegen`");
                    // The only two real routes: drop it, or own the entry.
                    expect(reported).toContain("src/worker.ts");
                });

                it("still points a project's OWN class at the declaration codegen emits it from", () => {
                    expect.assertions(2);

                    writeClassAProject(`, { "name": "TRANSCODER", "class_name": "TranscoderContainer" }`);
                    mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });

                    const reported = validateWranglerProject({ projectRoot: workdir })
                        .report.errors.filter((error) => error.includes("does not export it"))
                        .join("\n");

                    expect(reported).toContain("TranscoderContainer");
                    expect(reported).toContain("re-run `lunora codegen`");
                });

                it("stays silent before codegen has run — no _generated/ is not a fact about the entry", () => {
                    expect.assertions(1);

                    writeClassAProject(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);

                    const result = validateWranglerProject({ projectRoot: workdir });

                    expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
                });

                it("does not probe the entry fallbacks — src/index.ts is the CLIENT entry in a class-A app", () => {
                    expect.assertions(1);

                    writeClassAProject(``);
                    mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });
                    mkdirSync(join(workdir, "src"), { recursive: true });
                    // A class-A client entry exports no Durable Object at all;
                    // reading it as the worker would report `ShardDO` missing.
                    writeFileSync(join(workdir, "src", "index.ts"), `import "./app";\n`, "utf8");

                    const result = validateWranglerProject({ projectRoot: workdir });

                    expect(result.report.errors.filter((error) => error.includes("does not export it"))).toEqual([]);
                });
            });

            it("calls a workflows[] class a Workflow, not a Durable Object", () => {
                expect.assertions(2);

                // The check covers `workflows[]` too, and the shared wording sent
                // readers looking for a `migrations` entry that does not apply to
                // a WorkflowEntrypoint.
                writeWrangler(``);
                writeEntry(`export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`);
                writeFileSync(
                    join(workdir, "wrangler.jsonc"),
                    `{
    "name": "x",
    "main": "src/index.ts",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "workflows": [{ "name": "orders", "binding": "ORDERS", "class_name": "OrderPipelineWorkflow" }]
}
`,
                    "utf8",
                );

                const reported = validateWranglerProject({ projectRoot: workdir })
                    .report.errors.filter((error) => error.includes("does not export it"))
                    .join("\n");

                expect(reported).toContain("whose Workflow classes are not exported");
                expect(reported).not.toContain("whose Durable Object classes");
            });

            it("ignores a binding whose class lives in another script", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "OTHER", "class_name": "RemoteDO", "script_name": "other-worker" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.errors.filter((error) => error.includes("RemoteDO"))).toEqual([]);
            });
        });

        it("returns a problem when wrangler.jsonc is missing entirely", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.join("\n")).toMatch(WRANGLER_NOT_FOUND_RE);
            expect(result.wranglerPath).toBeUndefined();
        });

        it("warns (never errors) when assets.directory does not exist yet", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "assets": { "directory": "./dist/client", "binding": "ASSETS" }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.valid).toBe(true);
            expect(result.report.warnings.join(" ")).toMatch(/assets\.directory.*does not exist yet/u);
        });

        it("does not warn about assets.directory once the directory exists", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            mkdirSync(join(workdir, "dist", "client"), { recursive: true });
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "assets": { "directory": "./dist/client", "binding": "ASSETS" }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.warnings.join(" ")).not.toMatch(/assets\.directory/u);
        });

        it("does not require D1 when no table is global", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
        });

        it("supports jsonc comments and trailing commas", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `// my wrangler config
{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }],
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
        });

        it("returns a problem when SHARD durable-object binding is missing", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => SHARD_BINDING_ERROR_RE.test(line))).toBe(true);
        });

        it("flags a declared .vectorize() index with no matching vectorize binding", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_VECTOR);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => line.includes("docs-body"))).toBe(true);
        });

        it("passes when wrangler declares the vectorize binding for the schema's index", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_VECTOR);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "vectorize": [{ "binding": "DOCS_BODY", "index_name": "docs-body" }]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems).toEqual([]);
        });

        it("reports a malformed compatibility_date from disk", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "2026-4-7",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.valid).toBe(false);
            expect(result.problems.some((line) => line.includes("YYYY-MM-DD"))).toBe(true);
        });

        it("reports a JSONC syntax error as an unparseable config", () => {
            expect.assertions(2);

            writeSchema(SCHEMA_NO_GLOBAL);
            writeFileSync(join(workdir, "wrangler.jsonc"), `{ "name": "x", `, "utf8");

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.report.valid).toBe(false);
            expect(result.problems.some((line) => /failed to parse .* as JSONC/u.test(line))).toBe(true);
        });

        it("returns a problem when schema has .global() tables but D1 binding is missing", () => {
            expect.assertions(1);

            writeSchema(SCHEMA_WITH_GLOBAL);
            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "compatibility_flags": ["${REQUIRED_FLAG}"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        it("reports a local container image whose Dockerfile does not exist", () => {
            expect.assertions(1);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                `{
    "name": "x",
    "compatibility_date": "${REQUIRED_COMPATIBILITY_DATE}",
    "observability": { "enabled": true },
    "durable_objects": {
        "bindings": [
            { "name": "SHARD", "class_name": "ShardDO" },
            { "name": "CONTAINER_TRANSCODER", "class_name": "TranscoderContainer" }
        ]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO", "TranscoderContainer"] }],
    "containers": [{ "class_name": "TranscoderContainer", "image": "./containers/transcoder/Dockerfile", "max_instances": 2 }]
}
`,
                "utf8",
            );

            const result = validateWranglerProject({ projectRoot: workdir });

            expect(result.problems.some((line) => line.includes("does not exist"))).toBe(true);
        });
    });

    describe("containers", () => {
        const baseConfig = (overrides: Partial<WranglerConfig>): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                containers: [{ class_name: "TranscoderContainer", image: "./containers/transcoder/Dockerfile", max_instances: 2 }],
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "TranscoderContainer", name: "CONTAINER_TRANSCODER" },
                    ],
                },
                migrations: [{ new_sqlite_classes: ["ShardDO", "TranscoderContainer"] }],
                observability: { enabled: true },
                ...overrides,
            };
        };

        it("accepts a fully wired container", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(baseConfig({}));

            expect(report.errors).toEqual([]);
            expect(report.warnings).toEqual([]);
        });

        it("requires a matching durable_objects binding", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] } }));

            expect(report.errors.join(" ")).toContain("no matching durable_objects binding");
        });

        it("requires the class in new_sqlite_classes and flags new_classes", () => {
            expect.assertions(2);

            const missing = validateWranglerConfig(baseConfig({ migrations: [{ new_sqlite_classes: ["ShardDO"] }] }));

            expect(missing.errors.join(" ")).toContain("missing from migrations");

            const wrongKind = validateWranglerConfig(baseConfig({ migrations: [{ new_classes: ["TranscoderContainer"], new_sqlite_classes: ["ShardDO"] }] }));

            expect(wrongKind.errors.join(" ")).toContain('move it to "new_sqlite_classes"');
        });

        it("rejects an unknown named instance type and out-of-bounds custom values", () => {
            expect.assertions(2);

            const unknownName = validateWranglerConfig(
                baseConfig({
                    containers: [{ class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: "mega", max_instances: 1 }],
                }),
            );

            expect(unknownName.errors.join(" ")).toContain('unknown instance_type "mega"');

            const outOfBounds = validateWranglerConfig(
                baseConfig({
                    containers: [{ class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: { vcpu: 8 }, max_instances: 1 }],
                }),
            );

            expect(outOfBounds.errors.join(" ")).toContain("vcpu must be a positive number");
        });

        it("rejects custom instance types that violate the memory/vcpu and disk/memory ratios", () => {
            expect.assertions(4);

            const tooLittleMemory = validateWranglerConfig(
                baseConfig({
                    containers: [
                        { class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: { memory_mib: 4096, vcpu: 4 }, max_instances: 1 },
                    ],
                }),
            );

            expect(tooLittleMemory.errors.join(" ")).toContain("≥ 3 GiB");

            const tooMuchDisk = validateWranglerConfig(
                baseConfig({
                    containers: [
                        { class_name: "TranscoderContainer", image: "./x/Dockerfile", instance_type: { disk_mb: 20_000, memory_mib: 4096 }, max_instances: 1 },
                    ],
                }),
            );

            expect(tooMuchDisk.errors.join(" ")).toContain("≤ 2 GB disk");

            const valid = validateWranglerConfig(
                baseConfig({
                    containers: [
                        {
                            class_name: "TranscoderContainer",
                            image: "./x/Dockerfile",
                            instance_type: { disk_mb: 8000, memory_mib: 8192, vcpu: 2 },
                            max_instances: 1,
                        },
                    ],
                }),
            );

            expect(valid.errors).toEqual([]);
            expect(valid.warnings).toEqual([]);
        });

        it("warns on a missing max_instances cap and disabled observability", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(
                baseConfig({
                    containers: [{ class_name: "TranscoderContainer", image: "./x/Dockerfile" }],
                    observability: { enabled: false },
                }),
            );

            expect(report.warnings.join(" ")).toContain("no max_instances");
            expect(report.warnings.join(" ")).toContain("observability is not enabled");
        });

        it("rejects a malformed entry without a class_name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ containers: [{ image: "./x/Dockerfile" }] }));

            expect(report.errors.join(" ")).toContain('non-empty "class_name"');
        });
    });

    describe("workflows", () => {
        const baseConfig = (overrides: Partial<WranglerConfig>): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", class_name: "OrderPipelineWorkflow", name: "order-pipeline" }],
                ...overrides,
            };
        };

        it("accepts a well-formed workflows entry — no DO binding or migration required", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(baseConfig({}));

            expect(report.errors).toEqual([]);
            expect(report.warnings).toEqual([]);
        });

        it("rejects workflows that is not an array", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: {} as never }));

            expect(report.errors.join(" ")).toContain("workflows must be an array");
        });

        it("rejects an entry missing a binding", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [{ class_name: "OrderPipelineWorkflow", name: "order-pipeline" }] }));

            expect(report.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("rejects an entry missing a class_name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", name: "order-pipeline" }] }));

            expect(report.errors.join(" ")).toContain('must have a non-empty "class_name"');
        });

        it("rejects an entry missing a name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [{ binding: "WORKFLOW_ORDER_PIPELINE", class_name: "OrderPipelineWorkflow" }] }));

            expect(report.errors.join(" ")).toContain('must have a non-empty "name"');
        });

        it("rejects a non-object entry", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(baseConfig({ workflows: [null] as never }));

            expect(report.errors.join(" ")).toContain("must be a { name, binding, class_name } object");
        });
    });

    // Cloudflare-coverage bindings + config flags (plans 027-043). A minimal
    // valid base (SHARD binding + compat date) keeps each case focused on the
    // new key under test — only its own error/warning should appear.
    describe("cloudflare-coverage bindings", () => {
        const validBase = (overrides: Partial<WranglerConfig>): WranglerConfig => {
            return {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                ...overrides,
            };
        };

        it("accepts a well-formed kv_namespaces binding; warns on a missing id; errors on a missing binding", () => {
            expect.assertions(4);

            const valid = validateWranglerConfig(validBase({ kv_namespaces: [{ binding: "CACHE", id: "abc123" }] }));

            expect(valid.valid).toBe(true);

            const missingId = validateWranglerConfig(validBase({ kv_namespaces: [{ binding: "CACHE" }] }));

            expect(missingId.valid).toBe(true);
            expect(missingId.warnings.join(" ")).toMatch(/wrangler kv namespace create/u);

            const missingBinding = validateWranglerConfig(validBase({ kv_namespaces: [{ id: "abc123" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed flagship binding; warns on a missing app_id; errors on a missing binding", () => {
            expect.assertions(4);

            const valid = validateWranglerConfig(validBase({ flagship: [{ app_id: "app-abc", binding: "FLAGS" }] }));

            expect(valid.valid).toBe(true);

            const missingAppId = validateWranglerConfig(validBase({ flagship: [{ binding: "FLAGS" }] }));

            expect(missingAppId.valid).toBe(true);
            expect(missingAppId.warnings.join(" ")).toMatch(/has no "app_id"/u);

            const missingBinding = validateWranglerConfig(validBase({ flagship: [{ app_id: "app-abc" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed hyperdrive binding; warns on a missing id; errors on a missing binding", () => {
            expect.assertions(3);

            const valid = validateWranglerConfig(validBase({ hyperdrive: [{ binding: "HYPERDRIVE", id: "hd_123" }] }));

            expect(valid.valid).toBe(true);

            const missingId = validateWranglerConfig(validBase({ hyperdrive: [{ binding: "HYPERDRIVE" }] }));

            expect(missingId.warnings.join(" ")).toMatch(/wrangler hyperdrive create/u);

            const missingBinding = validateWranglerConfig(validBase({ hyperdrive: [{ id: "hd_123" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed pipelines binding; warns on a missing pipeline; errors on a missing binding", () => {
            expect.assertions(3);

            const valid = validateWranglerConfig(validBase({ pipelines: [{ binding: "PIPE", pipeline: "events" }] }));

            expect(valid.valid).toBe(true);

            const missingPipeline = validateWranglerConfig(validBase({ pipelines: [{ binding: "PIPE" }] }));

            expect(missingPipeline.warnings.join(" ")).toMatch(/wrangler pipelines create/u);

            const missingBinding = validateWranglerConfig(validBase({ pipelines: [{ pipeline: "events" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts `stream`, wrangler's rename of the deprecated `pipeline` field, without warning", () => {
            expect.assertions(2);

            // wrangler deprecation-warns on `pipeline`, so a correctly-wired binding
            // now spells it `stream`; that must not trip the missing-hint warning.
            const stream = validateWranglerConfig(validBase({ pipelines: [{ binding: "PIPE", stream: "events" }] }));

            expect(stream.valid).toBe(true);
            expect(stream.warnings.join(" ")).not.toMatch(/wrangler pipelines create/u);
        });

        it("accepts a well-formed analytics_engine_datasets binding; warns on a missing dataset; errors on a missing binding", () => {
            expect.assertions(3);

            const valid = validateWranglerConfig(validBase({ analytics_engine_datasets: [{ binding: "ANALYTICS", dataset: "events" }] }));

            expect(valid.valid).toBe(true);

            const missingDataset = validateWranglerConfig(validBase({ analytics_engine_datasets: [{ binding: "ANALYTICS" }] }));

            expect(missingDataset.warnings.join(" ")).toMatch(/defaults to the binding name/u);

            const missingBinding = validateWranglerConfig(validBase({ analytics_engine_datasets: [{ dataset: "events" }] }));

            expect(missingBinding.errors.join(" ")).toContain('must have a non-empty "binding"');
        });

        it("accepts a well-formed browser block and flags an empty one", () => {
            expect.assertions(2);

            expect(validateWranglerConfig(validBase({ browser: { binding: "BROWSER" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ browser: {} })).errors.join(" ")).toContain("browser must be an object");
        });

        it("accepts a well-formed images block and flags an empty one", () => {
            expect.assertions(2);

            expect(validateWranglerConfig(validBase({ images: { binding: "IMAGES" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ images: {} })).errors.join(" ")).toContain("images must be an object");
        });

        it("accepts a well-formed services entry and rejects one missing binding or service", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ services: [{ binding: "PRICING", entrypoint: "PricingEntry", service: "pricing-worker" }] })).valid).toBe(
                true,
            );
            expect(validateWranglerConfig(validBase({ services: [{ service: "pricing-worker" }] })).errors.join(" ")).toContain(
                'must have a non-empty "binding"',
            );
            expect(validateWranglerConfig(validBase({ services: [{ binding: "PRICING" }] })).errors.join(" ")).toContain('must have a non-empty "service"');
        });

        it("accepts a well-formed dispatch_namespaces entry and rejects one missing binding or namespace", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ dispatch_namespaces: [{ binding: "DISPATCHER", namespace: "tenants" }] })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ dispatch_namespaces: [{ namespace: "tenants" }] })).errors.join(" ")).toContain(
                'must have a non-empty "binding"',
            );
            expect(validateWranglerConfig(validBase({ dispatch_namespaces: [{ binding: "DISPATCHER" }] })).errors.join(" ")).toContain(
                'must have a non-empty "namespace"',
            );
        });

        it("does not trip DO/migration cross-checks when only dispatch_namespaces is added", () => {
            expect.assertions(1);

            const report = validateWranglerConfig(validBase({ dispatch_namespaces: [{ binding: "DISPATCHER", namespace: "tenants" }] }));

            expect(report.errors).toHaveLength(0);
        });

        it("accepts a well-formed mtls_certificates entry and rejects one missing binding or certificate_id", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ mtls_certificates: [{ binding: "MY_CERT", certificate_id: "cert_1" }] })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ mtls_certificates: [{ certificate_id: "cert_1" }] })).errors.join(" ")).toContain(
                'must have a non-empty "binding"',
            );
            expect(validateWranglerConfig(validBase({ mtls_certificates: [{ binding: "MY_CERT" }] })).errors.join(" ")).toContain(
                'must have a non-empty "certificate_id"',
            );
        });

        it("accepts a well-formed send_email binding and warns (never errors) on one missing name", () => {
            expect.assertions(4);

            expect(validateWranglerConfig(validBase({ send_email: [{ name: "SEND_EMAIL" }] })).valid).toBe(true);

            // A missing `name` is a strictly additive advisory — wrangler reports the
            // authoritative error at deploy, so validation stays valid and only warns.
            const missingName = validateWranglerConfig(validBase({ send_email: [{ destination_address: "ops@example.com" }] }));

            expect(missingName.valid).toBe(true);
            expect(missingName.warnings.join(" ")).toContain('has no non-empty "name"');

            // A wrong *type* is still a malformed shape and errors.
            expect(validateWranglerConfig(validBase({ send_email: {} as never })).errors.join(" ")).toContain("send_email must be an array");
        });

        it("recognizes logpush as a boolean and rejects a non-boolean", () => {
            expect.assertions(3);

            expect(validateWranglerConfig(validBase({ logpush: true })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({})).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ logpush: "true" as never })).errors.join(" ")).toContain("logpush must be a boolean");
        });

        it("accepts every placement.mode wrangler accepts, and rejects a typo'd mode or wrong shape", () => {
            expect.assertions(5);

            expect(validateWranglerConfig(validBase({ placement: { mode: "smart" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ placement: { mode: "off" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ placement: { mode: "targeted", region: "weur" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ placement: { mode: "fast" } })).errors.join(" ")).toContain("placement.mode must be one of");
            expect(validateWranglerConfig(validBase({ placement: "smart" as never })).errors.join(" ")).toContain("placement must be an object");
        });

        it("reports a null self-describing binding instead of throwing", () => {
            expect.assertions(2);

            expect(validateWranglerConfig(validBase({ browser: null as never })).errors.join(" ")).toContain("browser must be an object");
            expect(validateWranglerConfig(validBase({ images: null as never })).errors.join(" ")).toContain("images must be an object");
        });

        it("accepts a well-formed assets block and flags a missing directory, wrong shape, or non-string binding", () => {
            expect.assertions(4);

            expect(validateWranglerConfig(validBase({ assets: { binding: "ASSETS", directory: "./dist/client" } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ assets: { binding: "ASSETS" } })).errors.join(" ")).toContain('must declare a non-empty "directory"');
            expect(validateWranglerConfig(validBase({ assets: "x" as never })).errors.join(" ")).toContain("assets must be an object");
            expect(validateWranglerConfig(validBase({ assets: { binding: 5 as never, directory: "./dist/client" } })).errors.join(" ")).toContain(
                "assets.binding must be a non-empty string",
            );
        });

        it("accepts a well-formed cache block and rejects bad shapes", () => {
            expect.assertions(5);

            expect(validateWranglerConfig(validBase({ cache: { enabled: true }, compatibility_date: "2026-05-01" })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ cache: { enabled: false } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ cache: "yes" as never })).errors.join(" ")).toContain("cache must be an object");
            expect(validateWranglerConfig(validBase({ cache: null })).errors.join(" ")).toContain("cache must be an object");
            expect(validateWranglerConfig(validBase({ cache: { enabled: "yes" as never } })).errors.join(" ")).toContain("cache.enabled must be a boolean");
        });

        it("requires compatibility_date >= 2026-05-01 when cache.enabled is true", () => {
            expect.assertions(7);

            const withCache = { cache: { enabled: true }, compatibility_date: "2026-05-01" };
            const withCacheOld = { cache: { enabled: true }, compatibility_date: "2026-04-07" };
            const withoutCache = { compatibility_date: "2026-04-07" };
            const exportsCacheOld = { exports: { default: { type: "worker", cache: { enabled: true } } }, compatibility_date: "2026-04-07" };
            const cacheWithMalformedDate = { cache: { enabled: true }, compatibility_date: "2026-4-7" };
            const nullExportsCache = { exports: null, cache: { enabled: true }, compatibility_date: "2026-04-07" };

            expect(validateWranglerConfig(validBase(withCache)).valid).toBe(true);
            expect(validateWranglerConfig(validBase(withCacheOld)).errors.join(" ")).toContain('cache.enabled requires compatibility_date >= "2026-05-01"');
            expect(validateWranglerConfig(validBase(withoutCache)).valid).toBe(true);
            expect(validateWranglerConfig(validBase(exportsCacheOld)).errors.join(" ")).toContain('cache.enabled requires compatibility_date >= "2026-05-01"');

            const malformedReport = validateWranglerConfig(validBase(cacheWithMalformedDate));

            expect(malformedReport.errors.join(" ")).toContain("YYYY-MM-DD");
            expect(malformedReport.errors.join(" ")).not.toContain('cache.enabled requires compatibility_date >= "2026-05-01"');

            // `exports: null` should not crash and should still surface the top-level cache date error.
            expect(validateWranglerConfig(validBase(nullExportsCache)).errors.join(" ")).toContain('cache.enabled requires compatibility_date >= "2026-05-01"');
        });

        it("accepts a well-formed exports block and rejects malformed entry shapes", () => {
            expect.assertions(8);

            expect(
                validateWranglerConfig(validBase({ exports: { default: { type: "worker", cache: { enabled: true } } }, compatibility_date: "2026-05-01" }))
                    .valid,
            ).toBe(true);
            expect(validateWranglerConfig(validBase({ exports: { CachedBackend: { type: "worker", cache: { enabled: false } } } })).valid).toBe(true);
            expect(validateWranglerConfig(validBase({ exports: "bad" as never })).errors.join(" ")).toContain("exports must be an object");
            expect(validateWranglerConfig(validBase({ exports: null })).errors.join(" ")).toContain("exports must be an object");
            expect(validateWranglerConfig(validBase({ exports: { default: "bad" as never } })).errors.join(" ")).toContain(
                'exports["default"] must be an object',
            );
            expect(validateWranglerConfig(validBase({ exports: { default: null } })).errors.join(" ")).toContain('exports["default"] must be an object');
            expect(validateWranglerConfig(validBase({ exports: { default: { type: "worker", cache: { enabled: 1 as never } } } })).errors.join(" ")).toContain(
                'exports["default"].cache.enabled must be a boolean',
            );
            expect(validateWranglerConfig(validBase({ exports: { default: { type: "worker", cache: null } } })).errors.join(" ")).toContain(
                'exports["default"].cache must be an object',
            );
        });
    });

    // Plan 353: `migrations[]` cross-checked against `durable_objects.bindings`.
    // The risk here is over-rejection (a false positive breaks a working
    // project's deploy), so the fold must be order-sensitive — tests 3 and 4
    // are the guards for that, not just coverage padding.
    describe("durable object migrations", () => {
        it("errors naming the class when a DO binding has no migrations block at all", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            });

            expect(report.errors.join(" ")).toContain('declares class "ShardDO" but it is missing from migrations');
        });

        it("passes once a migration entry registers the class via new_sqlite_classes", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            });

            expect(report.errors).toEqual([]);
            expect(report.valid).toBe(true);
        });

        it("resolves a class added then renamed across two migration entries by its NEW name", () => {
            expect.assertions(3);

            // A second binding (unrelated to the fixed SHARD/ShardDO check) is
            // added, renamed, then re-checked. Naive "does this class appear
            // anywhere in migrations" scan gets BOTH directions wrong here: the
            // OLD name ("WorkerDO") must no longer satisfy a binding, and the
            // NEW name must.
            const renamed = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "WorkerDOv2", name: "WORKER" },
                    ],
                },
                migrations: [{ new_sqlite_classes: ["ShardDO", "WorkerDO"] }, { renamed_classes: [{ from: "WorkerDO", to: "WorkerDOv2" }] }],
            });

            expect(renamed.errors).toEqual([]);
            expect(renamed.valid).toBe(true);

            const stillOldName = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "WorkerDO", name: "WORKER" },
                    ],
                },
                migrations: [{ new_sqlite_classes: ["ShardDO", "WorkerDO"] }, { renamed_classes: [{ from: "WorkerDO", to: "WorkerDOv2" }] }],
            });

            expect(stillOldName.errors.join(" ")).toContain('declares class "WorkerDO" but it is missing from migrations');
        });

        it("errors when a class is added then later deleted", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }, { deleted_classes: ["ShardDO"] }],
            });

            expect(report.errors.join(" ")).toContain('declares class "ShardDO" but it is missing from migrations');
        });

        it("names a second DO binding (e.g. SessionDO) that migrations don't cover", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "SessionDO", name: "SESSION" },
                    ],
                },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            });

            expect(report.errors.join(" ")).toContain('declares class "SessionDO" but it is missing from migrations');
            expect(report.errors.join(" ")).not.toContain('declares class "ShardDO" but it is missing from migrations');
        });

        it("reports a config error instead of throwing on hand-written non-array migration fields", () => {
            expect.assertions(2);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                // A hand-edited `wrangler.jsonc` can hold any of these. An object made
                // `for…of` throw a raw TypeError out of the validator; the string folded
                // in one character at a time, so "ShardDO" never became a class.
                migrations: [{ new_sqlite_classes: {} }, { new_classes: "ShardDO" }, { deleted_classes: 7 }, { renamed_classes: "nope" }] as never,
            });

            expect(report.errors.join(" ")).toContain('declares class "ShardDO" but it is missing from migrations');
            expect(report.errors.join(" ")).not.toContain("TypeError");
        });

        it("ignores a binding whose class lives in another script (script_name set)", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: {
                    bindings: [
                        { class_name: "ShardDO", name: "SHARD" },
                        { class_name: "RemoteDO", name: "OTHER", script_name: "other-worker" },
                    ],
                },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            });

            expect(report.errors.join(" ")).not.toContain("RemoteDO");
        });
    });

    describe("r2_buckets / d1_databases structural validation", () => {
        it("errors when an r2_buckets entry has no bucket_name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                r2_buckets: [{ binding: "FILES" }],
            });

            expect(report.errors.join(" ")).toContain('must have a non-empty "bucket_name"');
        });

        it("accepts a well-formed r2_buckets entry", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                r2_buckets: [{ binding: "FILES", bucket_name: "app-files" }],
            });

            expect(report.errors).toEqual([]);
        });

        it("errors when a d1_databases entry has neither database_id nor database_name", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                d1_databases: [{ binding: "DB" }],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            });

            expect(report.errors.join(" ")).toContain('must have a "database_id" or a "database_name"');
        });

        it("accepts a d1_databases entry with only database_name (id is filled in later by wrangler d1 create)", () => {
            expect.assertions(1);

            const report = validateWranglerConfig({
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                d1_databases: [{ binding: "DB", database_name: "app-db" }],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                migrations: [{ new_sqlite_classes: ["ShardDO"] }],
            });

            expect(report.errors).toEqual([]);
        });
    });

    // Regression guard (plan 353, Step 4 test 8): a realistic, fully-wired
    // config — mirroring examples/team-chat/wrangler.jsonc — must produce no
    // NEW errors or warnings from this change. Keep this in sync with that
    // example if its shape changes.
    describe("realistic complete config (regression guard)", () => {
        it("produces no errors or warnings for a fully-wired example-shaped config", () => {
            expect.assertions(2);

            const report = validateWranglerConfig(
                {
                    compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                    compatibility_flags: ["nodejs_compat"],
                    d1_databases: [{ binding: "DB", database_id: "REPLACE_WITH_D1_ID", database_name: "lunora-example-team-chat" }],
                    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                    main: "src/server/index.ts",
                    migrations: [{ new_sqlite_classes: ["ShardDO"] }],
                    observability: { enabled: true, head_sampling_rate: 1 },
                    r2_buckets: [{ binding: "FILES", bucket_name: "lunora-example-team-chat-files" }],
                    vars: { PUBLIC_STORAGE_BASE_URL: "http://localhost:5173" },
                },
                { hasD1GlobalTable: true, hasHyperdriveGlobalTable: false },
            );

            expect(report.errors).toEqual([]);
            expect(report.warnings).toEqual([]);
        });
    });
});
