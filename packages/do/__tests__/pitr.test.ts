import type { PitrStorage } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS, armRestore, readBookmark } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "s3cret-admin";

const mockStorage = (overrides: Partial<PitrStorage> = {}): PitrStorage => {
    return {
        getBookmarkForTime: async () => "bm-for-time",
        getCurrentBookmark: async () => "bm-current",
        onNextSessionRestoreBookmark: async (bookmark: string) => `undo-of-${bookmark}`,
        ...overrides,
    };
};

describe("pitr helpers", () => {
    it("readBookmark returns the current bookmark, plus the for-time one when asked", async () => {
        expect.assertions(3);

        await expect(readBookmark(mockStorage())).resolves.toStrictEqual({ current: "bm-current" });

        const withTime = await readBookmark(mockStorage(), "2026-01-01T00:00:00Z");

        expect(withTime.current).toBe("bm-current");
        expect(withTime.forTime).toBe("bm-for-time");
    });

    it("readBookmark throws PITR_UNAVAILABLE when the native API is absent (local dev)", async () => {
        expect.assertions(1);

        await expect(readBookmark({})).rejects.toMatchObject({ code: "PITR_UNAVAILABLE" });
    });

    it("armRestore resolves a bookmark from a time and returns the undo bookmark", async () => {
        expect.assertions(2);

        const result = await armRestore(mockStorage(), { time: "2026-01-01T00:00:00Z" });

        expect(result.restoredTo).toBe("bm-for-time");
        expect(result.undoBookmark).toBe("undo-of-bm-for-time");
    });

    it("armRestore prefers an explicit bookmark over a time", async () => {
        expect.assertions(1);

        const result = await armRestore(mockStorage(), { bookmark: "bm-explicit", time: "2026-01-01T00:00:00Z" });

        expect(result.restoredTo).toBe("bm-explicit");
    });

    it("armRestore throws when given neither a bookmark nor a time", async () => {
        expect.assertions(1);

        await expect(armRestore(mockStorage(), {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});

/** A ShardDO whose `handleRpc` throws — the admin branch must short-circuit first. */
class AdminShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }
}

const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }

    return new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers,
        method: "POST",
    });
};

describe("pitr admin RPC", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let abort: ReturnType<typeof vi.fn<(reason?: string) => void>>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        abort = vi.fn<(reason?: string) => void>();
        state = {
            abort,
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: {
                getBookmarkForTime: async () => "bm-for-time",
                getCurrentBookmark: async () => "bm-current",
                onNextSessionRestoreBookmark: async (bookmark: string) => `undo-of-${bookmark}`,
                sql: database.sql as unknown as ShardDOState["storage"]["sql"],
            },
        };
    });

    afterEach(() => {
        database.close();
    });

    it("getPitrBookmark returns current + for-time, admin-gated", async () => {
        expect.assertions(3);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getPitrBookmark, { time: "2026-01-01T00:00:00Z" }, ADMIN_TOKEN));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { current: string; forTime?: string } }>();

        expect(body.result.current).toBe("bm-current");
        expect(body.result.forTime).toBe("bm-for-time");
    });

    it("pitrRestore arms recovery and returns the undo bookmark without restarting by default", async () => {
        expect.assertions(4);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.pitrRestore, { time: "2026-01-01T00:00:00Z" }, ADMIN_TOKEN));
        const body = await response.json<{ result: { restarted: boolean } & { restartedAt?: string; restoredTo: string; undoBookmark: string } }>();

        expect(body.result.restoredTo).toBe("bm-for-time");
        expect(body.result.undoBookmark).toBe("undo-of-bm-for-time");
        expect(body.result.restarted).toBe(false);
        // Default is arm-only: the restore applies on the next restart, not now.
        expect(abort).not.toHaveBeenCalled();
    });

    it("pitrRestore with restart aborts the DO to apply recovery immediately", async () => {
        expect.assertions(1);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        await shard.fetch(adminRequest(ADMIN_FUNCTIONS.pitrRestore, { bookmark: "bm-x", restart: true }, ADMIN_TOKEN));

        expect(abort).toHaveBeenCalledTimes(1);
    });

    it("pitrRestore is gated by the admin bearer", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.pitrRestore, { bookmark: "bm-x" }));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.pitrRestore, { bookmark: "bm-x" }, "nope"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });
});
