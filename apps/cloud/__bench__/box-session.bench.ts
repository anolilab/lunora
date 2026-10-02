import type { HostdFrame } from "@lunora/hostd/protocol";
import { decodeBoxMessage } from "@lunora/hostd/protocol";
import { bench, describe } from "vitest";

import type { BoxKey } from "../__tests__/support/box-session-fakes";
import { boxRow, fakeSocket, fakeState, TestBoxSession } from "../__tests__/support/box-session-fakes";
import { memoryStore } from "../__tests__/support/memory-store";
import { JobRegistry, MAX_JOBS_IN_FLIGHT } from "../src/boxes/jobs";
import type { SessionAttachment, SessionPorts } from "../src/boxes/session";
import { FRAME_BUCKET, livenessOf, openSession, receiveFrame } from "../src/boxes/session";

/**
 * `BoxSessionDO`'s hot paths (plan 458 §8 perf watch), in plain node — no
 * workerd: every frame a box sends is decoded, rate-limited and routed by the
 * pure `receiveFrame`, every job is correlated by the `JobRegistry`, and every
 * liveness tick deserializes each hibernated socket's attachment.
 *
 * - **Frame decode** — `decodeBoxMessage` of a `progress` line and of a full
 *   `report` (500 aliases, the protocol's cap): the strict decoder every frame
 *   pays before anything else.
 * - **receiveFrame** — decode + the per-socket token bucket + the effect, for a
 *   ready socket's `progress`; and the refusal a flooding socket gets once its
 *   bucket is empty.
 * - **Job correlation** — a full box's worth of jobs (16 in flight): start,
 *   8 progress lines each, one result each.
 * - **1,000 hibernated sockets** — what waking costs per socket: deserialize
 *   each attachment and decide its liveness; and the session's own alarm over
 *   1,000 accepted sockets, pinging each (one session never holds more than
 *   four — this is the bound, not the norm). The attachments' size (memory)
 *   is held under a budget by `__tests__/box-session.test.ts`.
 */

const NOW = 1_700_000_000_000;
const JOB_ID = "6b1f9d2e-0c4a-4f7e-9b0d-3c2a1e5f7a90";

const progressFrame: HostdFrame = JSON.stringify({ jobId: JOB_ID, line: `celld: fleet web converged in 412 ms ${"·".repeat(64)}`, type: "progress" });
const reportFrame: HostdFrame = JSON.stringify({
    perAlias: Array.from({ length: 500 }, (_, index) => {
        return { alias: `app-${String(index)}`, errors: index % 7, p50Ms: 12, requests: 1000 + index };
    }),
    type: "report",
    windowEnd: NOW + 60_000,
    windowStart: NOW,
});

const ports: SessionPorts = { loadBox: () => Promise.resolve(null) };

/** A ready socket's attachment with a full bucket. */
const ready = (boxId: string, now = NOW): SessionAttachment => {
    return { ...openSession(boxId, now), phase: "ready" };
};

/** A ready socket whose bucket is empty: the next frame is a flood. */
const drained: SessionAttachment = { ...ready("box_1"), bucket: { refilledAt: NOW, tokens: 0 } };

describe("box frame decode", () => {
    bench("decodeBoxMessage — progress line", () => {
        decodeBoxMessage(progressFrame);
    });

    bench("decodeBoxMessage — report, 500 aliases", () => {
        decodeBoxMessage(reportFrame);
    });
});

/** The ready socket the `progress` bench feeds, and its clock. */
const progressSocket = { attachment: ready("box_1"), clock: NOW };

describe("box receiveFrame (decode + rate limit + effect)", () => {
    bench("ready socket — progress frame", async () => {
        // A frame per 250 ms keeps the bucket at its refill rate, so every frame is admitted.
        progressSocket.clock += 1000 / FRAME_BUCKET.refillPerSecond;
        const outcome = await receiveFrame(progressSocket.attachment, progressFrame, progressSocket.clock, ports);

        progressSocket.attachment = outcome.attachment;
    });

    bench("flooding socket — refused at an empty bucket", async () => {
        await receiveFrame(drained, progressFrame, NOW, ports);
    });
});

describe("box job correlation", () => {
    bench(`${String(MAX_JOBS_IN_FLIGHT)} jobs — start, 8 progress lines each, result`, async () => {
        const registry = new JobRegistry();
        const outcomes: Promise<unknown>[] = [];

        for (let job = 0; job < MAX_JOBS_IN_FLIGHT; job += 1) {
            outcomes.push(registry.start(`job-${String(job)}`, { onProgress: () => undefined, timeoutMs: 60_000 }));
        }

        for (let line = 0; line < 8; line += 1) {
            for (let job = 0; job < MAX_JOBS_IN_FLIGHT; job += 1) {
                registry.progress({ jobId: `job-${String(job)}`, line: "converging", type: "progress" });
            }
        }

        for (let job = 0; job < MAX_JOBS_IN_FLIGHT; job += 1) {
            registry.result({ jobId: `job-${String(job)}`, ok: true, type: "result" });
        }

        await Promise.all(outcomes);
    });
});

describe("1,000 hibernated box sockets", () => {
    const SOCKETS = 1000;
    const serialized = Array.from({ length: SOCKETS }, (_, index) => structuredClone(ready(`box_${String(index)}`, NOW - (index % 120) * 1000)));

    bench("deserialize every attachment and decide its liveness", () => {
        for (const attachment of serialized) {
            livenessOf(structuredClone(attachment), NOW);
        }
    });

    const state = fakeState();
    const session = new TestBoxSession(state, memoryStore({ boxes: [boxRow({ publicKey: "k" } as BoxKey, { status: "online" })] }));

    for (let index = 0; index < SOCKETS; index += 1) {
        // Seen "in the future", so however long the bench runs no socket goes silent and every tick pings all of them.
        state.acceptWebSocket(fakeSocket(ready("box_1", Date.now() + 86_400_000)));
    }

    bench("the session's liveness tick over 1,000 sockets", async () => {
        await state.storage.put("boxId", "box_1");
        await session.alarm();

        for (const socket of state.sockets) {
            socket.sent.length = 0;
        }
    });
});
