/**
 * The per-socket subscription cap against the budget it claims to respect.
 *
 * `MAX_SUBSCRIPTIONS_PER_SOCKET` is documented as a derivation — 2048 bytes of
 * `serializeAttachment`, ~200 bytes per registration, so a full attachment fits
 * at 8 and could not at the old ceiling of 32. None of that arithmetic was
 * asserted anywhere, so the number was free to drift away from its own
 * justification (or the justification away from the runtime's limit).
 *
 * Measured with `node:v8`'s serializer, which writes the same V8
 * structured-clone format workerd's `serializeAttachment` does — the byte count
 * here is the one the runtime checks against 2048, give or take a few bytes of
 * envelope.
 */
import { serialize } from "node:v8";

import type { SocketAttachment } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { ShardDO } from "../src/shard-do";

/** The runtime's hard ceiling on a hibernation attachment. */
const SERIALIZE_ATTACHMENT_BUDGET_BYTES = 2048;

const cap = (ShardDO as unknown as { MAX_SUBSCRIPTIONS_PER_SOCKET: number }).MAX_SUBSCRIPTIONS_PER_SOCKET;

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

describe("mAX_SUBSCRIPTIONS_PER_SOCKET", () => {
    it("leaves a plain socket's full attachment inside the serializeAttachment budget", () => {
        expect.assertions(2);

        expect(cap).toBe(8);
        expect(serialize(plainSocket(cap)).byteLength).toBeLessThanOrEqual(SERIALIZE_ATTACHMENT_BUDGET_BYTES);
    });

    it("costs the ~200 bytes per registration the ceiling is derived from", () => {
        expect.assertions(2);

        const perRecord = (serialize(plainSocket(cap + 4)).byteLength - serialize(plainSocket(cap)).byteLength) / 4;

        expect(perRecord).toBeGreaterThan(150);
        expect(perRecord).toBeLessThan(250);
    });

    it("is why the previous ceiling of 32 was unreachable", () => {
        expect.assertions(1);

        // A socket allowed 32 registrations would have failed the serialize long
        // before reaching them, one `SUBSCRIPTION_PERSIST_FAILED` at a time.
        expect(serialize(plainSocket(32)).byteLength).toBeGreaterThan(SERIALIZE_ATTACHMENT_BUDGET_BYTES);
    });

    it("does not on its own bound a socket carrying identity, context and whispers", () => {
        expect.assertions(1);

        // The count cap is a guard, not the bound: enough fixed fields and the
        // attachment overflows before the 8th registration. That case is caught
        // where it actually binds — `subscribe`/`shapeSubscribe` roll the
        // registry back on a serialize throw and answer
        // `SUBSCRIPTION_PERSIST_FAILED`.
        expect(serialize(decoratedSocket(cap)).byteLength).toBeGreaterThan(SERIALIZE_ATTACHMENT_BUDGET_BYTES);
    });
});
