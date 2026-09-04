import type { LunoraClient } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceReference } from "../src/use-voice-agent";
import { useVoiceAgent } from "../src/use-voice-agent";
import { createMockClient } from "./mock-client";

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

const buildClient = (wsUrl?: string): LunoraClient => {
    const client = createMockClient().asClient;

    (client as unknown as Record<string, unknown>)["url"] = "http://localhost:8787";

    if (wsUrl !== undefined) {
        (client as unknown as Record<string, unknown>)["wsUrl"] = wsUrl;
    }

    return client;
};

/** A microphone controller exposed to the test so it can invoke the pipeline callbacks. */
interface MicHandle {
    config: Parameters<NonNullable<UseVoiceAgentOptions["createMicrophone"]>>[0];
    setMuted: Mock<(muted: boolean) => void>;
    stop: Mock<() => void>;
}

/** A speaker controller exposed to the test so it can assert playback. */
interface SpeakerHandle {
    enqueue: Mock<(audio: Uint8Array) => void>;
    interrupt: Mock<() => void>;
    stop: Mock<() => void>;
}

const renderVoice = ({ gateMic, reference = "agents:supportVoice", wsUrl }: VoiceHarnessOptions = {}): {
    client: LunoraClient;
    mic: () => MicHandle;
    /** Every `MicGate` a gated harness created, in call order. */
    micGates: MicGate[];
    /** Every URL the primitive opened a socket on, in order. */
    openedUrls: string[];
    result: { current: UseVoiceAgentResult };
    socket: () => FakeSocket;
    sockets: FakeSocket[];
    speaker: () => SpeakerHandle;
    unmount: () => void;
} => {
    const client = buildClient(wsUrl);
    let socketHandle: FakeSocket | undefined;
    let micHandle: MicHandle | undefined;
    let speakerHandle: SpeakerHandle | undefined;
    // Every URL the primitive asked for, in order. The harness used to drop its
    // `url` argument, which left the whole endpoint derivation asserted by nothing.
    const openedUrls: string[] = [];
    const sockets: FakeSocket[] = [];
    const micGates: MicGate[] = [];
    const result = { current: undefined as unknown as UseVoiceAgentResult };

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

    const createMicrophone: NonNullable<UseVoiceAgentOptions["createMicrophone"]> = async (config) => {
        const handle: MicHandle = { config, setMuted: vi.fn<(muted: boolean) => void>(), stop: vi.fn<() => void>() };

        micHandle = handle;

        if (gateMic) {
            const gate = micGate();

            micGates.push(gate);

            await gate.promise;
        }

        return { setMuted: handle.setMuted, stop: handle.stop };
    };

    const createSpeaker: NonNullable<UseVoiceAgentOptions["createSpeaker"]> = () => {
        const handle: SpeakerHandle = { enqueue: vi.fn<(audio: Uint8Array) => void>(), interrupt: vi.fn<() => void>(), stop: vi.fn<() => void>() };

        speakerHandle = handle;

        return { enqueue: handle.enqueue, interrupt: handle.interrupt, stop: handle.stop };
    };

    const Probe = (): ReactElement => {
        result.current = useVoiceAgent({
            createMicrophone,
            createSocket,
            createSpeaker,
            threadKey: "t1",
            voice: makeVoiceRef(reference),
        });

        return <div data-testid="status">{result.current.status}</div>;
    };

    const { unmount } = render(
        <LunoraProvider client={client}>
            <Probe />
        </LunoraProvider>,
    );

    return {
        client,
        mic: () => {
            if (!micHandle) {
                throw new Error("microphone was never created");
            }

            return micHandle;
        },
        result,
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
        unmount,
    };
};

