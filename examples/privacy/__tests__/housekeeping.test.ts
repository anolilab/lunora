/**
 * The daily housekeeping: the cron trigger reaches the sweep, and the sweep expires a finished export
 * whose download window has passed, deleting its files.
 */
import { lunoraTest } from "@lunora/testing";
import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server.js";
import { privacyFor, privacyWorkflows } from "../lunora/privacy";
import { privacyPort, privacySweep } from "../lunora/requests";
import schema from "../lunora/schema";
import { addTask } from "../lunora/tasks";
import { buildWorker } from "../src/server/worker";
import { tombstoneNamespace, workflowContext } from "./workflow-context";

type Harness = ReturnType<typeof lunoraTest>;

/** The harness's context lacks the `orm` surface codegen adds; the privacy code never reads it. */
const appCtx = (ctx: unknown): MutationCtx => ctx as MutationCtx;

const SUBJECT = { userId: "u1" };
const DAILY = "0 6 * * *";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** A shard namespace that records the body of every request the worker sends it. */
const shardSpy = (): { bodies: unknown[]; namespace: ShardNamespaceLike } => {
    const bodies: unknown[] = [];

    return {
        bodies,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        bodies.push(await request.clone().json());

                        return Response.json({ value: null });
                    },
                };
            },
            idFromName: (name: string) => name,
        },
    };
};

describe("privacy housekeeping", () => {
    let t: Harness;

    beforeEach(async () => {
        t = lunoraTest(schema);

        await t.withIdentity(SUBJECT).mutation(addTask, { title: "book flights" });
    });

    afterEach(() => {
        t.close();
    });

    it("dispatches the sweep into the shard when the daily trigger fires", async () => {
        expect.assertions(1);

        const shard = shardSpy();

        await buildWorker({ SHARD: shard.namespace }).scheduled({ cron: DAILY, scheduledTime: 0 }, {}, fakeContext);

        expect(shard.bodies).toContainEqual({ args: {}, functionPath: "requests:privacySweep" });
    });

    it("expires a ready export past its window and deletes its files", async () => {
        expect.assertions(4);

        const request = await t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

        await privacyWorkflows.exportHandler(
            workflowContext({
                env: { PRIVACY_TOMBSTONES: tombstoneNamespace() },
                params: { requestId: request.id },
                run: async (_reference, args) => t.run(async (ctx) => appCtx(ctx).runMutation(privacyPort, args)),
            }),
        );

        const filesOf = async () =>
            t.run(async (ctx) =>
                appCtx(ctx)
                    .db.query("exportFiles")
                    .withIndex("byRequestAndName", (q) => q.eq("requestId", request.id))
                    .collect(),
            );
        const rowOf = async () =>
            t.run(async (ctx) =>
                appCtx(ctx)
                    .db.query("privacy_requests")
                    .withIndex("byRequestId", (q) => q.eq("requestId", request.id))
                    .first(),
            );

        await expect(filesOf()).resolves.not.toStrictEqual([]);

        // The download window passed: move the stored expiry into the past, as time would.
        const ready = await rowOf();

        await t.run(async (ctx) => appCtx(ctx).db.patch(ready!._id, { expiresAt: Date.now() - 1000 }));

        await expect(t.run(async (ctx) => appCtx(ctx).runMutation(privacySweep, {}))).resolves.toStrictEqual({ expired: [request.id], purged: 0 });
        await expect(rowOf()).resolves.toMatchObject({ status: "expired" });
        await expect(filesOf()).resolves.toStrictEqual([]);
    });
});
