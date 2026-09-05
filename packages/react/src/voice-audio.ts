"use client";

/**
 * Browser Web Audio subsystems for `useVoiceAgent` — the default microphone
 * capture and speaker playback implementations injected into the hook via its
 * `createMicrophone` / `createSpeaker` seams. Kept in a sibling module so the
 * heavy Web Audio graph (and its structural DOM typings) stays isolated from the
 * hook's transport + React-state logic and remains mockable in a non-browser
 * test env.
 */

/**
 * The negotiated audio format the voice DO streams back. Mirrors
 * `@lunora/agent`'s `VoiceServerFrame` `ready.audioFormat` — re-declared (not
 * imported) so this React package never pulls in the server-only `@lunora/agent`
 * module graph.
 */
type VoiceAudioFormat = "mp3" | "wav";

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

    /**
     * `true` from the moment a turn is committed until it completes — the whole
     * `thinking` + `speaking` window, not just the audible half.
     *
     * It gates BOTH branches below, and the wider span is the point. Gated only
     * on "audibly speaking", turn detection kept running through the entire
     * STT+LLM window after a `commit`: room noise at the (deliberately low)
     * `silenceThreshold` re-armed `sawSpeech`, another quiet gap fired a SECOND
     * `commit`, and the DO refused it with "a turn is already in progress" —
     * a refusal that returns before draining the audio buffer, so the PCM
     * captured since the first commit leaked into the next utterance.
     *
     * A genuine barge-in still works in that window: it routes through the
     * `onInterrupt` branch, which needs `interruptChunks` consecutive chunks at
     * `interruptThreshold` — an order of magnitude above `silenceThreshold` —
     * and `interrupt` is exactly what the DO tells the client to send.
     */
    isTurnActive: () => boolean;
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

/** Target capture format for the STT pipeline (matches `VoiceSessionDO`'s PCM contract). */
const TARGET_SAMPLE_RATE = 16_000;

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

        // Barge-in: sustained input while a turn is in flight (thinking or
        // speaking). Turn detection is parked for the whole window — see
        // `isTurnActive`.
        if (config.isTurnActive()) {
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

export type { CreateMicrophone, CreateSpeaker, MicrophoneConfig, VoiceAudioFormat, VoiceMicrophone, VoiceSpeaker };
export { createBrowserMicrophone, createBrowserSpeaker };
