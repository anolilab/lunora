import { get } from "svelte/store";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { VoiceAgentHandle, VoiceAgentOptions, VoiceReference } from "../src/voice-agent";
import { voiceAgent } from "../src/voice-agent";
import { createFakeClient } from "./fake-client";

/** A server frame as it arrives on the socket (JSON control frame). */
type ServerFrame = Record<string, unknown>;

/** A fake WebSocket the test drives — records outbound frames and injects inbound ones. */
interface FakeSocket {
    binaryType: string;
    close: () => void;
    emitBinary: (bytes: Uint8Array) => void;
    emitServer: (frame: ServerFrame) => void;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;

    onopen: ((event: unknown) => void) | null;
    readyState: number;
    send: (data: unknown) => void;
    readonly sent: unknown[];
}

const makeVoiceRef = (reference: string): VoiceReference => {
    return { __lunoraRef: reference };
};

/** A promise the test settles by hand — the `getUserMedia`-still-pending window. */
interface MicGate {
    promise: Promise<void>;
    reject: (error: Error) => void;
    resolve: () => void;
}

const micGate = (): MicGate => {
    let settle!: { reject: (error: Error) => void; resolve: () => void };
    const promise = new Promise<void>((resolve, reject) => {
        settle = { reject, resolve };
    });

    return { promise, reject: settle.reject, resolve: settle.resolve };
};

/** How the harness is configured for one test. */
interface VoiceHarnessOptions {
    /** Hold every `createMicrophone` call open on a {@link MicGate} the test settles. */
    gateMic?: boolean;
    /** The `__lunoraRef` the voice reference carries. */
    reference?: string;
    /** `LunoraClientOptions.wsUrl` on the fake client — absent by default. */
    wsUrl?: string;
}

/** A microphone controller exposed to the test so it can invoke the pipeline callbacks. */
interface MicHandle {
    config: Parameters<NonNullable<VoiceAgentOptions["createMicrophone"]>>[0];
    setMuted: Mock<(muted: boolean) => void>;
    stop: Mock<() => void>;
}

/** A speaker controller exposed to the test so it can assert playback. */
interface SpeakerHandle {
    enqueue: Mock<(audio: Uint8Array) => void>;
    interrupt: Mock<() => void>;
    stop: Mock<() => void>;
}

interface VoiceHarness {
    handle: VoiceAgentHandle;
    mic: () => MicHandle;
    /** Every `MicGate` a gated harness created, in call order. */
    micGates: MicGate[];
    /** Every URL the primitive opened a socket on, in order. */
    openedUrls: string[];
    socket: () => FakeSocket;
    sockets: FakeSocket[];
    speaker: () => SpeakerHandle;
}

const renderVoice = ({ gateMic, reference = "agents:supportVoice", wsUrl }: VoiceHarnessOptions = {}): VoiceHarness => {
    const fake = createFakeClient();

    // `voiceAgent` derives the WS endpoint from `client.url`; the fake omits it.
    (fake.client as unknown as Record<string, unknown>)["url"] = "http://localhost:8787";

    if (wsUrl !== undefined) {
        (fake.client as unknown as Record<string, unknown>)["wsUrl"] = wsUrl;
    }

    let socketHandle: FakeSocket | undefined;
    let micHandle: MicHandle | undefined;
    let speakerHandle: SpeakerHandle | undefined;
    // Every URL the primitive asked for, in order. The harness used to drop its
    // `url` argument, which left the whole endpoint derivation asserted by nothing.
    const openedUrls: string[] = [];
    const sockets: FakeSocket[] = [];
    const micGates: MicGate[] = [];

    const createSocket = (url: string): FakeSocket => {
        const sent: unknown[] = [];
        const socket: FakeSocket = {
            binaryType: "blob",
            close: vi.fn<() => void>(),
            emitBinary: (bytes) => socket.onmessage?.({ data: bytes.buffer }),
            emitServer: (frame) => socket.onmessage?.({ data: JSON.stringify(frame) }),
            onclose: null,
            onerror: null,
            onmessage: null,
            onopen: null,
            readyState: 1,
            send: (data: unknown) => sent.push(data),
            sent,
        };

        openedUrls.push(url);
        sockets.push(socket);
        socketHandle = socket;

        return socket;
    };

    const createMicrophone: NonNullable<VoiceAgentOptions["createMicrophone"]> = async (config) => {
        const handle: MicHandle = { config, setMuted: vi.fn<(muted: boolean) => void>(), stop: vi.fn<() => void>() };

        micHandle = handle;

        if (gateMic) {
            const gate = micGate();

            micGates.push(gate);

            await gate.promise;
        }

        return { setMuted: handle.setMuted, stop: handle.stop };
    };

    const createSpeaker: NonNullable<VoiceAgentOptions["createSpeaker"]> = () => {
        const handle: SpeakerHandle = { enqueue: vi.fn<(audio: Uint8Array) => void>(), interrupt: vi.fn<() => void>(), stop: vi.fn<() => void>() };

        speakerHandle = handle;

        return { enqueue: handle.enqueue, interrupt: handle.interrupt, stop: handle.stop };
    };

    const handle = voiceAgent(fake.client, {
        createMicrophone,
        createSocket,
        createSpeaker,
        threadKey: "t1",
        voice: makeVoiceRef(reference),
    });

    return {
        handle,
        mic: () => {
            if (!micHandle) {
                throw new Error("microphone was never created");
            }

            return micHandle;
        },
        micGates,
        openedUrls,
        socket: () => {
            if (!socketHandle) {
                throw new Error("socket was never opened");
            }

            return socketHandle;
        },
        sockets,
        speaker: () => {
            if (!speakerHandle) {
                throw new Error("speaker was never created");
            }

            return speakerHandle;
        },
    };
};

