import { beforeAll, bench, describe } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * Whisper fan-out cost vs subscriber count — the regression guard for plan 075's
 * O(subscribers) per-flush fan-out (the cost the auto-elastic relay tier targets,
 * and that `getFanoutMetrics` surfaces).
 *
 * Each iteration drives ONE real `broadcastWhisper` through the public
 * `webSocketMessage` path: the owner scans every connected socket, reads its
 * hibernation attachment, and sends the one shared frame to topic members. The
 * bench measures that loop at a small and a large subscriber count so a
 * regression (e.g. building the frame per-socket, or an O(N²) membership check)
 * shows up as a super-linear jump between the two.
 *
 * Harness notes. `getWebSockets()` returns ONLY the N topic members, so the
 * fan-out iterates exactly N — the senders live in a separate pool (they need no
 * membership and `broadcastWhisper` reads the sender only via the `sender`
 * argument), keeping the iterated count equal to N rather than N + senders.
 * Senders rotate through a large pool so no single sender exceeds the per-socket
 * whisper token bucket (`WHISPER_RATE_BURST`), which would otherwise make a
 * measured call early-return instead of fanning out. `send` is a no-op counter,
 * so the member sockets don't accumulate frames across iterations (the cost under
 * test is the owner's loop, not client recv).
 */

const TOPIC = "bench-topic";
const ENVELOPE = JSON.stringify({ data: { x: 1, y: 2 }, topic: TOPIC, type: "whisper" });
const SENDER_POOL = 16_384;

class FakeSocket {
    public sent = 0;

    private attachment: unknown;

    public constructor(initial?: unknown) {
        this.attachment = initial;
    }

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    public send(_data: string): void {
        this.sent += 1;
    }

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

class WhisperBenchShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- abstract stub; the whisper path never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }
}

interface FanoutRig {
    next: () => WebSocket;
    shard: WhisperBenchShard;
}

const buildRig = (n: number): FanoutRig => {
    const members: FakeSocket[] = [];
    for (let index = 0; index < n; index += 1) {
        members.push(new FakeSocket({ subs: {}, whispers: [TOPIC] }));
    }

    const senders: FakeSocket[] = [];
    for (let index = 0; index < SENDER_POOL; index += 1) {
        senders.push(new FakeSocket({ subs: {} }));
    }

    const state = {
        acceptWebSocket() {},
        getWebSockets: () => members,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    let cursor = 0;
    const next = (): WebSocket => {
        const sender = senders[cursor % SENDER_POOL];
        cursor += 1;

        return sender as unknown as WebSocket;
    };

    return { next, shard: new WhisperBenchShard(state, {}) };
};

const defineFanoutBench = (n: number): void => {
    describe(`whisper fan-out — ${String(n)} subscribers`, () => {
        let rig: FanoutRig;

        // CodSpeed's instrumented runner honors beforeAll but not module-top-level
        // state, so the rig is built here.
        beforeAll(() => {
            rig = buildRig(n);
        });

        bench(`broadcastWhisper to ${String(n)} members`, async () => {
            await rig.shard.webSocketMessage(rig.next(), ENVELOPE);
        });
    });
};

defineFanoutBench(128);
defineFanoutBench(1024);
