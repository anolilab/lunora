import { describe, expect, it, vi } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

const createFakeState = (): ShardDOState => {
    return {
        acceptWebSocket() {},
        getWebSockets: () => [],
        storage: { sql: { exec: () => undefined } },
    };
};

class ScopePreservingLazyShard extends ShardDO {
    public readonly observed = new Map<
        string,
        { identity: Record<string, unknown> | undefined; room: Record<string, unknown> | undefined; system: boolean; userId: string | undefined }
    >();

    public readonly coldPreparationsStarted = new Promise<void>((resolve) => {
        this.signalColdPreparationsStarted = resolve;
    });

    // Queries may suspend at the same cold import without serializing requests.
    protected override isMutationFunction = vi.fn<() => boolean>().mockReturnValue(false);

    declare private signalColdPreparationsStarted: (() => void) | undefined;

    private preparationReady = false;

    private releasePreparation: (() => void) | undefined;

    private preparationCalls = 0;

    private readonly pendingPreparation = new Promise<void>((resolve) => {
        this.releasePreparation = resolve;
    });

    public release(): void {
        this.preparationReady = true;
        this.releasePreparation?.();
    }

    public override async handleRpc(_functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        // Mirrors the generated handleRpc prologue. The first two prepare calls
        // below model the outer /rpc warm-up; this direct entry is still cold,
        // like lifecycle, room, and runAs dispatches that call handleRpc directly.
        const requestScope = this.captureRequestScope();
        const preparation = this.prepareFunction("posts:list", "rpc");

        if (preparation !== undefined) {
            try {
                await preparation;
            } finally {
                this.restoreRequestScope(requestScope);
            }
        }

        this.observed.set(String(args.tag), {
            identity: this.getCurrentIdentity(),
            room: args.socket as Record<string, unknown> | undefined,
            system: this.isSystemDispatch(),
            userId: this.getCurrentUserId(),
        });

        return {};
    }

    protected override prepareFunction(_path: string, _reason: "rpc" | "subscription" | "stream" | "reactor"): void | Promise<void> {
        this.preparationCalls += 1;

        if (this.preparationCalls <= 2) {
            return undefined;
        }

        if (!this.preparationReady) {
            this.signalColdPreparationsStarted?.();

            return this.pendingPreparation;
        }

        return undefined;
    }
}

const rpc = (tag: string, userId: string, identity: Record<string, unknown>, system: boolean): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({
            args: {
                tag,
                ...(system ? { kind: "join", socket: { connectionId: `room-${tag}`, shardKey: "root", userId } } : {}),
            },
            functionPath: "posts:list",
        }),
        headers: {
            "content-type": "application/json",
            "x-lunora-identity": JSON.stringify(identity),
            "x-lunora-userid": userId,
            ...(system ? { "x-lunora-system": "1" } : {}),
        },
        method: "POST",
    });

describe("lazy function request scope", () => {
    it("restores identity and system scope after shared cold preparation in handleRpc", async () => {
        expect.assertions(3);

        const shard = new ScopePreservingLazyShard(createFakeState(), {});
        const alice = { role: "alice" };
        const bob = { role: "bob" };
        const aliceRequest = shard.fetch(rpc("alice", "user-alice", alice, true));
        const bobRequest = shard.fetch(rpc("bob", "user-bob", bob, false));

        try {
            await shard.coldPreparationsStarted;
            shard.release();

            await Promise.all([aliceRequest, bobRequest]);

            expect(shard.observed.get("alice")).toEqual({
                identity: alice,
                room: { connectionId: "room-alice", shardKey: "root", userId: "user-alice" },
                system: true,
                userId: "user-alice",
            });
            expect(shard.observed.get("bob")).toEqual({ identity: bob, room: undefined, system: false, userId: "user-bob" });
            expect(shard.observed.size).toBe(2);
        } finally {
            shard.release();
            await Promise.all([aliceRequest, bobRequest]);
        }
    });
});
