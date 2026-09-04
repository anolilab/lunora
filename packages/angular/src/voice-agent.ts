import type { Signal } from "@angular/core";
import { DestroyRef, inject, signal } from "@angular/core";
import type { FunctionReference, LunoraClient } from "@lunora/client";

import { agentNameFromReference, voiceCloseError, voiceSocketUrl } from "../../../shared/voice-socket";
import { resolveLunoraClient } from "./client";
import { outsideAngularRunner } from "./platform";
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
 * The `agents.<name>Voice` reference codegen emits for a voice-enabled agent — a
 * live, WS-backed session keyed by `threadKey`. A structural subset of the
 * generated member, so passing `api.agents.<name>Voice` type-checks.
 * @experimental
 */
type VoiceReference = FunctionReference<"stream", { threadKey: string }, Record<string, unknown>>;

/**
 * The lifecycle of a voice call, mirrored to the UI.
 * @experimental
 */
type VoiceStatus = "idle" | "listening" | "speaking" | "thinking";

/** A minimal structural subset of the DOM `WebSocket` the primitive drives. */
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

/**
 * `VoiceAgentOptions` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface VoiceAgentOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /**
     * Advanced/test seam: build the microphone capture subsystem. Defaults to a
     * `getUserMedia` + Web Audio implementation. Injected wholesale so the Web
     * Audio graph stays isolated (and mockable in a non-browser test env).
     */
    createMicrophone?: CreateMicrophone;

    /**
     * Advanced/test seam: open the transport. Defaults to the WebSocket
     * implementation the client was built with (`client.getWebSocketImpl()`),
     * NOT a raw `globalThis.WebSocket`.
     */
    createSocket?: CreateSocket;
    /** Advanced/test seam: build the audio playback subsystem. Defaults to a Web Audio implementation. */
    createSpeaker?: CreateSpeaker;

    /**
     * `DestroyRef` whose `onDestroy` tears the call down. Defaults to
     * `inject(DestroyRef)` — the calling component/service.
     */
    destroyRef?: DestroyRef;

    /** Consecutive above-`interruptThreshold` chunks that trigger a barge-in. Default `3`. */
    interruptChunks?: number;
    /** Input RMS above which the user is treated as barging in while the agent speaks. Default `0.15`. */
    interruptThreshold?: number;
    /** Milliseconds of silence (after speech) that auto-commits an utterance. Default `1200`. */
    silenceDurationMs?: number;
    /** Input RMS below which audio counts as silence. Default `0.01`. */
    silenceThreshold?: number;

    /**
     * The thread to converse on — shared with the agent's text turns. A plain
     * value, or a `Signal`/getter resolved afresh every time a call opens — the
     * reactive-args form the package's other primitives take.
     */
    threadKey: (() => string) | string;
    /** The generated `api.agents.<name>Voice` reference — identifies the voice DO endpoint. */
    voice: VoiceReference;
}

/**
 * `VoiceAgentResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
interface VoiceAgentResult {
    /** The current input RMS (0–1) — drive a mic level meter. */
    audioLevel: Signal<number>;
    /** `true` once the WS `ready` handshake completed. */
    connected: Signal<boolean>;
    /** Tear down the call: close the socket, stop the mic, release audio. Idempotent. */
    endCall: () => void;
    /** The last transport/pipeline error, or `undefined`. */
    error: Signal<Error | undefined>;
    /** The live assistant text for the in-flight turn (grows via deltas; finalized on done). */
    interimTranscript: Signal<string>;
    /** `true` while the mic is muted. */
    isMuted: Signal<boolean>;
    /** Send a typed turn (no audio) — a text message spoken back by the agent. */
    sendText: (text: string) => void;
    /** Open the mic, connect the socket, and start the conversation. Idempotent while active. */
    startCall: () => Promise<void>;
    /** The current call lifecycle. */
    status: Signal<VoiceStatus>;
    /** Mute/unmute the microphone. Returns the new muted state. */
    toggleMute: () => boolean;
    /** The last finalized user utterance (STT result). */
    transcript: Signal<string>;
}

/** WebSocket `readyState` OPEN, read structurally so no DOM `WebSocket` global is required at module load. */
const WS_OPEN = 1;

