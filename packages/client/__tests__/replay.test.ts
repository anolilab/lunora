/**
 * The durable-write replay policy, and the two error contracts it reads.
 *
 * Both used to be private conventions of `lunora-client.ts`: a `Symbol` stamped
 * onto a thrown error to smuggle "the server reached no verdict" past `code`,
 * and a second top-level `error.retryAfterMs` that existed only because the
 * runtime's REST limiter sends its hint as a header. Nothing outside the one
 * classifier could see either. These assertions pin the replacements — an error
 * KIND, and one retry-hint channel.
 */
import { describe, expect, it, vi } from "vitest";

import { getRetryAfterMs, TransportError } from "../src/errors";
import { LunoraClient } from "../src/lunora-client";
import { isTransientReplayFailure, MAX_BATCH_BODY_BYTES, replayRetryDelayMs, retryAfterHeaderMs, utf8ByteLength } from "../src/replay";
import type { FunctionReference } from "../src/types";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

class NoopSocket {
    public readonly readyState = 0;
}

const client = (fetchImpl: typeof fetch): LunoraClient =>
    new LunoraClient({ fetch: fetchImpl, url: "https://app.example", WebSocket: NoopSocket as unknown as typeof WebSocket });

const rejection = async (fetchImpl: typeof fetch): Promise<unknown> =>
    await client(fetchImpl)
        .mutation(fnRef("docs:write"), {})
        .catch((error: unknown) => error);

describe("transportError", () => {
    it("is the kind an edge 502 page arrives as, visible to every reader", async () => {
        expect.assertions(3);

        // A gateway page: JSON parse fails, so there is no `{ error }` envelope
        // and the server reached no verdict on the write.
        const error = await rejection(vi.fn<typeof fetch>(async () => new Response("<html>502</html>", { status: 502 })));

        expect(error).toBeInstanceOf(TransportError);
        // Still an `INTERNAL` on the wire — the kind is what carries the extra
        // fact, so nothing downstream that reads `code` has to change.
        expect(error).toMatchObject({ code: "INTERNAL" });
        expect(isTransientReplayFailure(error)).toBe(true);
    });

    it("is NOT how a coded server verdict arrives", async () => {
        expect.assertions(2);

        const error = await rejection(vi.fn<typeof fetch>(async () => Response.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 })));

        expect(error).not.toBeInstanceOf(TransportError);
        expect(isTransientReplayFailure(error)).toBe(false);
    });
});

describe("retry hint channel", () => {
    it("folds a `Retry-After` header into `data.retryAfterMs`, the one channel", async () => {
        expect.assertions(2);

        const error = await rejection(
            vi.fn<typeof fetch>(async () =>
                Response.json({ error: { code: "TOO_MANY_REQUESTS", message: "slow down" } }, { headers: { "retry-after": "3" }, status: 429 }),
            ),
        );

        // `getRetryAfterMs` is the public reader (`@lunora/client`'s `errors.ts`)
        // and reads `data.retryAfterMs` only — a hint written anywhere else is a
        // hint no app can see.
        expect(getRetryAfterMs(error)).toBe(3000);
        expect(replayRetryDelayMs(error, 1)).toBe(3000);
    });

    it("lets the envelope's own hint win over the header", async () => {
        expect.assertions(1);

        const error = await rejection(
            vi.fn<typeof fetch>(async () =>
                Response.json(
                    { error: { code: "TOO_MANY_REQUESTS", data: { retryAfterMs: 250 }, message: "slow down" } },
                    {
                        headers: { "retry-after": "3" },
                        status: 429,
                    },
                ),
            ),
        );

        expect(getRetryAfterMs(error)).toBe(250);
    });

    it("clamps a hint no queue should wait out", () => {
        expect.assertions(2);

        expect(retryAfterHeaderMs("3600")).toBe(3_600_000);
        expect(replayRetryDelayMs({ data: { retryAfterMs: 3_600_000 } }, 1)).toBe(60_000);
    });

    it("parses both `Retry-After` forms RFC 9110 defines", () => {
        expect.assertions(4);

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

        // delta-seconds (what the runtime's REST limiter sends)...
        expect(retryAfterHeaderMs("2")).toBe(2000);
        // ...and the HTTP-date a proxy in front of it sends instead.
        expect(retryAfterHeaderMs("Thu, 01 Jan 2026 00:00:02 GMT")).toBe(2000);
        // A date already in the past asks for nothing, and an unparseable value
        // must read as "no hint" rather than as `NaN`, which every downstream
        // comparison silently answers `false` to.
        expect(retryAfterHeaderMs("Thu, 01 Jan 2026 00:00:00 GMT")).toBeUndefined();
        expect(retryAfterHeaderMs("soon-ish")).toBeUndefined();

        vi.useRealTimers();
    });
});

describe("hintless backoff", () => {
    it("still schedules a retry for a refusal that carried no hint", () => {
        expect.assertions(4);

        const half = (): number => 0.5;

        // 1000ms base * (0.5 + 0.5 * 0.5); the second consecutive failure
        // doubles the ceiling, and the whole ramp is capped.
        expect(replayRetryDelayMs({ code: "TOO_MANY_REQUESTS" }, 1, half)).toBe(750);
        expect(replayRetryDelayMs({ code: "SHARD_UNAVAILABLE" }, 2, half)).toBe(1500);
        expect(replayRetryDelayMs(new TransportError("502 page"), 99, half)).toBe(45_000);
        // Jittered, not fixed: two clients refused at the same instant do not
        // come back at the same instant.
        expect(replayRetryDelayMs({ code: "RATE_LIMITED" }, 1, () => 0)).toBe(500);
    });

    it("schedules nothing for a `fetch` that never reached a server", () => {
        expect.assertions(1);

        // Offline: the reconnect that follows flushes the queue anyway, so a
        // timer here would only re-run a request that cannot leave the device.
        expect(replayRetryDelayMs(new TypeError("Failed to fetch"), 1)).toBeUndefined();
    });
});

describe("batch body budget", () => {
    it("measures UTF-8 bytes, not code units", () => {
        expect.assertions(2);

        expect(utf8ByteLength("é")).toBe(2);
        expect(MAX_BATCH_BODY_BYTES).toBe(1_048_576 - 65_536);
    });
});
