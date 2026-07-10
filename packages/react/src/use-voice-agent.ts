"use client";

import type { FunctionReference } from "@lunora/client";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLunora } from "./lunora-provider";

/**
 * The negotiated audio format the voice DO streams back. Mirrors
 * `@lunora/agent`'s `VoiceServerFrame` `ready.audioFormat` — re-declared (not
 * imported) so this React entry never pulls in the server-only `@lunora/agent`
 * module graph.
 */
type VoiceAudioFormat = "mp3" | "wav";

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

/** Captures microphone audio and reports level / turn boundaries back to the hook. */
interface VoiceMicrophone {
    /** Mute/unmute the mic without tearing down the capture graph. */
    setMuted: (muted: boolean) => void;
    /** Stop capture and release the media stream + audio graph. */
    stop: () => void;
}

/** Plays the server's streamed audio chunks and supports a mid-utterance barge-in. */
interface VoiceSpeaker {
    /** Queue a decoded audio chunk for gap-minimized playback. */
    enqueue: (audio: Uint8Array) => void;
    /** Drop everything queued and stop the current chunk (barge-in). */
    interrupt: () => void;
    /** Release the playback audio context. */
    stop: () => void;
}

/** Config passed to a {@link CreateMicrophone} factory. */
interface MicrophoneConfig {
    /** The consecutive above-threshold chunk count that counts as a barge-in. */
    interruptChunks: number;
    /** RMS above which the user is considered to be barging in while the agent speaks. */
    interruptThreshold: number;
    /** `true` while `status === "speaking"` — gates barge-in detection. */
    isSpeaking: () => boolean;
    /** One 16 kHz mono 16-bit little-endian PCM frame captured from the mic. */
    onAudio: (pcm: Uint8Array) => void;
    /** A barge-in was detected (RMS spike while the agent is speaking). */
    onInterrupt: () => void;
    /** The current input RMS (0–1), for a level meter. */
    onLevel: (rms: number) => void;
    /** A spoken utterance ended (speech followed by `silenceDurationMs` of silence). */
    onSilence: () => void;
    /** Milliseconds of sub-threshold audio (after speech) that closes an utterance. */
    silenceDurationMs: number;
    /** RMS below which audio counts as silence. */
    silenceThreshold: number;
}

type CreateMicrophone = (config: MicrophoneConfig) => Promise<VoiceMicrophone>;
type CreateSpeaker = (config: { audioFormat: VoiceAudioFormat }) => VoiceSpeaker;
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
    /** The thread to converse on — shared with the agent's text turns. */
    threadKey: string;
    /** The generated `api.agents.&lt;name>Voice` reference — identifies the voice DO endpoint. */
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

/** Target capture format for the STT pipeline (matches `VoiceSessionDO`'s PCM contract). */
const TARGET_SAMPLE_RATE = 16_000;

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

/** Read the RMS (0–1) of a Float32 PCM block. */
const blockRms = (samples: Float32Array): number => {
    if (samples.length === 0) {
        return 0;
    }

    let sum = 0;

    for (const sample of samples) {
        sum += sample * sample;
    }

    return Math.sqrt(sum / samples.length);
};

/**
 * Downsample a Float32 block to {@link TARGET_SAMPLE_RATE} and pack it as
 * little-endian 16-bit PCM. A plain decimating resampler — adequate for speech
 * STT and dependency-free.
 */
const toPcm16 = (samples: Float32Array, inputSampleRate: number): Uint8Array => {
    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
    const outLength = ratio > 1 ? Math.floor(samples.length / ratio) : samples.length;
    const buffer = new ArrayBuffer(outLength * 2);
    const view = new DataView(buffer);

    for (let index = 0; index < outLength; index += 1) {
        const sample = samples[Math.floor(index * ratio)] ?? 0;
        const clamped = Math.max(-1, Math.min(1, sample));

        view.setInt16(index * 2, clamped < 0 ? clamped * 0x80_00 : clamped * 0x7f_ff, true);
    }

    return new Uint8Array(buffer);
};

