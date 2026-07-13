import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { EffectScope } from "vue";
import { effectScope } from "vue";

import type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceReference } from "../src/use-voice-agent";
import { useVoiceAgent } from "../src/use-voice-agent";
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

interface VoiceHarness {
    mic: () => MicHandle;
    result: UseVoiceAgentResult;
    scope: EffectScope;
    socket: () => FakeSocket;
    speaker: () => SpeakerHandle;
}

const renderVoice = (reference = "agents:supportVoice"): VoiceHarness => {
    const fake = createFakeClient();

    // `useVoiceAgent` derives the WS endpoint from `client.url`; the fake omits it.
    (fake.client as unknown as Record<string, unknown>)["url"] = "http://localhost:8787";

    let socketHandle: FakeSocket | undefined;
    let micHandle: MicHandle | undefined;
    let speakerHandle: SpeakerHandle | undefined;

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

    const scope = effectScope();
    const result = scope.run(() =>
        fake.provide((): UseVoiceAgentResult =>
            useVoiceAgent({
                createMicrophone,
                createSocket,
                createSpeaker,
                threadKey: "t1",
                voice: makeVoiceRef(reference),
            }),
        ),
    )!;

    return {
        mic: () => {
            if (!micHandle) {
                throw new Error("microphone was never created");
            }

            return micHandle;
        },
        result,
        scope,
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

        const { result, scope, socket } = renderVoice();

        await result.startCall();

        expect(result.status.value).toBe("listening");
        expect(result.connected.value).toBe(false);

        socket().emitServer({ audioFormat: "mp3", type: "ready" });

        expect(result.connected.value).toBe(true);
        expect(result.status.value).toBe("listening");
        // The composable flips the socket to binary framing for PCM/audio.
        expect(socket().binaryType).toBe("arraybuffer");

        scope.stop();
    });

    it("runs a full spoken turn: commit → transcript → deltas → audio → done", async () => {
        expect.hasAssertions();

        const { mic, result, scope, socket, speaker } = renderVoice();

        await result.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });

        // Silence-timer fires after the user speaks → commit frame + thinking.
        mic().config.onSilence();

        expect(socket().sent).toContainEqual(JSON.stringify({ type: "commit" }));
        expect(result.status.value).toBe("thinking");

        socket().emitServer({ text: "what is the weather", type: "user_transcript" });

        expect(result.transcript.value).toBe("what is the weather");
        expect(result.status.value).toBe("thinking");

        socket().emitServer({ text: "It is ", type: "assistant_delta" });
        socket().emitServer({ text: "sunny.", type: "assistant_delta" });

        expect(result.status.value).toBe("speaking");
        expect(result.interimTranscript.value).toBe("It is sunny.");

        socket().emitBinary(new Uint8Array([1, 2, 3]));

        expect(speaker().enqueue).toHaveBeenCalledTimes(1);

        socket().emitServer({ text: "It is sunny.", type: "assistant_done" });

        expect(result.status.value).toBe("listening");
        expect(result.interimTranscript.value).toBe("It is sunny.");

        scope.stop();
    });

    it("streams captured PCM as binary frames and toggles mute", async () => {
        expect.hasAssertions();

        const { mic, result, scope, socket } = renderVoice();

        await result.startCall();

        const pcm = new Uint8Array([9, 8, 7, 6]);

        mic().config.onAudio(pcm);

        expect(socket().sent).toContainEqual(pcm);

        result.toggleMute();

        expect(result.isMuted.value).toBe(true);
        expect(mic().setMuted).toHaveBeenCalledWith(true);

        scope.stop();
    });

    it("barges in: interrupt frame + speaker interrupt while the agent speaks", async () => {
        expect.hasAssertions();

        const { mic, result, scope, socket, speaker } = renderVoice();

        await result.startCall();

        socket().emitServer({ audioFormat: "mp3", type: "ready" });
        socket().emitServer({ text: "A very long answer", type: "assistant_delta" });
        // The agent's spoken audio creates the speaker the barge-in will cancel.
        socket().emitBinary(new Uint8Array([4, 5, 6]));

        expect(result.status.value).toBe("speaking");

        mic().config.onInterrupt();

        expect(socket().sent).toContainEqual(JSON.stringify({ type: "interrupt" }));
        expect(speaker().interrupt).toHaveBeenCalledTimes(1);
        expect(result.status.value).toBe("listening");

        scope.stop();
    });

    it("sends a typed turn and ends the call cleanly", async () => {
        expect.hasAssertions();

        const { mic, result, scope, socket } = renderVoice();

        await result.startCall();

        result.sendText("hello there");

        expect(socket().sent).toContainEqual(JSON.stringify({ text: "hello there", type: "text" }));
        expect(result.status.value).toBe("thinking");

        const micStop = mic().stop;
        const socketClose = socket().close;

        result.endCall();

        expect(result.status.value).toBe("idle");
        expect(micStop).toHaveBeenCalledTimes(1);
        expect(socketClose).toHaveBeenCalledTimes(1);

        scope.stop();
    });

    it("derives the agent name from a non-prefixed reference", async () => {
        expect.hasAssertions();

        // A ref that lost its namespace still resolves the agent name (strip Voice suffix).
        const { result, scope, socket } = renderVoice("supportVoice");

        await result.startCall();

        socket().emitServer({ audioFormat: "wav", type: "ready" });

        expect(result.connected.value).toBe(true);

        scope.stop();
    });
});
