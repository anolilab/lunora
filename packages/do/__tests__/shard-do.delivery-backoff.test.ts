import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupDatabases, dataFrames, permit, setup } from "./_helpers/delivery-authorization";

describe("delivery authorization with subscription backoff and result limits", () => {
    afterEach(() => {
        cleanupDatabases();
        vi.useRealTimers();
    });

    it("revokes a backed-off subscription as soon as authorization is denied, without re-running its query", async () => {
        expect.assertions(5);

        vi.useFakeTimers({ toFake: ["Date"] });

        const test = setup();

        await test.send();

        test.shard.queryFailure = new Error("handler bug");

        // The second consecutive failure latches the subscription; the window is open from here.
        await test.write();

        await test.write();

        const runsInWindow = test.shard.queryCalls;

        // Only the subscription's authority is revoked: the write must still be accepted so that its flush runs.
        test.authority.mockImplementation(async ({ transport }) => (transport === "subscription" ? undefined : permit(0)));

        test.socket.frames.length = 0;

        await test.write();

        expect(test.socket.frames).toStrictEqual([{ type: "error", id: "view", code: "FORBIDDEN", error: { code: "FORBIDDEN", message: "AccessDenied" } }]);
        expect(test.socket.attachment.subs).toStrictEqual({});
        // Only the failing query's execution is skipped by the backoff.
        expect(test.shard.queryCalls).toBe(runsInWindow);
        expect(dataFrames(test.socket)).toStrictEqual([]);

        // Revoked for good: a later write has nothing left to refresh.
        test.socket.frames.length = 0;

        await test.write();

        expect(test.socket.frames).toStrictEqual([]);
    });

    it("keeps skipping the query of a backed-off subscription whose access is still granted", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date"] });

        const test = setup();

        await test.send();

        test.shard.queryFailure = new Error("handler bug");

        await test.write();

        await test.write();

        const runsInWindow = test.shard.queryCalls;

        await test.write();

        expect(test.shard.queryCalls).toBe(runsInWindow);
        expect(Object.keys(test.socket.attachment.subs)).toStrictEqual(["view"]);
    });

    it("tells a guarded socket when a refreshed result outgrows the cap and ends the subscription", async () => {
        expect.assertions(4);

        const test = setup(undefined, { LUNORA_SUBSCRIPTION_MAX_RESULT_CHARS: "200" });

        await test.send();

        expect(dataFrames(test.socket)).toHaveLength(1);

        test.shard.rows = ["x".repeat(500)];

        test.socket.frames.length = 0;

        await test.write();

        expect(test.socket.frames).toStrictEqual([expect.objectContaining({ type: "error", id: "view", code: "SUBSCRIPTION_RESULT_TOO_LARGE" })]);
        expect(test.socket.attachment.subs).toStrictEqual({});

        // No later flush re-runs and re-encodes the oversized result.
        const runs = test.shard.queryCalls;

        await test.write();

        expect(test.shard.queryCalls).toBe(runs);
    });
});