/**
 * The default browser microphone: `getUserMedia` → a Web Audio `ScriptProcessor`
 * that tees 16 kHz PCM frames, tracks input RMS, auto-commits an utterance after
 * a silence gap, and flags a barge-in while the agent is speaking.
 */
const createBrowserMicrophone: CreateMicrophone = async (config): Promise<VoiceMicrophone> => {
    const media = globalThis as unknown as {
        AudioContext?: new () => AudioContextLike;
        navigator?: { mediaDevices?: { getUserMedia: (constraints: unknown) => Promise<MediaStreamLike> } };
        webkitAudioContext?: new () => AudioContextLike;
    };

    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- `navigator.mediaDevices` is a browser global; this factory only runs in the browser.
    const getUserMedia = media.navigator?.mediaDevices?.getUserMedia.bind(media.navigator.mediaDevices);
    const AudioContextClass = media.AudioContext ?? media.webkitAudioContext;

    if (!getUserMedia || !AudioContextClass) {
        throw new Error("useVoiceAgent: microphone capture requires getUserMedia + AudioContext (no browser audio available)");
    }

    const stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);

    let muted = false;
    let sawSpeech = false;
    let silentFor = 0;
    let loudChunks = 0;

    processor.onaudioprocess = (event): void => {
        const samples = event.inputBuffer.getChannelData(0);
        const rms = muted ? 0 : blockRms(samples);

        config.onLevel(rms);

        if (muted) {
            return;
        }

        config.onAudio(toPcm16(samples, context.sampleRate));

        // Barge-in: sustained input while the agent is speaking.
        if (config.isSpeaking()) {
            loudChunks = rms >= config.interruptThreshold ? loudChunks + 1 : 0;

            if (loudChunks >= config.interruptChunks) {
                loudChunks = 0;
                config.onInterrupt();
            }

            return;
        }

        loudChunks = 0;

        // Silence-timer turn detection: after speech, a quiet gap closes the turn.
        const chunkMs = (samples.length / context.sampleRate) * 1000;

        if (rms >= config.silenceThreshold) {
            sawSpeech = true;
            silentFor = 0;

            return;
        }

        if (sawSpeech) {
            silentFor += chunkMs;

            if (silentFor >= config.silenceDurationMs) {
                sawSpeech = false;
                silentFor = 0;
                config.onSilence();
            }
        }
    };

    source.connect(processor);
    processor.connect(context.destination);

    return {
        setMuted: (next: boolean): void => {
            muted = next;
        },
        stop: (): void => {
            processor.disconnect();
            source.disconnect();

            for (const track of stream.getTracks()) {
                track.stop();
            }

            // eslint-disable-next-line no-void -- intentionally fire-and-forget the async close.
            void context.close();
        },
    };
};

