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

class LazyPaidShard extends ShardDO {
    public preparations: string[] = [];
    public readonly slowPreparationStarted: Promise<void>;

    public override handleRpc = vi.fn<(functionPath: string) => Promise<unknown>>((functionPath) => Promise.resolve({ functionPath }));
    protected override isPaidFunction = vi.fn<(functionPath: string) => boolean>((functionPath) => functionPath === "posts:premium");

    private releaseSlowPreparation: (() => void) | undefined;
    private signalSlowPreparationStarted: (() => void) | undefined;

    public constructor(state: ShardDOState) {
        super(state, {});
        this.slowPreparationStarted = new Promise((resolve) => {
            this.signalSlowPreparationStarted = resolve;
        });
    }

    public releaseSlow(): void {
        this.releaseSlowPreparation?.();
    }

    protected override async prepareFunction(functionPath: string): Promise<void> {
        this.preparations.push(functionPath);

        if (functionPath === "posts:slow") {
            this.signalSlowPreparationStarted?.();
            await new Promise<void>((resolve) => {
                this.releaseSlowPreparation = resolve;
            });
        }

        if (functionPath === "posts:premium") {
            this.releaseSlowPreparation?.();
        }
    }
}

const rpc = (functionPath: string): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("lazy preparation and pre-dispatch answers", () => {
    it("answers the paid backstop while an unrelated lazy preparation is suspended", async () => {
        expect.assertions(4);

        const shard = new LazyPaidShard(createFakeState());
        let slowRequestSettled = false;
        const slowRequest = shard.fetch(rpc("posts:slow")).finally(() => {
            slowRequestSettled = true;
        });

        try {
            await shard.slowPreparationStarted;

            const paidResponse = await shard.fetch(rpc("posts:premium"));

            expect(paidResponse.status).toBe(500);
            expect(slowRequestSettled).toBe(false);
            expect(shard.preparations).toEqual(["posts:slow"]);

            shard.releaseSlow();
            await slowRequest;

            expect(shard.preparations).toEqual(["posts:slow"]);
        } finally {
            shard.releaseSlow();
            await slowRequest;
        }
    });
});
