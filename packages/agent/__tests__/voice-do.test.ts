import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeIdentityHeader } from "../../../shared/identity-header";
import { defineAgent } from "../src/define-agent";
import VoiceSessionDO from "../src/voice-do";
import type { VoiceAudioSource } from "../src/voice-turn";

/** Structural double of `DurableObjectState` — accepts the socket, never actually hibernates. */
const fakeState = (): { acceptWebSocket: (ws: unknown) => void; getWebSockets: () => never[] } => {
    return {
        acceptWebSocket: () => {
            /* no-op: the fake socket needs no host-side registration */
        },
        getWebSockets: () => [],
    };
};

/**
 * A hibernation-attachment-carrying fake socket. `serializeAttachment` /
 * `deserializeAttachment` read and write the SAME closure variable, so the DO's
 * own re-serialize-on-finally (`runTurn`'s `{ ...attachment, turn: turn + 1 }`)
 * round-trips exactly as it does against a real hibernatable WebSocket.
 */
const createFakeSocket = (
    initial: Record<string, unknown>,
    options: { throwOnClose?: boolean; throwOnSend?: boolean } = {},
): {
    getAttachment: () => Record<string, unknown>;
    getClosed: () => { code?: number; reason?: string } | undefined;
    sent: unknown[];
    setAttachment: (value: Record<string, unknown>) => void;
    ws: WebSocket;
} => {
    let attachment = initial;
    const sent: unknown[] = [];
    let closed: { code?: number; reason?: string } | undefined;

    const ws = {
        close: (code?: number, reason?: string) => {
            if (options.throwOnClose) {
                throw new Error("socket already gone");
            }

            closed = { code, reason };
        },
        deserializeAttachment: () => attachment,
        send: (data: unknown) => {
            if (options.throwOnSend) {
                throw new Error("socket already gone");
            }

            sent.push(data);
        },
        serializeAttachment: (value: unknown) => {
            attachment = value as Record<string, unknown>;
        },
    };

    return {
        getAttachment: () => attachment,
        getClosed: () => closed,
        sent,
        setAttachment: (value: Record<string, unknown>) => {
            attachment = value;
        },
        ws: ws as unknown as WebSocket,
    };
};