/** The default browser speaker: decode each chunk and schedule it back-to-back for gap-minimized playback. */
const createBrowserSpeaker: CreateSpeaker = (): VoiceSpeaker => {
    const media = globalThis as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
    const AudioContextClass = media.AudioContext ?? media.webkitAudioContext;

    if (!AudioContextClass) {
        throw new Error("useVoiceAgent: audio playback requires AudioContext (no browser audio available)");
    }

    const context = new AudioContextClass();
    const sources = new Set<AudioBufferSourceLike>();
    let playHead = 0;
    // Decode+schedule is serialized onto this chain so `playHead` advances in the
    // chunks' ARRIVAL order — `decodeAudioData` resolves out of order, so an
    // unchained `void play()` per chunk could schedule a later chunk ahead of an
    // earlier one and scramble the audio. A monotonic generation counter lets a
    // barge-in (`interrupt`) drop any decode still in flight when it fired.
    let chain = Promise.resolve();
    let generation = 0;

    // Decode one chunk and schedule it at the running `playHead`, dropping it if a
    // barge-in advanced the generation while it was queued or decoding. Kept as a
    // named helper so `enqueue`'s `then` callback can RETURN this promise (chaining
    // sequences the chunks) rather than being a bare void callback.
    const scheduleChunk = async (bytes: Uint8Array<ArrayBuffer>, scheduledGeneration: number): Promise<void> => {
        // A barge-in advanced the generation while this chunk was queued — drop it
        // rather than play audio the user already interrupted.
        if (scheduledGeneration !== generation) {
            return;
        }

        let decoded: { duration: number };

        try {
            decoded = await context.decodeAudioData(bytes.buffer);
        } catch {
            // Undecodable chunk — drop it rather than break the stream.
            return;
        }

        if (scheduledGeneration !== generation) {
            return;
        }

        const node = context.createBufferSource();

        node.buffer = decoded;
        node.connect(context.destination);

        const startAt = Math.max(context.currentTime, playHead);

        node.start(startAt);
        playHead = startAt + decoded.duration;
        sources.add(node);
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- structural node type exposes only the `onended` handler.
        node.onended = (): void => {
            sources.delete(node);
        };
    };

    const enqueue = (audio: Uint8Array): void => {
        // Copy into a standalone ArrayBuffer so decode never sees a shared view.
        const bytes = Uint8Array.from(audio);
        const scheduledGeneration = generation;

        chain = chain.then(() => scheduleChunk(bytes, scheduledGeneration));
    };

    const interrupt = (): void => {
        // Bump the generation so any decode still queued on the chain is dropped.
        generation += 1;

        for (const node of sources) {
            try {
                node.stop();
            } catch {
                /* already stopped */
            }
        }

        sources.clear();
        playHead = context.currentTime;
    };

    return {
        enqueue,
        interrupt,
        stop: (): void => {
            interrupt();
            // eslint-disable-next-line no-void -- intentionally fire-and-forget the async close.
            void context.close();
        },
    };
};

/** Minimal structural typings for the Web Audio surfaces the default subsystems touch. */
interface AudioBufferSourceLike {
    buffer: unknown;
    connect: (destination: unknown) => void;
    onended: (() => void) | null;
    start: (when: number) => void;
    stop: () => void;
}

interface AudioContextLike {
    close: () => Promise<void>;
    createBufferSource: () => AudioBufferSourceLike;
    createMediaStreamSource: (stream: MediaStreamLike) => { connect: (destination: unknown) => void; disconnect: () => void };
    createScriptProcessor: (
        bufferSize: number,
        inputChannels: number,
        outputChannels: number,
    ) => {
        connect: (destination: unknown) => void;
        disconnect: () => void;
        onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null;
    };
    readonly currentTime: number;
    decodeAudioData: (buffer: ArrayBuffer) => Promise<{ duration: number }>;
    readonly destination: unknown;
    readonly sampleRate: number;
}

interface MediaStreamLike {
    getTracks: () => ReadonlyArray<{ stop: () => void }>;
}

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
 * `audioLevel`) to React state. Pass the generated `api.agents.&lt;name>Voice`
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

    const endCall = useCallback((): void => {
        teardown();
    }, [teardown]);

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

        try {
            const url = voiceSocketUrl(client.url, agentNameFromReference(voice), threadKey);
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

            socket.onclose = (): void => {
                if (connectionRef.current === connection) {
                    teardown();
                }
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
                // `ready` frame follows and flips `connected` true.
                setStatus("listening");
            } else {
                microphone.stop();
            }
        } catch (error_) {
            setError(error_ instanceof Error ? error_ : new Error(String(error_)));
            teardown();
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

    return { audioLevel, connected, endCall, error, interimTranscript, isMuted, sendText, startCall, status, toggleMute, transcript };
};

export type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceAudioFormat, VoiceReference, VoiceStatus };
export { useVoiceAgent };
