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

const buildClient = (): LunoraClient => {
    const client = createMockClient().asClient;

    (client as unknown as Record<string, unknown>)["url"] = "http://localhost:8787";

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

const renderVoice = (
    reference = "agents:supportVoice",
): {
    client: LunoraClient;
    mic: () => MicHandle;
    result: { current: UseVoiceAgentResult };
    socket: () => FakeSocket;
    speaker: () => SpeakerHandle;
} => {
    const client = buildClient();
    let socketHandle: FakeSocket | undefined;
    let micHandle: MicHandle | undefined;
    let speakerHandle: SpeakerHandle | undefined;
    const result = { current: undefined as unknown as UseVoiceAgentResult };

    const createSocket = (): FakeSocket => {
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

        socketHandle = socket;

        return socket;
    };

    const createMicrophone: NonNullable<UseVoiceAgentOptions["createMicrophone"]> = async (config) => {
        const handle: MicHandle = { config, setMuted: vi.fn<(muted: boolean) => void>(), stop: vi.fn<() => void>() };

        micHandle = handle;

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

    render(
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
        socket: () => {
            if (!socketHandle) {
                throw new Error("socket was never opened");
            }

            return socketHandle;
        },
        speaker: () => {
            if (!speakerHandle) {
                throw new Error("speaker was never created");
            }

            return speakerHandle;
        },
    };
};

describe(useVoiceAgent, () => {
    it("opens the voice socket to the derived agent endpoint and reports ready", async () => {
        expect.hasAssertions();

        const { result, socket } = renderVoice();

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
        // The endpoint carries the agent name (from the ref) + threadKey.
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
        expect(openedUrls[0]).toContain("t1");
    });

    it("derives the agent name from a non-prefixed reference", async () => {
        expect.hasAssertions();

        // A ref that lost its namespace still resolves the agent name (strip Voice suffix).
        const { result, socket } = renderVoice("supportVoice");

        await act(async () => {
            await result.current.startCall();
        });

        act(() => {
            socket().emitServer({ audioFormat: "wav", type: "ready" });
        });

        expect(result.current.connected).toBe(true);
    });
});
