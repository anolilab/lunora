import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeIdentityHeader } from "../../../shared/identity-header";
import { defineAgent } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentRunFunction } from "../src/types";
import VoiceSessionDO from "../src/voice-do";
import type { VoiceAudioSource } from "../src/voice-turn";

/** The `DurableObjectState` shape the voice DO consumes. */
interface VoiceSessionStateDouble {
    acceptWebSocket: (ws: unknown) => void;
    getWebSockets: () => never[];
    waitUntil?: (promise: Promise<unknown>) => void;
}

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

/**
 * Subclass overriding the AI seams so a turn completes without a real Workers AI
 * binding, and counts how many utterances/synthesis calls actually reached the
 * seam (i.e. how many times a turn — including a greeting — actually spoke).
 *
 * `resolveRun` is overridden too: the real one builds a dispatch runner that has
 * no bindings here and throws on the FIRST `agents:*` call. That used to happen
 * after transcription, so `transcribedPcmLengths` doubled as "the turn ran"; the
 * owner gate (`agentEnsureThread`) now runs BEFORE the paid transcription, so
 * the tests need a dispatch seam that answers instead of one that throws.
 */
class TestVoiceDO extends VoiceSessionDO {
    public dispatched: string[] = [];

    public synthesizeCalls = 0;

    public transcribedPcmLengths: number[] = [];

    protected override async transcribe(pcm: Uint8Array): Promise<string> {
        this.transcribedPcmLengths.push(pcm.byteLength);

        return "test utterance";
    }

    protected override async synthesize(_text: string): Promise<VoiceAudioSource> {
        this.synthesizeCalls += 1;

        return new Uint8Array([1]);
    }

    protected override resolveRun(): AgentRunFunction {
        return async (reference, _args) => {
            const path = reference["__lunoraRef"];

            this.dispatched.push(path);

            if (path === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread) {
                // Mirrors the real mutation: the first caller CREATES the thread,
                // every later one CONTINUES it.
                const first = this.dispatched.filter((entry) => entry === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread).length === 1;

                return { outcome: first ? "created" : "continued" };
            }

            if (path === DEFAULT_AGENT_FUNCTION_PATHS.listMessages) {
                return [];
            }

            return undefined;
        };
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

    describe("checked at upgrade (before ready/greeting)", () => {
        it("drops an already-expired credential at upgrade, before ready and before the greeting ever runs", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            // A greeting is configured, so — pre-fix — `fetch()` would
            // unconditionally schedule `speakGreeting` via `waitUntil` after
            // sending `ready`, running a full LLM+TTS turn under an already-lapsed
            // credential.
            const greetingAgent = defineAgent({
                instructions: "Be brief.",
                model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                voice: { greeting: "Hello! How can I help you today?" },
            });

            const waited: Promise<unknown>[] = [];
            const state = {
                acceptWebSocket: () => {
                    /* no-op: the fake socket needs no host-side registration */
                },
                getWebSockets: () => [],
                waitUntil: (promise: Promise<unknown>) => {
                    waited.push(promise);
                },
            };

            const instance = new TestVoiceDO(state, env, greetingAgent, "support");

            const sent: unknown[] = [];
            let closed: { code?: number; reason?: string } | undefined;
            const server = {
                close: (code?: number, reason?: string) => {
                    closed = { code, reason };
                },
                send: (data: unknown) => {
                    sent.push(data);
                },
                serializeAttachment: () => {
                    throw new Error("must not stamp an attachment for a credential already expired at upgrade");
                },
            };

            const globalWithPair = globalThis as { WebSocketPair?: unknown };
            const original = globalWithPair.WebSocketPair;

            globalWithPair.WebSocketPair = function WebSocketPair() {
                return { 0: {}, 1: server } as unknown;
            };

            try {
                instance.fetch(
                    new Request("https://do.internal/?threadKey=t1", {
                        headers: new Headers({ Upgrade: "websocket", "x-lunora-identity-exp": String(now - 1) }),
                    }),
                );
            } catch (error) {
                if (!(error instanceof RangeError)) {
                    throw error;
                }
            } finally {
                globalWithPair.WebSocketPair = original;
            }

            // Only the TOKEN_EXPIRED frame was sent — never `ready`, never a greeting frame.
            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0] as string)).toStrictEqual({
                code: "TOKEN_EXPIRED",
                error: { code: "TOKEN_EXPIRED", message: "authentication token expired" },
                // The voice contract reads the reason off a bare top-level `message`
                // (`VoiceServerFrame`); `error.code`/`error.message` is the shard
                // envelope. Both ride the frame so either reader gets the reason.
                message: "authentication token expired",
                type: "error",
            });
            expect(closed).toStrictEqual({ code: 4001, reason: "token_expired" });

            // The greeting was never scheduled at all (no `waitUntil` call), so no
            // LLM/TTS turn ran and no thread write was ever attempted.
            expect(waited).toHaveLength(0);
            expect(instance.synthesizeCalls).toBe(0);
            expect(instance.transcribedPcmLengths).toStrictEqual([]);
        });

        it("still sends ready and schedules the greeting for a non-expired credential (no regression)", async () => {
            const now = Date.now();

            vi.setSystemTime(now);

            const greetingAgent = defineAgent({
                instructions: "Be brief.",
                model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                voice: { greeting: "Hello! How can I help you today?" },
            });

            const waited: Promise<unknown>[] = [];
            const state = {
                acceptWebSocket: () => {
                    /* no-op: the fake socket needs no host-side registration */
                },
                getWebSockets: () => [],
                waitUntil: (promise: Promise<unknown>) => {
                    waited.push(promise);
                },
            };

            const instance = new TestVoiceDO(state, env, greetingAgent, "support");

            const sent: unknown[] = [];
            const server = {
                close: () => {
                    /* not expected to be called */
                },
                send: (data: unknown) => {
                    sent.push(data);
                },
                serializeAttachment: () => {
                    /* stamped — irrelevant to this assertion */
                },
            };

            const globalWithPair = globalThis as { WebSocketPair?: unknown };
            const original = globalWithPair.WebSocketPair;

            globalWithPair.WebSocketPair = function WebSocketPair() {
                return { 0: {}, 1: server } as unknown;
            };

            try {
                instance.fetch(
                    new Request("https://do.internal/?threadKey=t1", {
                        headers: new Headers({ Upgrade: "websocket", "x-lunora-identity-exp": String(now + 60_000) }),
                    }),
                );
            } catch (error) {
                if (!(error instanceof RangeError)) {
                    throw error;
                }
            } finally {
                globalWithPair.WebSocketPair = original;
            }

            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0] as string)).toMatchObject({ type: "ready" });
            expect(waited).toHaveLength(1);

            // Let the scheduled greeting settle before asserting on it — it dispatches
            // through the real `run` seam, which has no bindings in this test env and
            // is expected to fail; only that it was ATTEMPTED matters here.
            await Promise.allSettled(waited);
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
                // The voice contract reads the reason off a bare top-level `message`
                // (`VoiceServerFrame`); `error.code`/`error.message` is the shard
                // envelope. Both ride the frame so either reader gets the reason.
                message: "authentication token expired",
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

