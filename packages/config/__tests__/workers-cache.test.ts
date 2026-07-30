import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerCompatibilityDate } from "../src/cloudflare/reconcile-compatibility-date";
import { isCacheEnabled, WORKERS_CACHE_MIN_DATE } from "../src/cloudflare/workers-cache";
import { validateWranglerProject } from "../src/cloudflare/wrangler-validator";

let workdir: string;

describe("workers-cache", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-config-workers-cache-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("isCacheEnabled", () => {
        it("is false for a missing/null/undefined config", () => {
            expect.assertions(3);

            expect(isCacheEnabled(undefined)).toBe(false);
            expect(isCacheEnabled(null)).toBe(false);
            expect(isCacheEnabled({})).toBe(false);
        });

        it("is true when the top-level cache block is enabled", () => {
            expect.assertions(2);

            expect(isCacheEnabled({ cache: { enabled: true } })).toBe(true);
            expect(isCacheEnabled({ cache: { enabled: false } })).toBe(false);
        });

        it("is true when any per-export cache block is enabled", () => {
            expect.assertions(2);

            expect(isCacheEnabled({ exports: { default: { cache: { enabled: true } } } })).toBe(true);
            expect(isCacheEnabled({ exports: { default: { cache: { enabled: false } }, other: { cache: null } } })).toBe(false);
        });

        it("tolerates a null exports map", () => {
            expect.assertions(1);

            expect(isCacheEnabled({ cache: { enabled: true }, exports: null })).toBe(true);
        });
    });

    /**
     * CONFIG-03: the reconciler (auto-bump) and the validator previously each
     * carried their own `WORKERS_CACHE_MIN_DATE` literal and their own
     * cache-enabled walk — two copies of the same fact that could silently
     * drift apart. This is the drift guard: bump a wrangler.jsonc with the
     * shared reconciler, then feed the RESULT through the shared validator and
     * assert it raises no cache-date error — proving both agree on the exact
     * same minimum date.
     */
    it("the reconciler's auto-bumped date satisfies the validator (reconciler/validator agreement)", () => {
        expect.assertions(4);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
                "name": "lunora-app",
                "main": "src/index.ts",
                "compatibility_date": "2026-04-07",
                "compatibility_flags": ["nodejs_compat"],
                "cache": { "enabled": true },
                "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] }
            }`,
            "utf8",
        );

        const reconciled = reconcileWranglerCompatibilityDate(workdir);

        expect(reconciled.changed).toBe(true);
        expect(reconciled.date).toBe(WORKERS_CACHE_MIN_DATE);

        const rewritten = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        expect(rewritten).toContain(`"compatibility_date": "${WORKERS_CACHE_MIN_DATE}"`);

        const validated = validateWranglerProject({ projectRoot: workdir });

        expect(validated.problems.join(" ")).not.toContain("cache.enabled requires compatibility_date");
    });

    it("is idempotent: a config already at the minimum date is left unchanged", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
                "name": "lunora-app",
                "main": "src/index.ts",
                "compatibility_date": "${WORKERS_CACHE_MIN_DATE}",
                "cache": { "enabled": true },
                "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] }
            }`,
            "utf8",
        );

        const reconciled = reconcileWranglerCompatibilityDate(workdir);

        expect(reconciled.changed).toBe(false);
        expect(reconciled.date).toBe(WORKERS_CACHE_MIN_DATE);
    });

    it("skips the bump entirely when cache is not enabled", () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            `{
                "name": "lunora-app",
                "main": "src/index.ts",
                "compatibility_date": "2026-04-07",
                "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] }
            }`,
            "utf8",
        );

        const reconciled = reconcileWranglerCompatibilityDate(workdir);

        expect(reconciled.changed).toBe(false);
        expect(reconciled.reason).toBe("cache not enabled");
    });
});