describe(useVoiceAgent, () => {
    it("opens the voice socket to the derived agent endpoint and reports ready", async () => {
        expect.hasAssertions();

        const { openedUrls, result, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        expect(result.current.status).toBe("listening");
        expect(result.current.connected).toBe(false);

        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
        });

        expect(result.current.connected).toBe(true);
        expect(result.current.status).toBe("listening");
        // The endpoint the primitive derived, in full.
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);
        // The hook flips the socket to binary framing for PCM/audio.
        expect(socket().binaryType).toBe("arraybuffer");
    });

    it("runs a full spoken turn: commit → transcript → deltas → audio → done", async () => {
        expect.hasAssertions();

        const { mic, result, socket, speaker } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
        });

        // Silence-timer fires after the user speaks → commit frame + thinking.
        act(() => {
            mic().config.onSilence();
        });

        expect(socket().sent).toContainEqual(JSON.stringify({ type: "commit" }));
        expect(result.current.status).toBe("thinking");

        act(() => {
            socket().emitServer({ text: "what is the weather", type: "user_transcript" });
        });

        expect(result.current.transcript).toBe("what is the weather");
        expect(result.current.status).toBe("thinking");

        act(() => {
            socket().emitServer({ text: "It is ", type: "assistant_delta" });
            socket().emitServer({ text: "sunny.", type: "assistant_delta" });
        });

        expect(result.current.status).toBe("speaking");
        expect(result.current.interimTranscript).toBe("It is sunny.");

        act(() => {
            socket().emitBinary(new Uint8Array([1, 2, 3]));
        });

        expect(speaker().enqueue).toHaveBeenCalledTimes(1);

        act(() => {
            socket().emitServer({ text: "It is sunny.", type: "assistant_done" });
        });

        expect(result.current.status).toBe("listening");
        expect(result.current.interimTranscript).toBe("It is sunny.");
    });

    it("streams captured PCM as binary frames and toggles mute", async () => {
        expect.hasAssertions();

        const { mic, result, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        const pcm = new Uint8Array([9, 8, 7, 6]);

        act(() => {
            mic().config.onAudio(pcm);
        });

        expect(socket().sent).toContainEqual(pcm);

        act(() => {
            result.current.toggleMute();
        });

        expect(result.current.isMuted).toBe(true);
        expect(mic().setMuted).toHaveBeenCalledWith(true);
    });

    it("barges in: interrupt frame + speaker interrupt while the agent speaks", async () => {
        expect.hasAssertions();

        const { mic, result, socket, speaker } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
        });
        act(() => {
            socket().emitServer({ text: "A very long answer", type: "assistant_delta" });
        });
        // The agent's spoken audio creates the speaker the barge-in will cancel.
        act(() => {
            socket().emitBinary(new Uint8Array([4, 5, 6]));
        });

        expect(result.current.status).toBe("speaking");

        act(() => {
            mic().config.onInterrupt();
        });

        expect(socket().sent).toContainEqual(JSON.stringify({ type: "interrupt" }));
        expect(speaker().interrupt).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe("listening");
    });

    it("sends a typed turn and ends the call cleanly", async () => {
        expect.hasAssertions();

        const { mic, result, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            result.current.sendText("hello there");
        });

        expect(socket().sent).toContainEqual(JSON.stringify({ text: "hello there", type: "text" }));
        expect(result.current.status).toBe("thinking");

        const micStop = mic().stop;
        const socketClose = socket().close;

        act(() => {
            result.current.endCall();
        });

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("idle");
        });

        expect(micStop).toHaveBeenCalledTimes(1);
        expect(socketClose).toHaveBeenCalledTimes(1);
    });

    it("defaults the socket to the client's configured WebSocket implementation, not a raw global (RN-01 regression)", async () => {
        expect.hasAssertions();

        const client = buildClient();

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

        (client as unknown as { getWebSocketImpl: () => unknown }).getWebSocketImpl = () => FakeWebSocketImpl;

        const createMicrophone: NonNullable<UseVoiceAgentOptions["createMicrophone"]> = async () => {
            return { setMuted: vi.fn<(muted: boolean) => void>(), stop: vi.fn<() => void>() };
        };
        const createSpeaker: NonNullable<UseVoiceAgentOptions["createSpeaker"]> = () => {
            return { enqueue: vi.fn<(audio: Uint8Array) => void>(), interrupt: vi.fn<() => void>(), stop: vi.fn<() => void>() };
        };

        const result = { current: undefined as unknown as UseVoiceAgentResult };

        const Probe = (): ReactElement => {
            // No `createSocket` — the hook must fall back to `client.getWebSocketImpl()`.
            result.current = useVoiceAgent({ createMicrophone, createSpeaker, threadKey: "t1", voice: makeVoiceRef("agents:supportVoice") });

            return <div />;
        };

        render(
            <LunoraProvider client={client}>
                <Probe />
            </LunoraProvider>,
        );

        await act(async () => {
            await result.current.startCall();
        });

        expect(FakeWebSocketImpl).toHaveBeenCalledTimes(1);
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);
    });

    it("derives the agent name from a non-prefixed reference", async () => {
        expect.hasAssertions();

        // A ref that lost its namespace still resolves the agent name (strip Voice suffix).
        const { openedUrls, result, socket } = renderVoice({ reference: "supportVoice" });

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "wav", type: "ready" });
        });

        expect(result.current.connected).toBe(true);
        // The `Voice` suffix strip is only observable in the URL: without it the
        // endpoint would read `/_lunora/voice/supportVoice`.
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);
    });

    it("builds the voice endpoint from the agent name, the threadKey, and the client's socket origin", async () => {
        expect.hasAssertions();

        const { openedUrls, result, unmount } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        // The whole derivation — `agents:` strip, `Voice` strip, ws(s) scheme,
        // path, encoded threadKey — is only ever observable here.
        expect(openedUrls).toStrictEqual(["ws://localhost:8787/_lunora/voice/support?threadKey=t1"]);

        unmount();
    });

    it("opens voice on the client's configured wsUrl host, not its HTTP host", async () => {
        expect.hasAssertions();

        const { openedUrls, result, unmount } = renderVoice({ wsUrl: "wss://sockets.example.com/_lunora/ws" });

        await act(async () => {
            await result.current.startCall();
        });

        expect(openedUrls).toStrictEqual(["wss://sockets.example.com/_lunora/voice/support?threadKey=t1"]);

        unmount();
    });

    it("surfaces a server error frame and returns the call to a usable state", async () => {
        expect.hasAssertions();

        const { result, socket, unmount } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
            socket().emitServer({ text: "what is the weather", type: "user_transcript" });
        });

        expect(result.current.status).toBe("thinking");

        act(() => {
            socket().emitServer({ message: "the model is unavailable", type: "error" });
        });

        expect(result.current.error?.message).toBe("the model is unavailable");
        expect(result.current.status).toBe("listening");

        unmount();
    });

    it("names an expired credential instead of going quietly idle (TOKEN_EXPIRED + close 4001)", async () => {
        expect.hasAssertions();

        const { result, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        // Byte-for-byte the frame `dropExpiredCredentialSocket` sends.
        act(() => {
            socket().emitServer({
                code: "TOKEN_EXPIRED",
                error: { code: "TOKEN_EXPIRED", message: "authentication token expired" },
                message: "authentication token expired",
                type: "error",
            });
        });

        expect(result.current.error?.message).toBe("authentication token expired");

        act(() => {
            socket().onclose?.({ code: 4001, reason: "token_expired" });
        });

        // The close code is what separates a lapsed credential from a dropped network.
        expect(result.current.error?.message).toBe("useVoiceAgent: authentication token expired — refresh the credential and start a new call");
        expect(result.current.status).toBe("idle");
    });

    it("reports a transport error and tears the call down when the socket closes", async () => {
        expect.hasAssertions();

        const { mic, result, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().onerror?.({});
        });

        expect(result.current.error?.message).toBe("useVoiceAgent: voice socket error");

        const micStop = mic().stop;

        act(() => {
            socket().onclose?.({ code: 1006 });
        });

        expect(result.current.status).toBe("idle");
        expect(micStop).toHaveBeenCalledTimes(1);
    });

    it("acks a server interrupted frame: silences the speaker and returns to listening", async () => {
        expect.hasAssertions();

        const { result, socket, speaker, unmount } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
            socket().emitServer({ text: "A very long answer", type: "assistant_delta" });
            socket().emitBinary(new Uint8Array([4, 5, 6]));
        });

        expect(result.current.status).toBe("speaking");

        act(() => {
            socket().emitServer({ type: "interrupted" });
        });

        expect(speaker().interrupt).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe("listening");

        unmount();
    });

    it("writes no state from frames that arrive after the call ended", async () => {
        expect.hasAssertions();

        const { result, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
        });

        const stale = socket();

        act(() => {
            result.current.endCall();
        });

        act(() => {
            stale.emitServer({ text: "a transcript nobody is listening for", type: "user_transcript" });
            stale.emitBinary(new Uint8Array([1, 2, 3]));
            stale.onerror?.({});
        });

        expect(result.current.status).toBe("idle");
        expect(result.current.transcript).toBe("");
        expect(result.current.error).toBeUndefined();
    });

    it("lets a stale start's microphone failure alone: the call that replaced it keeps running", async () => {
        expect.hasAssertions();

        const { micGates, result, sockets } = renderVoice({ gateMic: true });

        // Start #1 parks on `getUserMedia`; the user hangs up and starts again.
        let abandoned!: Promise<void>;

        act(() => {
            abandoned = result.current.startCall();
        });

        act(() => {
            result.current.endCall();
        });

        let live!: Promise<void>;

        act(() => {
            live = result.current.startCall();
        });

        await act(async () => {
            await (async () => {
                micGates[0]?.reject(new Error("microphone permission denied"));
                await abandoned;
                micGates[1]?.resolve();
                await live;
            })();
        });

        expect(sockets).toHaveLength(2);
        // The abandoned start's `catch` must not reach the newer call.
        expect(sockets[1]?.close).not.toHaveBeenCalled();
        expect(result.current.status).toBe("listening");
        expect(result.current.error).toBeUndefined();
    });

    it("keeps reporting speaking when the greeting starts before the microphone resolves", async () => {
        expect.hasAssertions();

        const { micGates, result, socket, speaker, unmount } = renderVoice({ gateMic: true });

        let pending!: Promise<void>;

        act(() => {
            pending = result.current.startCall();
        });

        // The DO sends `ready` and streams its greeting straight away — routinely
        // before `getUserMedia` has resolved.
        act(() => {
            socket().emitServer({ audioFormat: "mp3", type: "ready" });
            socket().emitBinary(new Uint8Array([1, 2, 3]));
        });

        expect(result.current.status).toBe("speaking");

        await act(async () => {
            await (async () => {
                micGates[0]?.resolve();
                await pending;
            })();
        });

        expect(result.current.status).toBe("speaking");
        expect(speaker().enqueue).toHaveBeenCalledTimes(1);

        unmount();
    });

    it("is idempotent at the edges: duplicate startCall, sendText with no open socket, toggleMute before a call", async () => {
        expect.hasAssertions();

        const { result, sockets, unmount } = renderVoice();

        act(() => {
            expect(result.current.toggleMute()).toBe(true);
        });

        expect(result.current.isMuted).toBe(true);

        // No socket yet: the frame is dropped and the UI must not claim "thinking".
        act(() => {
            result.current.sendText("hello");
        });

        expect(result.current.status).toBe("idle");

        await act(async () => {
            await result.current.startCall();
        });
        await act(async () => {
            await result.current.startCall();
        });

        expect(sockets).toHaveLength(1);

        // A socket that has since closed refuses the frame the same way.
        act(() => {
            sockets[0]!.readyState = 3;
            result.current.sendText("hello again");
        });

        expect(result.current.status).toBe("listening");
        expect(sockets[0]?.sent).toStrictEqual([]);

        unmount();
    });

    it("tears the call down when its owner is disposed", async () => {
        expect.hasAssertions();

        const { mic, result, unmount, socket } = renderVoice();

        await act(async () => {
            await result.current.startCall();
        });

        const micStop = mic().stop;
        const socketClose = socket().close;

        // The `useEffect` cleanup is the only thing wired to unmount.
        unmount();

        expect(micStop).toHaveBeenCalledTimes(1);
        expect(socketClose).toHaveBeenCalledTimes(1);
    });
});