/** How many turns actually reached the shared thread (one `ensureThread` per turn). */
const turnsRun = (instance: TestVoiceDO): number => instance.dispatched.filter((path) => path === DEFAULT_AGENT_FUNCTION_PATHS.ensureThread).length;

/** A `waitUntil`-capturing state double, for the `fetch()` paths that schedule a greeting. */
const waitingState = (): { state: VoiceSessionStateDouble; waited: Promise<unknown>[] } => {
    const waited: Promise<unknown>[] = [];

    return {
        state: {
            acceptWebSocket: () => {
                /* no-op: the fake socket needs no host-side registration */
            },
            getWebSockets: () => [],
            waitUntil: (promise: Promise<unknown>) => {
                waited.push(promise);
            },
        },
        waited,
    };
};

describe("voice session resource bounds", () => {
    it("caps how many turns one socket may run, then closes it", async () => {
        const capped = defineAgent({ instructions: "Be brief.", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", voice: { maxTurns: 3 } });
        const instance = new TestVoiceDO(fakeState(), env, capped, "support");
        const { getClosed, sent, ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        // The only guard was one-turn-in-flight per connection, which throttles
        // nothing: 50 sequential turns were accepted with no rate-limit frame,
        // each a full LLM generation plus sentence-by-sentence TTS, billed and
        // persisted, on a hibernatable socket that can live for days.
        for (let index = 0; index < 50; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential turns are the point
            await instance.webSocketMessage(ws, JSON.stringify({ text: "hello", type: "text" }));
        }

        expect(turnsRun(instance)).toBe(3);
        expect(getClosed()).toStrictEqual({ code: 4002, reason: "turn_limit" });
        expect(sent.map((raw) => (JSON.parse(raw as string) as { type: string }).type)).toContain("error");
    });

    it("rejects an oversized text frame before it reaches the model", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { sent, ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        // A 500k-character `text` frame reached the LLM unmeasured.
        await instance.webSocketMessage(ws, JSON.stringify({ text: "x".repeat(500_000), type: "text" }));

        expect(turnsRun(instance)).toBe(0);
        expect(JSON.parse(sent[0] as string)).toMatchObject({ type: "error" });
    });

    it("rejects an oversized RAW control frame before parsing it", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { getClosed, sent, ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        // Not valid JSON, so the only thing that can react to it is a check that
        // runs BEFORE `JSON.parse`. The `text` bound is measured on the parsed
        // frame, so the 32MiB string message Cloudflare will deliver was parsed
        // in full first — once per frame, on the DO's single thread.
        await instance.webSocketMessage(ws, `{"type":"text","text":"${"x".repeat(32 * 1024 * 1024)}`);

        expect(JSON.parse(sent[0] as string)).toMatchObject({ type: "error" });
        expect(getClosed()).toStrictEqual({ code: 4004, reason: "control_frame_limit" });
    });

    it("still runs a text frame within the cap", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        await instance.webSocketMessage(ws, JSON.stringify({ text: "hello", type: "text" }));

        expect(turnsRun(instance)).toBe(1);
    });

    it("closes the socket when the utterance buffer overflows instead of resetting the counter", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { getClosed, sent, ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });
        const megabyte = new ArrayBuffer(1024 * 1024);

        // Dropping BOTH maps on overflow reset the counter, so the 8MB cap bounded
        // peak memory and not throughput: 40MB pushed through produced 4 error
        // frames and left the socket open to push 40 more. The loop stops at the
        // close because the runtime delivers no frame after one.
        let delivered = 0;

        for (let index = 0; index < 40 && getClosed() === undefined; index += 1) {
            delivered += 1;
            // eslint-disable-next-line no-await-in-loop -- sequential frames are the point
            await instance.webSocketMessage(ws, megabyte);
        }

        expect(getClosed()).toStrictEqual({ code: 4003, reason: "utterance_too_large" });
        expect(delivered).toBe(9);
        expect(sent).toHaveLength(1);
    });

    it("synthesizes the greeting once per THREAD, not once per upgrade", async () => {
        const greetingAgent = defineAgent({
            instructions: "Be brief.",
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            voice: { greeting: "Hello! How can I help you today?" },
        });
        const { state, waited } = waitingState();
        const instance = new TestVoiceDO(state, env, greetingAgent, "support");

        for (let index = 0; index < 20; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential upgrades are the point
            await upgradeAndCaptureAttachment(instance, "https://do.internal/?threadKey=t1");
        }

        await Promise.allSettled(waited);

        // The greeting's persisted row is already keyed once per thread; the paid
        // TTS synthesis was not — 20 reconnects bought 20 syntheses of one line.
        expect(waited).toHaveLength(20);
        expect(instance.synthesizeCalls).toBe(1);
    });
});

