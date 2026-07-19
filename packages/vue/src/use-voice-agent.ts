import type { FunctionReference } from "@lunora/client";
import type { MaybeRefOrGetter, Ref } from "vue";
import { onScopeDispose, ref, toValue } from "vue";

import { useLunora } from "./lunora-provider";
import type { CreateMicrophone, CreateSpeaker, VoiceAudioFormat, VoiceMicrophone, VoiceSpeaker } from "./voice-audio";
import { createBrowserMicrophone, createBrowserSpeaker } from "./voice-audio";

/**
 * A server-to-client control frame (JSON). Client-safe mirror of
 * `@lunora/agent`'s `VoiceServerFrame`. Audio never rides these frames — it
 * arrives as separate binary WebSocket messages.
 */
type VoiceServerFrame =
    | { audioFormat: VoiceAudioFormat; type: "ready" }
    | { message: string; type: "error" }
    | { text: string; type: "assistant_delta" }
    | { text: string; type: "assistant_done" }
    | { text: string; type: "user_transcript" }
    | { type: "interrupted" };

/**
 * A client-to-server control frame (JSON). Client-safe mirror of
 * `@lunora/agent`'s `VoiceClientFrame`. `text` submits a typed turn (no audio);
 * `commit` closes the current spoken utterance; `interrupt` barges in on an
 * in-flight assistant turn.
 */
type VoiceClientFrame = { text: string; type: "text" } | { type: "commit" } | { type: "interrupt" };

/**
 * The `agents.&lt;name>Voice` reference codegen emits for a voice-enabled agent — a
 * live, WS-backed session keyed by `threadKey`. A structural subset of the
 * generated member, so passing `api.agents.&lt;name>Voice` type-checks.
 */
type VoiceReference = FunctionReference<"stream", { threadKey: string }, Record<string, unknown>>;

/** The lifecycle of a voice call, mirrored to the UI. */
type VoiceStatus = "idle" | "listening" | "speaking" | "thinking";

/** A minimal structural subset of the DOM `WebSocket` the composable drives. */
interface VoiceSocket {
    binaryType: string;
    close: () => void;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;

    onmessage: ((event: { data: unknown }) => void) | null;
    onopen: ((event: unknown) => void) | null;
    readonly readyState: number;
    send: (data: ArrayBufferView | ArrayBufferLike | string) => void;
}

type CreateSocket = (url: string) => VoiceSocket;

interface UseVoiceAgentOptions {
    /**
     * Advanced/test seam: build the microphone capture subsystem. Defaults to a
     * `getUserMedia` + Web Audio implementation. Injected wholesale so the Web
     * Audio graph stays isolated (and mockable in a non-browser test env).
     */
    createMicrophone?: CreateMicrophone;
    /** Advanced/test seam: open the transport. Defaults to `new WebSocket(url)`. */
    createSocket?: CreateSocket;
    /** Advanced/test seam: build the audio playback subsystem. Defaults to a Web Audio implementation. */
    createSpeaker?: CreateSpeaker;

    /** Consecutive above-`interruptThreshold` chunks that trigger a barge-in. Default `3`. */
    interruptChunks?: number;
    /** Input RMS above which the user is treated as barging in while the agent speaks. Default `0.15`. */
    interruptThreshold?: number;
    /** Milliseconds of silence (after speech) that auto-commits an utterance. Default `1200`. */
    silenceDurationMs?: number;
    /** Input RMS below which audio counts as silence. Default `0.01`. */
    silenceThreshold?: number;
    /** The thread to converse on — shared with the agent's text turns. May be a plain value, `ref`, or getter (resolved when the call opens). */
    threadKey: MaybeRefOrGetter<string>;
    /** The generated `api.agents.&lt;name>Voice` reference — identifies the voice DO endpoint. */
    voice: VoiceReference;
}