const DEFAULT_SILENCE_THRESHOLD = 0.01;
const DEFAULT_SILENCE_DURATION_MS = 1200;
const DEFAULT_INTERRUPT_THRESHOLD = 0.15;
const DEFAULT_INTERRUPT_CHUNKS = 3;

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
 * `audioLevel`) to Angular signals. Pass the generated `api.agents.<name>Voice`
 * reference (never a string), matching `agentChat`'s reference-passing style. The
 * Angular counterpart to React's `useVoiceAgent`, re-expressed with signals; the
 * per-call connection lives in a closure variable (the primitive runs once per
 * component, so no signal-of-connection indirection is needed).
 *
 * v1 transport is plain binary WebSocket frames with push-to-talk / silence-timer
 * turn detection and client-side RMS barge-in. The heavy Web Audio capture and
 * playback subsystems are injectable (`createMicrophone` / `createSpeaker` /
 * `createSocket`) so the primitive is drivable outside a browser.
 *
 * Call from an injection context (component/service field or constructor); pass an
 * explicit `client` / `destroyRef` to drive it outside one (e.g. in a test).
 * @experimental
 */
const voiceAgent = (options: VoiceAgentOptions): VoiceAgentResult => {
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

    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    // Resolved here because `inject(NgZone)` only works in the injection context,
    // while the socket and the capture graph are created later, inside `startCall`.
    const runOutside = outsideAngularRunner(fromInjectionContext);

    const status = signal<VoiceStatus>("idle");
    const connected = signal(false);
    const transcript = signal("");
    const interimTranscript = signal("");
    const audioLevel = signal(0);
    const isMuted = signal(false);
    const error = signal<Error | undefined>(undefined);

    // The live per-call connection (React's `connectionRef.current`) and the
    // "start in flight" guard (React's `startingRef.current`) — plain closure
    // variables, since a primitive body runs once per component instance.
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

            // Detach before closing: a frame that arrives (or was already queued)
            // after teardown would otherwise still run the handlers and write the
            // status/transcript/error of a call that no longer exists — the
            // handlers guard the CONNECTION mutations, not the UI writes.
            /* eslint-disable unicorn/prefer-add-event-listener */
            // eslint-disable-next-line unicorn/no-null -- the socket seam types its handler slots as `... | null`
            connection.socket.onmessage = null;
            // eslint-disable-next-line unicorn/no-null -- as above
            connection.socket.onerror = null;
            // eslint-disable-next-line unicorn/no-null -- as above
            connection.socket.onclose = null;
            /* eslint-enable unicorn/prefer-add-event-listener */

            try {
                connection.socket.close();
            } catch {
                /* already closed */
            }
        }

        starting = false;
        connected.set(false);
        status.set("idle");
        audioLevel.set(0);
    };

    const endCall = teardown;

    const handleServerFrame = (frame: VoiceServerFrame): void => {
        const connection = current;

        switch (frame.type) {
            case "assistant_delta": {
                if (connection) {
                    connection.speaking = true;
                }

                status.set("speaking");
                interimTranscript.update((current_) => current_ + frame.text);

                break;
            }
            case "assistant_done": {
                if (connection) {
                    connection.speaking = false;
                }

                interimTranscript.set(frame.text);
                status.set("listening");

                break;
            }
            case "error": {
                // A non-fatal turn failure: surface it and return the call to a
                // usable state rather than leaving it stuck "speaking"/"thinking".
                if (connection) {
                    connection.speaking = false;
                }

                error.set(new Error(frame.message));
                status.set("listening");

                break;
            }
            case "interrupted": {
                if (connection) {
                    connection.speaking = false;
                    connection.suppressAudio = false;
                }

                connection?.speaker?.interrupt();
                status.set("listening");

                break;
            }
            case "ready": {
                if (connection) {
                    connection.audioFormat = frame.audioFormat;
                    connection.suppressAudio = false;
                }

                connected.set(true);
                status.set("listening");

                break;
            }
            case "user_transcript": {
                if (connection) {
                    connection.suppressAudio = false;
                }

                transcript.set(frame.text);
                interimTranscript.set("");
                status.set("thinking");

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
        status.set("speaking");
        connection.speaker.enqueue(audio);
    };

    const startCall = async (): Promise<void> => {
        if (current || starting) {
            return;
        }

        starting = true;
        error.set(undefined);
        transcript.set("");
        interimTranscript.set("");

        let connection: VoiceConnection | undefined;

        try {
            const url = voiceSocketUrl({
                agent: agentNameFromReference(voice["__lunoraRef"]),
                httpUrl: client.url,
                threadKey: typeof threadKey === "function" ? threadKey() : threadKey,
                wsUrl: client.wsUrl,
            });
            // Default to the CLIENT's configured WebSocket implementation (not a
            // raw `globalThis.WebSocket`) — on React Native the client wraps this
            // constructor to inject the auth-headers factory's credential onto the
            // upgrade request, which a bare global reference would silently bypass,
            // leaving the voice socket uncredentialed on the cookie-jar-less runtime
            // the auth design exists for.
            const openSocket: CreateSocket =
                createSocket ??
                ((target) => {
                    const WebSocketImpl = client.getWebSocketImpl() as unknown as (new (u: string) => VoiceSocket) | undefined;

                    if (!WebSocketImpl) {
                        throw new Error("voiceAgent: no WebSocket implementation available (pass createSocket explicitly)");
                    }

                    return new WebSocketImpl(target);
                });
            const socket = runOutside(() => openSocket(url));

            socket.binaryType = "arraybuffer";

            connection = {
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
                error.set(new Error("voiceAgent: voice socket error"));
            };

            socket.onclose = (event): void => {
                if (current !== connection) {
                    return;
                }

                const closeError = voiceCloseError("voiceAgent", event);

                if (closeError) {
                    error.set(closeError);
                }

                teardown();
            };
            /* eslint-enable unicorn/prefer-add-event-listener */

            const microphone = await runOutside(async () =>
                createMicrophone({
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

                        status.set("listening");
                    },
                    onLevel: (rms) => {
                        audioLevel.set(rms);
                    },
                    onSilence: () => {
                        sendFrame({ type: "commit" });
                        status.set("thinking");
                    },
                    silenceDurationMs,
                    silenceThreshold,
                }),
            );

            // The call may have been torn down while getUserMedia was pending.
            if (current === connection) {
                connection.microphone = microphone;
                isMuted.set(false);
                // Optimistically show "listening" once the mic is live — the server's
                // `ready` frame follows and flips `connected` true. Unless the agent is
                // ALREADY speaking: the DO streams its greeting right after `ready`,
                // routinely before `getUserMedia` resolves, and overwriting that would
                // report "listening" over audio the user is hearing.
                if (!connection.speaking) {
                    status.set("listening");
                }
            } else {
                microphone.stop();
            }
        } catch (error_) {
            // `endCall()` then a second `startCall()` while `getUserMedia` was still
            // pending leaves this start owning a connection that is no longer current;
            // reporting its failure — or tearing down — would kill the NEWER call. The
            // success path above already checks the same identity. `connection` is
            // still `undefined` when the socket itself failed to open, which matches
            // the equally-undefined `current` and so reports normally.
            if (current === connection) {
                error.set(error_ instanceof Error ? error_ : new Error(String(error_)));
                teardown();
            }
        } finally {
            starting = false;
        }
    };

    const toggleMute = (): boolean => {
        const next = !isMuted();

        current?.microphone?.setMuted(next);
        isMuted.set(next);

        return next;
    };

    const sendText = (text: string): void => {
        // Only advance to "thinking" if the frame actually reached an open socket;
        // otherwise the UI would stick in "thinking" with no call.
        if (sendFrame({ text, type: "text" })) {
            status.set("thinking");
        }
    };

    // Tear the call down if the component is destroyed mid-call.
    destroyRef.onDestroy(teardown);

    return {
        audioLevel: audioLevel.asReadonly(),
        connected: connected.asReadonly(),
        endCall,
        error: error.asReadonly(),
        interimTranscript: interimTranscript.asReadonly(),
        isMuted: isMuted.asReadonly(),
        sendText,
        startCall,
        status: status.asReadonly(),
        toggleMute,
        transcript: transcript.asReadonly(),
    };
};

export type { VoiceAgentOptions, VoiceAgentResult, VoiceReference, VoiceStatus };
export type { VoiceAudioFormat } from "./voice-audio";
export { voiceAgent };