describe("voice socket lifecycle", () => {
    it("frees a socket's buffered utterance on close (webSocketClose)", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        await instance.webSocketMessage(ws, new ArrayBuffer(1024));
        instance.webSocketClose(ws);

        // The buffer is gone, so a later commit transcribes an EMPTY utterance.
        await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

        expect(instance.transcribedPcmLengths).toStrictEqual([0]);
    });

    it("frees a socket's buffered utterance on error (webSocketError)", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        await instance.webSocketMessage(ws, new ArrayBuffer(1024));
        instance.webSocketError(ws);
        await instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

        expect(instance.transcribedPcmLengths).toStrictEqual([0]);
    });

    it("refuses an overlapping trigger while a turn is in flight", async () => {
        const instance = new TestVoiceDO(fakeState(), env, agent, "support");
        const { sent, ws } = createFakeSocket({ connectionId: "c1", threadKey: "t1", turn: 0 });

        const inFlight = instance.webSocketMessage(ws, JSON.stringify({ type: "commit" }));

        await instance.webSocketMessage(ws, JSON.stringify({ text: "and another thing", type: "text" }));
        await inFlight;

        expect(turnsRun(instance)).toBe(1);
        expect(sent.map((raw) => (JSON.parse(raw as string) as { message?: string }).message)).toContainEqual(
            "a turn is already in progress — send an interrupt before the next utterance",
        );
    });
});
