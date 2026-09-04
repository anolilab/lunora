"use client";

import type { FunctionReference } from "@lunora/client";
import { useCallback, useEffect, useRef, useState } from "react";

import { agentNameFromReference, voiceCloseError, voiceSocketUrl } from "../../../shared/voice-socket";
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
 * The `agents.<name>Voice` reference codegen emits for a voice-enabled agent — a
 * live, WS-backed session keyed by `threadKey`. A structural subset of the
 * generated member, so passing `api.agents.<name>Voice` type-checks.
 */
type VoiceReference = FunctionReference<"stream", { threadKey: string }, Record<string, unknown>>;

/** The lifecycle of a voice call, mirrored to the UI. */
type VoiceStatus = "idle" | "listening" | "speaking" | "thinking";

/** A minimal structural subset of the DOM `WebSocket` the hook drives. */
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

    /**
     * Advanced/test seam: open the transport. Defaults to the WebSocket
     * implementation the client was built with (`client.getWebSocketImpl()`),
     * NOT a raw `globalThis.WebSocket`.
     */
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
    /** The thread to converse on — shared with the agent's text turns. */
    threadKey: string;
    /** The generated `api.agents.<name>Voice` reference — identifies the voice DO endpoint. */
    voice: VoiceReference;
}

interface UseVoiceAgentResult {
    /** The current input RMS (0–1) — drive a mic level meter. */
    audioLevel: number;
    /** `true` once the WS `ready` handshake completed. */
    connected: boolean;
    /** Tear down the call: close the socket, stop the mic, release audio. Idempotent. */
    endCall: () => void;
    /** The last transport/pipeline error, or `undefined`. */
    error: Error | undefined;
    /** The live assistant text for the in-flight turn (grows via deltas; finalized on done). */
    interimTranscript: string;
    /** `true` while the mic is muted. */
    isMuted: boolean;
    /** Send a typed turn (no audio) — a text message spoken back by the agent. */
    sendText: (text: string) => void;
    /** Open the mic, connect the socket, and start the conversation. Idempotent while active. */
    startCall: () => Promise<void>;
    /** The current call lifecycle. */
    status: VoiceStatus;
    /** Mute/unmute the microphone. Returns the new muted state. */
    toggleMute: () => boolean;
    /** The last finalized user utterance (STT result). */
    transcript: string;
}

/** WebSocket `readyState` OPEN, read structurally so no DOM `WebSocket` global is required at module load. */
const WS_OPEN = 1;

const DEFAULT_SILENCE_THRESHOLD = 0.01;
const DEFAULT_SILENCE_DURATION_MS = 1200;
const DEFAULT_INTERRUPT_THRESHOLD = 0.15;
const DEFAULT_INTERRUPT_CHUNKS = 3;