describe(voiceAgent, () => {
    it("opens the voice socket to the derived agent endpoint and reports ready", async () => {
        const { handle, openedUrls, socket } = renderVoice();

        await handle.startCall();

        expect(get(handle.status)).toBe("listening");
        expect(get(handle.connected)).toBe(false);

        socket().emitServer({ audioFormat: "mp3", type: "ready" });

        expect(get(handle.connected)).toBe(true);
        expect(get(handle.status)).toBe("listening");
        // The endpoint the primitive derived, in full.
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);
        // The handle flips the socket to binary framing for PCM/audio.
        expect(socket().binaryType).toBe("arraybuffer");

        handle.endCall();
    });

    it("runs a full spoken turn: commit → transcript → deltas → audio → done", async () => {
        const { handle, mic, socket, speaker } = renderVoice();

        await handle.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });

        // Silence-timer fires after the user speaks → commit frame + thinking.
        mic().config.onSilence();

        expect(socket().sent).toContainEqual(JSON.stringify({ type: "commit" }));
        expect(get(handle.status)).toBe("thinking");

        socket().emitServer({ text: "what is the weather", type: "user_transcript" });

        expect(get(handle.transcript)).toBe("what is the weather");
        expect(get(handle.status)).toBe("thinking");

        socket().emitServer({ text: "It is ", type: "assistant_delta" });
        socket().emitServer({ text: "sunny.", type: "assistant_delta" });

        expect(get(handle.status)).toBe("speaking");
        expect(get(handle.interimTranscript)).toBe("It is sunny.");

        socket().emitBinary(new Uint8Array([1, 2, 3]));

        expect(speaker().enqueue).toHaveBeenCalledTimes(1);

        socket().emitServer({ text: "It is sunny.", type: "assistant_done" });

        expect(get(handle.status)).toBe("listening");
        expect(get(handle.interimTranscript)).toBe("It is sunny.");

        handle.endCall();
    });

    it("streams captured PCM as binary frames and toggles mute", async () => {
        const { handle, mic, socket } = renderVoice();

        await handle.startCall();

        const pcm = new Uint8Array([9, 8, 7, 6]);

        mic().config.onAudio(pcm);

        expect(socket().sent).toContainEqual(pcm);

        handle.toggleMute();

        expect(get(handle.isMuted)).toBe(true);
        expect(mic().setMuted).toHaveBeenCalledWith(true);

        handle.endCall();
    });

    it("barges in: interrupt frame + speaker interrupt while the agent speaks", async () => {
        const { handle, mic, socket, speaker } = renderVoice();

        await handle.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });
        socket().emitServer({ text: "A very long answer", type: "assistant_delta" });
        // The agent's spoken audio creates the speaker the barge-in will cancel.
        socket().emitBinary(new Uint8Array([4, 5, 6]));

        expect(get(handle.status)).toBe("speaking");

        mic().config.onInterrupt();

        expect(socket().sent).toContainEqual(JSON.stringify({ type: "interrupt" }));
        expect(speaker().interrupt).toHaveBeenCalledTimes(1);
        expect(get(handle.status)).toBe("listening");

        handle.endCall();
    });

    it("sends a typed turn and ends the call cleanly", async () => {
        const { handle, mic, socket } = renderVoice();

        await handle.startCall();

        handle.sendText("hello there");

        expect(socket().sent).toContainEqual(JSON.stringify({ text: "hello there", type: "text" }));
        expect(get(handle.status)).toBe("thinking");

        const micStop = mic().stop;
        const socketClose = socket().close;

        handle.endCall();

        expect(get(handle.status)).toBe("idle");
        expect(micStop).toHaveBeenCalledTimes(1);
        expect(socketClose).toHaveBeenCalledTimes(1);
    });

    it("derives the agent name from a non-prefixed reference", async () => {
        // A ref that lost its namespace still resolves the agent name (strip Voice suffix).
        const { handle, openedUrls, socket } = renderVoice({ reference: "supportVoice" });

        await handle.startCall();

        socket().emitServer({ audioFormat: "wav", type: "ready" });

        expect(get(handle.connected)).toBe(true);
        // The `Voice` suffix strip is only observable in the URL: without it the
        // endpoint would read `/_lunora/voice/supportVoice`.
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);

        handle.endCall();
    });

    it("builds the voice endpoint from the agent name, the threadKey, and the client's socket origin", async () => {
        const { handle, openedUrls } = renderVoice();

        await handle.startCall();

        // The whole derivation — `agents:` strip, `Voice` strip, ws(s) scheme,
        // path, encoded threadKey — is only ever observable here.
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);

        handle.endCall();
    });

    it("opens voice on the client's configured wsUrl host, not its HTTP host", async () => {
        const { handle, openedUrls } = renderVoice({ wsUrl: "wss://sockets.example.com/_lunora/ws" });

        await handle.startCall();

        expect(openedUrls).toStrictEqual(["wss://sockets.example.com/_lunora/voice/support?threadKey=t1"]);

        handle.endCall();
    });

    it("surfaces a server error frame and returns the call to a usable state", async () => {
        const { handle, socket } = renderVoice();

        await handle.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });
        socket().emitServer({ text: "what is the weather", type: "user_transcript" });

        expect(get(handle.status)).toBe("thinking");

        socket().emitServer({ message: "the model is unavailable", type: "error" });

        expect(get(handle.error)?.message).toBe("the model is unavailable");
        expect(get(handle.status)).toBe("listening");

        handle.endCall();
    });

    it("names an expired credential instead of going quietly idle (TOKEN_EXPIRED + close 4001)", async () => {
        const { handle, socket } = renderVoice();

        await handle.startCall();

        // Byte-for-byte the frame `dropExpiredCredentialSocket` sends.
        socket().emitServer({
            code: "TOKEN_EXPIRED",
            error: { code: "TOKEN_EXPIRED", message: "authentication token expired" },
            message: "authentication token expired",
            type: "error",
        });

        expect(get(handle.error)?.message).toBe("authentication token expired");

        socket().onclose?.({ code: 4001, reason: "token_expired" });

        // The close code is what separates a lapsed credential from a dropped network.
        expect(get(handle.error)?.message).toBe("voiceAgent: authentication token expired — refresh the credential and start a new call");
        expect(get(handle.status)).toBe("idle");
    });

    it("reports a transport error and tears the call down when the socket closes", async () => {
        const { handle, mic, socket } = renderVoice();

        await handle.startCall();

        socket().onerror?.({});

        expect(get(handle.error)?.message).toBe("voiceAgent: voice socket error");

        const micStop = mic().stop;

        socket().onclose?.({ code: 1006 });

        expect(get(handle.status)).toBe("idle");
        expect(micStop).toHaveBeenCalledTimes(1);
    });

    it("acks a server interrupted frame: silences the speaker and returns to listening", async () => {
        const { handle, socket, speaker } = renderVoice();

        await handle.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });
        socket().emitServer({ text: "A very long answer", type: "assistant_delta" });
        socket().emitBinary(new Uint8Array([4, 5, 6]));

        expect(get(handle.status)).toBe("speaking");

        socket().emitServer({ type: "interrupted" });

        expect(speaker().interrupt).toHaveBeenCalledTimes(1);
        expect(get(handle.status)).toBe("listening");

        handle.endCall();
    });

    it("writes no state from frames that arrive after the call ended", async () => {
        const { handle, socket } = renderVoice();

        await handle.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });

        const stale = socket();

        handle.endCall();

        stale.emitServer({ text: "a transcript nobody is listening for", type: "user_transcript" });
        stale.emitBinary(new Uint8Array([1, 2, 3]));
        stale.onerror?.({});

        expect(get(handle.status)).toBe("idle");
        expect(get(handle.transcript)).toBe("");
        expect(get(handle.error)).toBeUndefined();
    });

    it("lets a stale start's microphone failure alone: the call that replaced it keeps running", async () => {
        const { handle, micGates, sockets } = renderVoice({ gateMic: true });

        // Start #1 parks on `getUserMedia`; the user hangs up and starts again.
        const abandoned = handle.startCall();

        handle.endCall();

        const live = handle.startCall();

        await (async () => {
            micGates[0]?.reject(new Error("microphone permission denied"));
            await abandoned;
            micGates[1]?.resolve();
            await live;
        })();

        expect(sockets).toHaveLength(2);
        // The abandoned start's `catch` must not reach the newer call.
        expect(sockets[1]?.close).not.toHaveBeenCalled();
        expect(get(handle.status)).toBe("listening");
        expect(get(handle.error)).toBeUndefined();
    });

    it("keeps reporting speaking when the greeting starts before the microphone resolves", async () => {
        const { handle, micGates, socket, speaker } = renderVoice({ gateMic: true });

        const pending = handle.startCall();

        // The DO sends `ready` and streams its greeting straight away — routinely
        // before `getUserMedia` has resolved.
        socket().emitServer({ audioFormat: "mp3", type: "ready" });
        socket().emitBinary(new Uint8Array([1, 2, 3]));

        expect(get(handle.status)).toBe("speaking");

        await (async () => {
            micGates[0]?.resolve();
            await pending;
        })();

        expect(get(handle.status)).toBe("speaking");
        expect(speaker().enqueue).toHaveBeenCalledTimes(1);

        handle.endCall();
    });

    it("is idempotent at the edges: duplicate startCall, sendText with no open socket, toggleMute before a call", async () => {
        const { handle, sockets } = renderVoice();

        expect(handle.toggleMute()).toBe(true);

        expect(get(handle.isMuted)).toBe(true);

        // No socket yet: the frame is dropped and the UI must not claim "thinking".
        handle.sendText("hello");

        expect(get(handle.status)).toBe("idle");

        await handle.startCall();
        await handle.startCall();

        expect(sockets).toHaveLength(1);

        // A socket that has since closed refuses the frame the same way.
        sockets[0]!.readyState = 3;
        handle.sendText("hello again");

        expect(get(handle.status)).toBe("listening");
        expect(sockets[0]?.sent).toStrictEqual([]);

        handle.endCall();
    });

    it("defaults the socket to the client's configured WebSocket implementation, not a raw global (RN-01 regression)", async () => {
        const fake = createFakeClient();

        (fake.client as unknown as Record<string, unknown>)["url"] = "http://localhost:8787";

        // A `WebSocket`-shaped constructor standing in for the client's configured
        // impl (on React Native this would be the auth-headers-injecting subclass).
        const openedUrls: string[] = [];
        const FakeWebSocketImpl = vi.fn<(this: FakeSocket, url: string) => void>(function FakeWebSocketImpl(this: FakeSocket, url: string) {
            openedUrls.push(url);
            Object.assign(this, {
                binaryType: "blob",
                close: vi.fn<() => void>(),
                onclose: null,
                onerror: null,
                onmessage: null,
                onopen: null,
                readyState: 1,
                send: vi.fn<(data: unknown) => void>(),
            });
        }) as unknown as new (url: string) => FakeSocket;

        (fake.client as unknown as { getWebSocketImpl: () => unknown }).getWebSocketImpl = () => FakeWebSocketImpl;

        // No `createSocket` — the handle must fall back to `client.getWebSocketImpl()`.
        const handle = voiceAgent(fake.client, {
            createMicrophone: async () => {
                return { setMuted: vi.fn<(muted: boolean) => void>(), stop: vi.fn<() => void>() };
            },
            createSpeaker: () => {
                return { enqueue: vi.fn<(audio: Uint8Array) => void>(), interrupt: vi.fn<() => void>(), stop: vi.fn<() => void>() };
            },
            threadKey: "t1",
            voice: makeVoiceRef("agents:supportVoice"),
        });

        await handle.startCall();

        expect(FakeWebSocketImpl).toHaveBeenCalledTimes(1);
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);

        handle.endCall();
    });
});