interface UseVoiceAgentResult {
    /** The current input RMS (0–1) — drive a mic level meter. */
    audioLevel: Readonly<Ref<number>>;
    /** `true` once the WS `ready` handshake completed. */
    connected: Readonly<Ref<boolean>>;
    /** Tear down the call: close the socket, stop the mic, release audio. Idempotent. */
    endCall: () => void;
    /** The last transport/pipeline error, or `undefined`. */
    error: Readonly<Ref<Error | undefined>>;
    /** The live assistant text for the in-flight turn (grows via deltas; finalized on done). */
    interimTranscript: Readonly<Ref<string>>;
    /** `true` while the mic is muted. */
    isMuted: Readonly<Ref<boolean>>;
    /** Send a typed turn (no audio) — a text message spoken back by the agent. */
    sendText: (text: string) => void;
    /** Open the mic, connect the socket, and start the conversation. Idempotent while active. */
    startCall: () => Promise<void>;
    /** The current call lifecycle. */
    status: Readonly<Ref<VoiceStatus>>;
    /** Mute/unmute the microphone. Returns the new muted state. */
    toggleMute: () => boolean;
    /** The last finalized user utterance (STT result). */
    transcript: Readonly<Ref<string>>;
}

/** WebSocket `readyState` OPEN, read structurally so no DOM `WebSocket` global is required at module load. */
const WS_OPEN = 1;

const DEFAULT_SILENCE_THRESHOLD = 0.01;
const DEFAULT_SILENCE_DURATION_MS = 1200;
const DEFAULT_INTERRUPT_THRESHOLD = 0.15;
const DEFAULT_INTERRUPT_CHUNKS = 3;

/** Swap an http(s) origin for its ws(s) equivalent — mirrors the client's own derivation. */
const deriveWebSocketUrl = (url: string): string => {
    if (url.startsWith("https://")) {
        return `wss://${url.slice("https://".length)}`;
    }

    if (url.startsWith("http://")) {
        return `ws://${url.slice("http://".length)}`;
    }

    return url;
};

/**
 * Derive the agent's export name from its voice reference. Codegen emits the
 * member as `agents.&lt;name>Voice` (ref `agents:&lt;name>Voice`), so strip the
 * `agents:` namespace and the `Voice` suffix.
 */
const agentNameFromReference = (voice: VoiceReference): string => {
    const reference = voice["__lunoraRef"];
    const withoutNamespace = reference.startsWith("agents:") ? reference.slice("agents:".length) : reference;

    return withoutNamespace.endsWith("Voice") ? withoutNamespace.slice(0, -"Voice".length) : withoutNamespace;
};

/** Build the voice-session WebSocket URL for `agent` on `threadKey`. */
const voiceSocketUrl = (baseUrl: string, agent: string, threadKey: string): string => {
    const base = deriveWebSocketUrl(baseUrl);
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
    const search = new URLSearchParams({ threadKey });

    return `${trimmed}/_lunora/voice/${encodeURIComponent(agent)}?${search.toString()}`;
};

/** Mutable per-call connection state, held in a closure so callbacks share one source of truth. */
interface VoiceConnection {
    audioFormat: VoiceAudioFormat;
    microphone: VoiceMicrophone | undefined;
    socket: VoiceSocket;
    speaker: VoiceSpeaker | undefined;
    speaking: boolean;

    /**
     * Set on a LOCAL barge-in to drop inbound audio frames until the server acks
     * the interrupt — otherwise audio already in flight (queued before the DO saw
     * the `interrupt`) would resurrect a speaker the user just silenced. Cleared
     * on the next `interrupted` / `user_transcript` / `ready` frame.
     */
    suppressAudio: boolean;
}