/** Mutable per-call connection state, held in a ref so callbacks stay stable across renders. */
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
 * `audioLevel`) to React state. Pass the generated `api.agents.<name>Voice`
 * reference (never a string), matching `useAgentChat`'s reference-passing style.
 *
 * v1 transport is plain binary WebSocket frames with push-to-talk / silence-timer
 * turn detection and client-side RMS barge-in. The heavy Web Audio capture and
 * playback subsystems are injectable (`createMicrophone` / `createSpeaker` /
 * `createSocket`) so the hook is drivable outside a browser.
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

    const [status, setStatus] = useState<VoiceStatus>("idle");
    const [connected, setConnected] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [interimTranscript, setInterimTranscript] = useState("");
    const [audioLevel, setAudioLevel] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [error, setError] = useState<Error | undefined>(undefined);

    const connectionRef = useRef<VoiceConnection | undefined>(undefined);
    const startingRef = useRef(false);

    const sendFrame = useCallback((frame: VoiceClientFrame): boolean => {
        const socket = connectionRef.current?.socket;

        if (socket?.readyState === WS_OPEN) {
            socket.send(JSON.stringify(frame));

            return true;
        }

        return false;
    }, []);

    const teardown = useCallback((): void => {
        const connection = connectionRef.current;

        connectionRef.current = undefined;

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

        startingRef.current = false;
        setConnected(false);
        setStatus("idle");
        setAudioLevel(0);
    }, []);

    const handleServerFrame = useCallback((frame: VoiceServerFrame): void => {
        const connection = connectionRef.current;

        switch (frame.type) {
            case "assistant_delta": {
                if (connection) {
                    connection.speaking = true;
                }

                setStatus("speaking");
                setInterimTranscript((previous) => previous + frame.text);

                break;
            }
            case "assistant_done": {
                if (connection) {
                    connection.speaking = false;
                }

                setInterimTranscript(frame.text);
                setStatus("listening");

                break;
            }
            case "error": {
                // A non-fatal turn failure: surface it and return the call to a
                // usable state rather than leaving it stuck "speaking"/"thinking".
                if (connection) {
                    connection.speaking = false;
                }

                setError(new Error(frame.message));
                setStatus("listening");

                break;
            }
            case "interrupted": {
                if (connection) {
                    connection.speaking = false;
                    connection.suppressAudio = false;
                }

                connection?.speaker?.interrupt();
                setStatus("listening");

                break;
            }
            case "ready": {
                if (connection) {
                    connection.audioFormat = frame.audioFormat;
                    connection.suppressAudio = false;
                }

                setConnected(true);
                setStatus("listening");

                break;
            }
            case "user_transcript": {
                if (connection) {
                    connection.suppressAudio = false;
                }

                setTranscript(frame.text);
                setInterimTranscript("");
                setStatus("thinking");

                break;
            }
            default: {
                break;
            }
        }
    }, []);

    const handleAudioChunk = useCallback(
        (audio: Uint8Array): void => {
            const connection = connectionRef.current;

            if (!connection || connection.suppressAudio) {
                return;
            }

            connection.speaker ??= createSpeaker({ audioFormat: connection.audioFormat });
            connection.speaking = true;
            setStatus("speaking");
            connection.speaker.enqueue(audio);
        },
        [createSpeaker],
    );

    const startCall = useCallback(async (): Promise<void> => {
        if (connectionRef.current || startingRef.current) {
            return;
        }

        startingRef.current = true;
        setError(undefined);
        setTranscript("");
        setInterimTranscript("");

        let connection: VoiceConnection | undefined;

        try {
            const url = voiceSocketUrl({ agent: agentNameFromReference(voice["__lunoraRef"]), httpUrl: client.url, threadKey, wsUrl: client.wsUrl });
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
                        throw new Error("useVoiceAgent: no WebSocket implementation available (pass createSocket explicitly)");
                    }

                    return new WebSocketImpl(target);
                });
            const socket = openSocket(url);

            socket.binaryType = "arraybuffer";

            connection = {
                audioFormat: "mp3",
                microphone: undefined,
                socket,
                speaker: undefined,
                speaking: false,
                suppressAudio: false,
            };

            connectionRef.current = connection;

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
                setError(new Error("useVoiceAgent: voice socket error"));
            };

            socket.onclose = (event): void => {
                if (connectionRef.current !== connection) {
                    return;
                }

                const closeError = voiceCloseError("useVoiceAgent", event);

                if (closeError) {
                    setError(closeError);
                }

                teardown();
            };
            /* eslint-enable unicorn/prefer-add-event-listener */

            const microphone = await createMicrophone({
                interruptChunks,
                interruptThreshold,
                isSpeaking: () => connectionRef.current?.speaking ?? false,
                onAudio: (pcm) => {
                    if (socket.readyState === WS_OPEN) {
                        socket.send(pcm);
                    }
                },
                onInterrupt: () => {
                    sendFrame({ type: "interrupt" });
                    connectionRef.current?.speaker?.interrupt();

                    if (connectionRef.current) {
                        connectionRef.current.speaking = false;
                        // Drop any audio already in flight until the server acks —
                        // cleared on the next `interrupted`/`user_transcript`/`ready`.
                        connectionRef.current.suppressAudio = true;
                    }

                    setStatus("listening");
                },
                onLevel: setAudioLevel,
                onSilence: () => {
                    sendFrame({ type: "commit" });
                    setStatus("thinking");
                },
                silenceDurationMs,
                silenceThreshold,
            });

            // The call may have been torn down while getUserMedia was pending.
            if (connectionRef.current === connection) {
                connection.microphone = microphone;
                setIsMuted(false);
                // Optimistically show "listening" once the mic is live — the server's
                // `ready` frame follows and flips `connected` true. Unless the agent is
                // ALREADY speaking: the DO streams its greeting right after `ready`,
                // routinely before `getUserMedia` resolves, and overwriting that would
                // report "listening" over audio the user is hearing.
                if (!connection.speaking) {
                    setStatus("listening");
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
            if (connectionRef.current === connection) {
                setError(error_ instanceof Error ? error_ : new Error(String(error_)));
                teardown();
            }
        } finally {
            startingRef.current = false;
        }
    }, [
        client,
        createMicrophone,
        createSocket,
        handleAudioChunk,
        handleServerFrame,
        interruptChunks,
        interruptThreshold,
        sendFrame,
        silenceDurationMs,
        silenceThreshold,
        teardown,
        threadKey,
        voice,
    ]);

    const toggleMute = useCallback((): boolean => {
        const next = !isMuted;

        connectionRef.current?.microphone?.setMuted(next);
        setIsMuted(next);

        return next;
    }, [isMuted]);

    const sendText = useCallback(
        (text: string): void => {
            // Only advance to "thinking" if the frame actually reached an open
            // socket; otherwise the UI would stick in "thinking" with no call.
            if (sendFrame({ text, type: "text" })) {
                setStatus("thinking");
            }
        },
        [sendFrame],
    );

    // Tear the call down if the component unmounts mid-call.
    useEffect(() => teardown, [teardown]);

    return { audioLevel, connected, endCall: teardown, error, interimTranscript, isMuted, sendText, startCall, status, toggleMute, transcript };
};

export type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceReference, VoiceStatus };
export type { VoiceAudioFormat } from "./voice-audio";
export { useVoiceAgent };
