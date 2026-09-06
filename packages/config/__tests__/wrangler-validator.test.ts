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

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: false, vectorIndexNames: ["docs-body"] });

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

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: true, vectorIndexNames: [] });

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

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: true });

            expect(report.errors.some((line) => line.includes("d1_databases"))).toBe(true);
        });

        it("requires a matching vectorize binding for each declared vector index", () => {
            expect.assertions(2);

            const wrangler: WranglerConfig = {
                compatibility_date: REQUIRED_COMPATIBILITY_DATE,
                compatibility_flags: [REQUIRED_FLAG],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            };

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: false, vectorIndexNames: ["docs-body"] });

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

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: false, vectorIndexNames: ["docs-body"] });

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

            const report = validateWranglerConfig(wrangler, { hasGlobalTable: true }, "production");

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

            expect(validateWranglerConfig(wrangler, { hasGlobalTable: true }, "production").valid).toBe(true);
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
                writeFileSync(join(workdir, "wrangler.jsonc"), MULTI_ENV_WRANGLER, "utf8");

                expect(validateWranglerProject({ projectRoot: workdir }).report.valid).toBe(true);
            });

            it("validating --env production inspects env.production's own bindings and passes", () => {
                expect.assertions(1);

                writeSchema(SCHEMA_WITH_GLOBAL);
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

                // A warning, not an error: the scanner cannot know every export
                // form, and a miss must not block a deploy that would have worked.
                expect(result.report.valid).toBe(true);
                expect(result.report.warnings.join("\n")).toContain("SchedulerDO");
                expect(result.report.warnings.join("\n")).toContain("does not export it");
            });

            it("passes once the class is exported", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(
                    `export { ShardDO } from "./lunora/_generated/shard";\nexport { SchedulerDO } from "@lunora/scheduler";\nexport default { fetch() {} };\n`,
                );

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.filter((warning) => warning.includes("does not export it"))).toEqual([]);
            });

            it("treats a type-only export as unexported — it compiles away", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport type { SchedulerDO } from "@lunora/scheduler";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.join("\n")).toContain("SchedulerDO");
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

                expect(result.report.warnings.join("\n")).toContain("SchedulerDO");
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

                expect(result.report.warnings.filter((warning) => warning.includes("does not export it"))).toEqual([]);
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

                expect(result.report.warnings.filter((warning) => warning.includes("does not export it"))).toEqual([]);
            });

            it("resolves `export { Local as Bound }` by the EXPORTED name, which is what wrangler binds", () => {
                expect.assertions(2);

                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport { InternalScheduler as SchedulerDO } from "./s";\nexport default { fetch() {} };\n`);

                const accepted = validateWranglerProject({ projectRoot: workdir });

                expect(accepted.report.warnings.filter((warning) => warning.includes("does not export it"))).toEqual([]);

                // The LOCAL name is not what is bound, so aliasing it away is a miss.
                writeEntry(`export { ShardDO } from "./shard";\nexport { SchedulerDO as SomethingElse } from "./s";\nexport default { fetch() {} };\n`);

                expect(validateWranglerProject({ projectRoot: workdir }).report.warnings.join("\n")).toContain("SchedulerDO");
            });

            it("stays silent when the entry has a star re-export", () => {
                expect.assertions(1);

                // A star re-export forwards names no per-name scan can see, so
                // absence proves nothing. A false error here would block a
                // deploy that works — worse than missing one.
                writeWrangler(`, { "name": "SCHEDULER", "class_name": "SchedulerDO" }`);
                writeEntry(`export * from "./lunora/_generated/workflows";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.filter((warning) => warning.includes("does not export it"))).toEqual([]);
            });

            it("ignores a binding whose class lives in another script", () => {
                expect.assertions(1);

                writeWrangler(`, { "name": "OTHER", "class_name": "RemoteDO", "script_name": "other-worker" }`);
                writeEntry(`export { ShardDO } from "./shard";\nexport default { fetch() {} };\n`);

                const result = validateWranglerProject({ projectRoot: workdir });

                expect(result.report.warnings.filter((warning) => warning.includes("RemoteDO"))).toEqual([]);
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
                { hasGlobalTable: true },
            );

            expect(report.errors).toEqual([]);
            expect(report.warnings).toEqual([]);
        });
    });
});
