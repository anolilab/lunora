/**
 * The per-socket subscription cap against the budget it claims to respect.
 *
 * Two numbers, and the file exists because they had drifted apart:
 * `MAX_ATTACHMENT_BYTES` is the runtime's hard ceiling on a hibernation
 * attachment, and `MAX_SUBSCRIPTIONS_PER_SOCKET` is a coarse fan-out backstop
 * that must sit comfortably UNDER it for a realistic socket. The cap was once
 * derived from a 2048-byte budget the runtime does not impose, which put it at
 * 8 — low enough to break an app holding a dozen live queries on one socket,
 * and low enough that the derivation could not be checked against anything.
 *
 * Measured with `node:v8`'s serializer, which writes the same V8
 * structured-clone format workerd's `serializeAttachment` does — the byte count
 * here is the one the runtime checks, give or take a few bytes of envelope. The
 * ceiling itself is measured against the live runtime in
 * `__tests__/workerd/shard-do.workerd.test.ts`; this file only has to agree
 * with it.
 */
import { serialize } from "node:v8";

import type { SocketAttachment } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { ShardDO } from "../src/shard-do";

const internals = ShardDO as unknown as { MAX_ATTACHMENT_BYTES: number; MAX_SUBSCRIPTIONS_PER_SOCKET: number };

const cap = internals.MAX_SUBSCRIPTIONS_PER_SOCKET;
const budget = internals.MAX_ATTACHMENT_BYTES;

/**
 * A realistic registration: a `<file>:<function>` path, one id argument, a
 * limit, a resume cursor and an epoch uuid — what a paginated live query
 * actually registers.
 */
const subscription = (index: number): SocketAttachment["subs"][string] => {
    return {
        args: { conversationId: `cnv_aaaaaaaaaaaaaaaaaaaaaaaa${String(index).padStart(2, "0")}`, limit: 50 },
        functionPath: "messages:listForConversation",
        sinceEpoch: "8f14e45f-ceea-467a-9575-3b2f1c0d4e6a",
        sinceSeq: 918_273_645,
        table: "messages",
    };
};

const subs = (count: number): SocketAttachment["subs"] =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`sub-${String(index)}`, subscription(index)]));

/** The common case: an authenticated socket with no app context and no whisper topics. */
const plainSocket = (count: number): SocketAttachment => {
    return {
        clientId: "c1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b",
        connected: true,
        connectionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        subs: subs(count),
        userId: "user_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
};

/** The same socket with every optional field populated — identity claims, app context, whisper topics. */
const decoratedSocket = (count: number): SocketAttachment => {
    return {
        ...plainSocket(count),
        context: { locale: "en-GB", roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaa", sessionId: "sess_aaaaaaaaaaaaaaaaaaaaaaaaaa" },
        expiresAt: 1_893_456_000_000,
        identity: { email: "person@example.com", org: "org_aaaaaaaaaaaaaaaaaaaaaaaaaa", role: "member", sub: "user_aaaaaaaaaaaaaaaaaaaaaaaaaa" },
        pageDeltas: true,
        whispers: ["presence:room_aaaaaaaaaaaaaaaaaaaaaaaaaa", "typing:room_aaaaaaaaaaaaaaaaaaaaaaaaaa"],
    };
};

describe("subscription budget", () => {
    it("agrees with the ceiling the runtime actually enforces", () => {
        expect.assertions(1);

        // Not a doc-page number: 16385 bytes throws in workerd and 8192 does
        // not. The workerd leg measures it; this pins what the shard was built
        // against so the two cannot drift apart silently.
        expect(budget).toBe(16_384);
    });

    it("costs the ~200 bytes per registration the cap is sized against", () => {
        expect.assertions(2);

        const perRecord = (serialize(plainSocket(cap + 4)).byteLength - serialize(plainSocket(cap)).byteLength) / 4;

        expect(perRecord).toBeGreaterThan(150);
        expect(perRecord).toBeLessThan(250);
    });

    it("leaves a fully decorated socket filled to the cap well inside the budget", () => {
        expect.assertions(2);

        // The justification for the number, stated as an assertion. The worst
        // realistic socket — identity claims, app `context`, whisper topics AND
        // a full set of paginated registrations — has to fit, or the cap is a
        // wall an app meets in production with no way around it.
        const worst = serialize(decoratedSocket(cap)).byteLength;

        expect(cap).toBe(32);
        expect(worst).toBeLessThan(budget / 2);
    });

    it("would not have fitted a dozen live queries at the old ceiling of 8", () => {
        expect.assertions(2);

        // The regression this file exists to prevent. 12 live queries on one
        // socket is an ordinary dashboard, it costs ~2.8 KB, and the runtime
        // takes it without complaint — the only thing that ever refused it was
        // the count cap.
        expect(serialize(plainSocket(12)).byteLength).toBeLessThan(budget);
        expect(cap).toBeGreaterThanOrEqual(12);
    });

    it("is a backstop, not the bound — the byte budget is what binds", () => {
        expect.assertions(1);

        // No fixed count can bound a record whose `args` the client chooses:
        // enough of them, or fat enough, and the attachment overflows at any
        // cap. That case is caught where it actually binds —
        // `persistAttachment` refuses over `MAX_ATTACHMENT_BYTES`, and
        // `subscribe`/`shapeSubscribe` roll the registry back and answer
        // `SUBSCRIPTION_PERSIST_FAILED`.
        expect(serialize(plainSocket(cap * 4)).byteLength).toBeGreaterThan(budget);
    });
});