/** A voice-enabled agent with no greeting (so `fetch()` never schedules `speakGreeting`). */
const agent = defineAgent({ instructions: "Be brief.", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", voice: {} });
// `createAi` requires an `AI` binding at construction time — the fake is never
// actually called because `TestVoiceDO` overrides `transcribe`/`synthesize`.
const env: Record<string, unknown> = {
    AI: {
        run: async () => {
            throw new Error("unexpected real AI call — TestVoiceDO should have overridden the seam that reached this");
        },
    },
};

/** Subclass overriding the AI seams so a turn completes without a real Workers AI binding, and counts how many utterances actually reached transcription. */
class TestVoiceDO extends VoiceSessionDO {
    public transcribedPcmLengths: number[] = [];

    protected override async transcribe(pcm: Uint8Array): Promise<string> {
        this.transcribedPcmLengths.push(pcm.byteLength);

        return "test utterance";
    }

    // eslint-disable-next-line class-methods-use-this -- structural override matching the base class's instance-method signature; this test double needs no instance state
    protected override async synthesize(_text: string): Promise<VoiceAudioSource> {
        return new Uint8Array([1]);
    }
}

/** Upgrade `instance` and capture the stamped hibernation attachment (mirrors `shard-do.admin-subscription.test.ts`'s pattern for the same Node/workerd gap). */
const upgradeAndCaptureAttachment = async (
    instance: VoiceSessionDO,
    url: string,
    headers?: Record<string, string>,
): Promise<Record<string, unknown> | undefined> => {
    let captured: Record<string, unknown> | undefined;
    const server = {
        send: () => {
            /* the "ready" frame — irrelevant to attachment capture */
        },
        serializeAttachment: (value: unknown) => {
            captured = value as Record<string, unknown>;
        },
    };

    const globalWithPair = globalThis as { WebSocketPair?: unknown };
    const original = globalWithPair.WebSocketPair;

    globalWithPair.WebSocketPair = function WebSocketPair() {
        return { 0: {}, 1: server } as unknown;
    };

    try {
        // The attachment is stamped before `new Response(null, { status: 101 })`,
        // which Node's Response rejects (101 is out of its allowed range) — that
        // throw is expected here, `captured` is already set by then. `fetch()` is
        // synchronous (not `Promise`-returning), so this throw is synchronous too.
        instance.fetch(new Request(url, { headers: new Headers({ Upgrade: "websocket", ...headers }) }));
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
    } finally {
        globalWithPair.WebSocketPair = original;
    }

    return captured;
};

describe("voice session credential expiry", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("captured at upgrade", () => {
        it("stamps expiresAt from a valid x-lunora-identity-exp header", async () => {
            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const exp = Date.now() + 60_000;

            const attachment = await upgradeAndCaptureAttachment(instance, "https://do.internal/?threadKey=t1", { "x-lunora-identity-exp": String(exp) });

            expect(attachment?.["expiresAt"]).toBe(exp);
        });

        it("stamps no expiresAt when the header is absent", async () => {
            const instance = new TestVoiceDO(fakeState(), env, agent, "support");

            const attachment = await upgradeAndCaptureAttachment(instance, "https://do.internal/?threadKey=t1");

            expect(attachment).not.toHaveProperty("expiresAt");
        });

        it.each(["abc", "0", "-5", ""])("stamps no expiresAt for a malformed header (%s)", async (raw) => {
            const instance = new TestVoiceDO(fakeState(), env, agent, "support");

            const attachment = await upgradeAndCaptureAttachment(instance, "https://do.internal/?threadKey=t1", { "x-lunora-identity-exp": raw });

            expect(attachment).not.toHaveProperty("expiresAt");
        });

        it("still carries identity/userId alongside expiresAt", async () => {
            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const exp = Date.now() + 60_000;

            const attachment = await upgradeAndCaptureAttachment(instance, "https://do.internal/?threadKey=t1", {
                "x-lunora-identity": encodeIdentityHeader({ claims: { sub: "user-1" } }),
                "x-lunora-identity-exp": String(exp),
                "x-lunora-userid": "user-1",
            });

            expect(attachment?.["expiresAt"]).toBe(exp);
            expect(attachment?.["userId"]).toBe("user-1");
        });
    });

    describe("enforced at webSocketMessage", () => {
        it("drops an expired socket on a control frame with TOKEN_EXPIRED/4001, never running the turn", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { getClosed, sent, ws } = createFakeSocket({ connectionId: "c1", expiresAt: now - 1, threadKey: "t1", turn: 0 });

            await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0] as string)).toStrictEqual({
                code: "TOKEN_EXPIRED",
                error: { code: "TOKEN_EXPIRED", message: "authentication token expired" },
                type: "error",
            });
            expect(getClosed()).toStrictEqual({ code: 4001, reason: "token_expired" });
            expect(instance.transcribedPcmLengths).toStrictEqual([]);
        });

        it("drops an expired socket on a text turn frame the same way", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { getClosed, sent, ws } = createFakeSocket({ connectionId: "c1", expiresAt: now - 1, threadKey: "t1", turn: 0 });

            await instance.webSocketMessage(ws, JSON.stringify({ text: "hello", type: "text" }));

            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0] as string)).toMatchObject({ code: "TOKEN_EXPIRED" });
            expect(getClosed()).toStrictEqual({ code: 4001, reason: "token_expired" });
        });

        it("gates binary audio frames the same way — no audio is buffered while expired", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { getClosed, sent, setAttachment, ws } = createFakeSocket({ connectionId: "c1", expiresAt: now - 1, threadKey: "t1", turn: 0 });

            await instance.webSocketMessage(ws, new ArrayBuffer(4));

            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0] as string)).toMatchObject({ code: "TOKEN_EXPIRED" });
            expect(getClosed()).toStrictEqual({ code: 4001, reason: "token_expired" });

            // Flip the credential to unexpired and commit — transcribe sees an
            // EMPTY utterance, proving the binary frame above was never buffered.
            setAttachment({ connectionId: "c1", expiresAt: now + 60_000, threadKey: "t1", turn: 0 });
            await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

            expect(instance.transcribedPcmLengths).toStrictEqual([0]);
        });

        it("treats expiresAt === Date.now() as expired (boundary, matching ShardDO's >=)", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { getClosed, ws } = createFakeSocket({ connectionId: "c1", expiresAt: now, threadKey: "t1", turn: 0 });

            await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

            expect(getClosed()).toStrictEqual({ code: 4001, reason: "token_expired" });
            expect(instance.transcribedPcmLengths).toStrictEqual([]);
        });

        it("lets frames flow unchanged when no expiresAt is stamped (additive, no regression)", async () => {
            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { getClosed, ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

            await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

            expect(getClosed()).toBeUndefined();
            expect(instance.transcribedPcmLengths).toStrictEqual([0]);
        });

        it("lets frames flow when expiresAt is in the future", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { getClosed, ws } = createFakeSocket({ connectionId: "c1", expiresAt: now + 60_000, threadKey: "t1", turn: 0 });

            await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

            expect(getClosed()).toBeUndefined();
            expect(instance.transcribedPcmLengths).toStrictEqual([0]);
        });

        it("never throws even when the expired socket's send/close both throw", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const instance = new TestVoiceDO(fakeState(), env, agent, "support");
            const { ws } = createFakeSocket({ connectionId: "c1", expiresAt: now - 1, threadKey: "t1", turn: 0 }, { throwOnClose: true, throwOnSend: true });

            await expect(instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }))).resolves.toBeUndefined();
        });
    });
});