/**
 * A first-class voice-call surface for a voice-enabled agent: it opens a
 * WebSocket to the agent's `VoiceSessionDO`, captures mic audio as 16 kHz PCM,
 * streams the agent's synthesized speech back through the browser's audio output,
 * and mirrors the call lifecycle (`status`, `transcript`, `interimTranscript`,
 * `audioLevel`) to Vue refs. Pass the generated `api.agents.&lt;name>Voice`
 * reference (never a string), matching `useAgentChat`'s reference-passing style.
 * The Vue counterpart to React's `useVoiceAgent`, re-expressed with refs; the
 * per-call connection lives in a closure variable (a composable runs once per
 * component, so no `ref`-of-ref indirection is needed).
 *
 * v1 transport is plain binary WebSocket frames with push-to-talk / silence-timer
 * turn detection and client-side RMS barge-in. The heavy Web Audio capture and
 * playback subsystems are injectable (`createMicrophone` / `createSpeaker` /
 * `createSocket`) so the composable is drivable outside a browser.
 */
const useVoiceAgent = (options: UseVoiceAgentOptions): UseVoiceAgentResult => {
    const {
        createMicrophone = createBrowserMicrophone,
        createSpeaker = createBrowserSpeaker,
        createSocket,
        interruptChunks = DEFAULT_INTERRUPT_CHUNKS,
        interruptThreshold = DEFAULT_INTERRUPT_THRESHOLD,
        silenceDurationMs = DEFAULT_SILENCE_DURATION_MS,
        silenceThreshold = DEFAULT_SILENCE_THRESHOLD,
        threadKey,
        voice,
    } = options;

    const client = useLunora();

    const status = ref<VoiceStatus>("idle");
    const connected = ref(false);
    const transcript = ref("");
    const interimTranscript = ref("");
    const audioLevel = ref(0);
    const isMuted = ref(false);
    const error = ref<Error | undefined>(undefined);

    // The live per-call connection (React's `connectionRef.current`) and the
    // "start in flight" guard (React's `startingRef.current`) — plain closure
    // variables, since a composable body runs once per component instance.
    let current: VoiceConnection | undefined;
    let starting = false;

    const sendFrame = (frame: VoiceClientFrame): boolean => {
        const socket = current?.socket;

        if (socket?.readyState === WS_OPEN) {
            socket.send(JSON.stringify(frame));

            return true;
        }

        return false;
    };

    const teardown = (): void => {
        const connection = current;

        current = undefined;

        if (connection) {
            connection.microphone?.stop();
            connection.speaker?.stop();

            try {
                connection.socket.close();
            } catch {
                /* already closed */
            }
        }

        starting = false;
        connected.value = false;
        status.value = "idle";
        audioLevel.value = 0;
    };

    const endCall = (): void => {
        teardown();
    };

    const handleServerFrame = (frame: VoiceServerFrame): void => {
        const connection = current;

        switch (frame.type) {
            case "assistant_delta": {
                if (connection) {
                    connection.speaking = true;
                }

                status.value = "speaking";
                interimTranscript.value += frame.text;

                break;
            }
            case "assistant_done": {
                if (connection) {
                    connection.speaking = false;
                }

                interimTranscript.value = frame.text;
                status.value = "listening";

                break;
            }
            case "error": {
                // A non-fatal turn failure: surface it and return the call to a
                // usable state rather than leaving it stuck "speaking"/"thinking".
                if (connection) {
                    connection.speaking = false;
                }

                error.value = new Error(frame.message);
                status.value = "listening";

                break;
            }
            case "interrupted": {
                if (connection) {
                    connection.speaking = false;
                    connection.suppressAudio = false;
                }

                connection?.speaker?.interrupt();
                status.value = "listening";

                break;
            }
            case "ready": {
                if (connection) {
                    connection.audioFormat = frame.audioFormat;
                    connection.suppressAudio = false;
                }

                connected.value = true;
                status.value = "listening";

                break;
            }
            case "user_transcript": {
                if (connection) {
                    connection.suppressAudio = false;
                }

                transcript.value = frame.text;
                interimTranscript.value = "";
                status.value = "thinking";

                break;
            }
            default: {
                break;
            }
        }
    };

    const handleAudioChunk = (audio: Uint8Array): void => {
        const connection = current;

        if (!connection || connection.suppressAudio) {
            return;
        }

        connection.speaker ??= createSpeaker({ audioFormat: connection.audioFormat });
        connection.speaking = true;
        status.value = "speaking";
        connection.speaker.enqueue(audio);
    };

    const startCall = async (): Promise<void> => {
        if (current || starting) {
            return;
        }

        starting = true;
        error.value = undefined;
        transcript.value = "";
        interimTranscript.value = "";

        try {
            const url = voiceSocketUrl(client.url, agentNameFromReference(voice), toValue(threadKey));
            const openSocket: CreateSocket =
                createSocket ?? ((target) => new (globalThis as unknown as { WebSocket: new (u: string) => VoiceSocket }).WebSocket(target));
            const socket = openSocket(url);

            socket.binaryType = "arraybuffer";

            const connection: VoiceConnection = {
                audioFormat: "mp3",
                microphone: undefined,
                socket,
                speaker: undefined,
                speaking: false,
                suppressAudio: false,
            };

            current = connection;

            // The injectable `VoiceSocket` exposes only `on*` handler slots (not a
            // real EventTarget), so assign them directly.
            /* eslint-disable unicorn/prefer-add-event-listener */
            socket.onmessage = (event): void => {
                if (typeof event.data === "string") {
                    try {
                        handleServerFrame(JSON.parse(event.data) as VoiceServerFrame);
                    } catch {
                        /* ignore malformed control frame */
                    }

                    return;
                }

                handleAudioChunk(new Uint8Array(event.data as ArrayBuffer));
            };

            socket.onerror = (): void => {
                error.value = new Error("useVoiceAgent: voice socket error");
            };

            socket.onclose = (): void => {
                if (current === connection) {
                    teardown();
                }
            };
            /* eslint-enable unicorn/prefer-add-event-listener */

            const microphone = await createMicrophone({
                interruptChunks,
                interruptThreshold,
                isSpeaking: () => current?.speaking ?? false,
                onAudio: (pcm) => {
                    if (socket.readyState === WS_OPEN) {
                        socket.send(pcm);
                    }
                },
                onInterrupt: () => {
                    sendFrame({ type: "interrupt" });
                    current?.speaker?.interrupt();

                    if (current) {
                        current.speaking = false;
                        // Drop any audio already in flight until the server acks —
                        // cleared on the next `interrupted`/`user_transcript`/`ready`.
                        current.suppressAudio = true;
                    }

                    status.value = "listening";
                },
                onLevel: (rms) => {
                    audioLevel.value = rms;
                },
                onSilence: () => {
                    sendFrame({ type: "commit" });
                    status.value = "thinking";
                },
                silenceDurationMs,
                silenceThreshold,
            });

            // The call may have been torn down while getUserMedia was pending.
            if (current === connection) {
                connection.microphone = microphone;
                isMuted.value = false;
                // Optimistically show "listening" once the mic is live — the server's
                // `ready` frame follows and flips `connected` true.
                status.value = "listening";
            } else {
                microphone.stop();
            }
        } catch (error_) {
            error.value = error_ instanceof Error ? error_ : new Error(String(error_));
            teardown();
        } finally {
            starting = false;
        }
    };

    const toggleMute = (): boolean => {
        const next = !isMuted.value;

        current?.microphone?.setMuted(next);
        isMuted.value = next;

        return next;
    };

    const sendText = (text: string): void => {
        // Only advance to "thinking" if the frame actually reached an open socket;
        // otherwise the UI would stick in "thinking" with no call.
        if (sendFrame({ text, type: "text" })) {
            status.value = "thinking";
        }
    };

    // Tear the call down if the component unmounts mid-call.
    onScopeDispose(teardown);

    return { audioLevel, connected, endCall, error, interimTranscript, isMuted, sendText, startCall, status, toggleMute, transcript };
};

export type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceReference, VoiceStatus };
export type { VoiceAudioFormat } from "./voice-audio";
export { useVoiceAgent };
