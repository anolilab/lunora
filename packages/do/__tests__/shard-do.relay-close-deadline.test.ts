import type { SocketAttachment } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShardDO } from "../src/shard-do";

class Shard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- stub: the close path dispatches nothing
    public override async handleRpc(): Promise<unknown> {
        return undefined;
    }
}

const hang = (): Promise<void> => new Promise<void>(() => {});

describe("shardDO: socket close is bounded on relay siblings", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("finishes the close even when a sibling never answers the relay release or drain", async () => {
        expect.assertions(2);

        const attachment: SocketAttachment = { connectionId: "conn-1", subs: {} };
        const ws = {
            attachment: attachment as SocketAttachment | undefined,
            deserializeAttachment() {
                return this.attachment;
            },
            send() {},
            serializeAttachment(value: unknown) {
                this.attachment = value as SocketAttachment | undefined;
            },
        };
        const shard = new Shard({ acceptWebSocket() {}, getWebSockets: () => [], id: { name: "room-1::relay::0" }, storage: { sql: {} } }, {});

        // A relay whose owner (or sibling) has stopped answering.
        Object.assign(shard, { relay: { announceDrain: hang, releaseRelayShapes: hang } });

        let closed = false;
        const closing = shard.webSocketClose(ws as unknown as WebSocket, 1000, "", true).then(() => {
            closed = true;

            return undefined;
        });

        await vi.advanceTimersByTimeAsync(100);

        expect(closed).toBe(false);

        await vi.advanceTimersByTimeAsync(10_000);
        await closing;

        // Bounded: the close completed and the attachment was cleared although neither post ever settled.
        expect(ws.attachment).toBeUndefined();
    });
});
