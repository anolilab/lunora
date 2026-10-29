import { SENSITIVE_ARG_MASK } from "@lunora/observability";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const RAW = "  Hunter2-Token  ";
// What a validator's transform turns the marked argument into before the where-clause runs.
const TRANSFORMED = "hunter2-token";

/**
 * A shard whose `vault` shape marks `token`, resolved the way the generated `resolveShape`
 * wrapper resolves a sensitive shape: a scope opened from the raw args, the parsed value
 * admitted, a thrown error scrubbed through the scope before it is cleared.
 */
class SensitiveShapeShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- this shard exercises only the shape path; RPC is unused.
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    // eslint-disable-next-line class-methods-use-this -- the marked names are a fixed table for this one shape.
    protected override sensitiveArgNames(functionPath: string): ReadonlySet<string> {
        return functionPath === "__shape__:vault" ? new Set(["token"]) : new Set<string>();
    }

    protected override resolveShape(name: string, args: Record<string, unknown>): never {
        const sensitive = this.openSensitiveScope(`__shape__:${name}`, args);

        try {
            this.admitSensitiveValues(sensitive, { token: TRANSFORMED }, new Set(["token"]));

            throw new Error(`where rejected token ${TRANSFORMED}`);
        } catch (error) {
            throw this.maskSensitiveError(error, sensitive);
        } finally {
            sensitive.clear();
        }
    }
}

describe("a shape where-clause that throws over a marked argument", () => {
    it("masks the transformed value in the error the shape reports and in the shard's log record", async () => {
        expect.assertions(3);

        const database = createSqliteExec();

        try {
            const shard = new SensitiveShapeShard(
                {
                    acceptWebSocket() {},
                    getWebSockets() {
                        return [];
                    },
                    storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
                },
                {},
            );
            const seed = (shard as unknown as { seedShapeSubscription: (ws: unknown, subId: string, shape: unknown) => Promise<unknown> })
                .seedShapeSubscription;
            const outcome = await seed.call(shard, {}, "s1", { args: { token: RAW }, name: "vault" });
            const recorded = (shard as unknown as { logs: { entries: () => { message: string }[] } }).logs.entries();

            // The client sees the redacted failure; the masked text is what the shard records.
            expect(outcome).toStrictEqual({ code: "SHAPE_RESOLVE_FAILED", message: "shape resolution failed" });
            expect(recorded.map((entry) => entry.message)).toStrictEqual([`where rejected token ${SENSITIVE_ARG_MASK}`]);
            expect(recorded.some((entry) => entry.message.includes(TRANSFORMED))).toBe(false);
        } finally {
            database.close();
        }
    });
});
