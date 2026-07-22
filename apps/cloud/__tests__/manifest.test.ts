import { describe, expect, it } from "vitest";

import { parseWranglerManifest } from "../src/deploy/manifest";

describe(parseWranglerManifest, () => {
    it("extracts DO classes, the D1/R2 bindings, and cron expressions", () => {
        const manifest = parseWranglerManifest({
            d1_databases: [{ binding: "DB" }],
            durable_objects: {
                bindings: [
                    { class_name: "ShardDO", name: "SHARD" },
                    { class_name: "SchedulerDO", name: "SCHEDULER" },
                ],
            },
            r2_buckets: [{ binding: "FILES" }],
            triggers: { crons: ["0 */6 * * *", "*/5 * * * *"] },
        });

        expect(manifest).toStrictEqual({
            bindings: {
                d1: { binding: "DB" },
                durableObjects: [
                    { binding: "SHARD", className: "ShardDO" },
                    { binding: "SCHEDULER", className: "SchedulerDO" },
                ],
                r2: { binding: "FILES" },
            },
            cronSpecs: ["0 */6 * * *", "*/5 * * * *"],
        });
    });

    it("returns an empty manifest for a minimal wrangler (server floors bindings to ShardDO)", () => {
        expect(parseWranglerManifest({})).toStrictEqual({ bindings: {}, cronSpecs: [] });
    });

    it("takes only the first D1/R2 binding (a tenant provisions one of each)", () => {
        const manifest = parseWranglerManifest({
            d1_databases: [{ binding: "DB" }, { binding: "SECONDARY" }],
            r2_buckets: [{ binding: "FILES" }, { binding: "MORE" }],
        });

        expect(manifest.bindings.d1).toStrictEqual({ binding: "DB" });
        expect(manifest.bindings.r2).toStrictEqual({ binding: "FILES" });
    });

    it("drops malformed DO/cron entries rather than trusting them", () => {
        const manifest = parseWranglerManifest({
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }, { name: "NO_CLASS" }, { class_name: "NO_NAME" }] },
            triggers: { crons: ["0 0 * * *", 42 as unknown as string, "", "  "] },
        });

        expect(manifest.bindings.durableObjects).toStrictEqual([{ binding: "SHARD", className: "ShardDO" }]);
        expect(manifest.cronSpecs).toStrictEqual(["0 0 * * *"]);
    });

    it("omits durableObjects entirely when none are declared", () => {
        expect(parseWranglerManifest({ d1_databases: [{ binding: "DB" }] }).bindings.durableObjects).toBeUndefined();
    });
});
