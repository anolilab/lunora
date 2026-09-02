import { fromBase64 } from "../../../shared/base64";
import { decodeIdentityHeader } from "../../../shared/identity-header";
import { compactHistory } from "./agent-loop";
import { buildModelMessages } from "./model-messages";
import { toFunctionReference } from "./paths";
import type { AgentCompact, AgentDefinition, AgentFunctionPaths, AgentMessageRow, AgentRunFunction, AgentStreamGenerate } from "./types";

/** Client-side capture format the STT WAV wrapper assumes: 16kHz, mono, 16-bit PCM. */
const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;

/**
 * Sentence terminator — one of `.!?` immediately followed by whitespace.
 * Trailing whitespace is required (no end-of-buffer alternative) so a delta that
 * momentarily ends at punctuation isn't cut mid-sentence before the next delta
 * arrives; the incomplete trailing remainder is flushed once at end-of-turn.
 *
 * Two fixed-width atoms, so the scan is linear. The previous spelling led with
 * `[^.!?]*`, and the disjoint-classes argument for it was about the wrong hazard:
 * disjoint classes rule out CATASTROPHIC (exponential) backtracking, but the
 * engine still retries the failing `[.!?]+` at every position the star gives back,
 * at every start offset — quadratic per call. {@link takeSentences} runs on the
 * whole accumulated buffer once per streamed delta, so a reply with no terminator
 * (a code block, a URL list, a table — ordinary model output) made the turn
 * cubic: a 20k-character reply measured 156 SECONDS of CPU, inside the DO.
 */
const SENTENCE_TERMINATOR = /[.!?]\s/u;

/** Whitespace run following a terminator, consumed by hand so the match stays fixed-width. */
const WHITESPACE = /\s/u;

/**
 * A control frame the server sends the client as a JSON text message (audio
 * rides separate binary frames). `ready` announces the negotiated codec on
 * connect; `user_transcript` carries the STT result; `assistant_delta` streams
 * the live LLM text; `assistant_done` is the final turn text; `interrupted`
 * acks a barge-in; `error` reports a non-fatal turn failure.
 * @experimental
 */
type VoiceServerFrame =
    | { audioFormat: "mp3" | "wav"; type: "ready" }
    | { message: string; type: "error" }
    | { text: string; type: "assistant_delta" }
    | { text: string; type: "assistant_done" }
    | { text: string; type: "user_transcript" }
    | { type: "interrupted" };

/**
 * A control frame the client sends the server (audio rides separate binary frames).
 * @experimental
 */
type VoiceClientFrame = { text: string; type: "text" } | { type: "commit" } | { type: "interrupt" };

/**
 * A synthesized-audio source the TTS seam yields — normalized to bytes by {@link toByteIterable}.
 * @experimental
 */
type VoiceAudioSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array;

/**
 * Transcribe one buffered utterance (16kHz mono 16-bit PCM) to text.
 * @experimental
 */
type VoiceTranscribe = (pcm: Uint8Array) => Promise<string>;

/**
 * Synthesize one sentence to an audio byte stream; honors `signal` for barge-in.
 * @experimental
 */
type VoiceSynthesize = (text: string, signal: AbortSignal) => Promise<VoiceAudioSource>;

/**
 * Send a JSON control frame to the client.
 * @experimental
 */
type VoiceSend = (frame: VoiceServerFrame) => void;

/**
 * Send a binary audio frame to the client.
 * @experimental
 */
type VoiceSendAudio = (bytes: Uint8Array) => void;

/**
 * The outcome of one voice turn.
 * @experimental
 */
interface VoiceTurnResult {
    /** The final assistant text (may be partial if `interrupted`). */
    assistantText: string;
    /** Whether a barge-in aborted the turn mid-stream. */
    interrupted: boolean;
    /** The transcribed (or typed) user text — empty when the utterance was silence. */
    userText: string;
}

/**
 * Options for one {@link runVoiceTurn}.
 * @experimental
 */
interface RunVoiceTurnOptions {
    /** The agent whose thread + models back this session. */
    agent: AgentDefinition;

    /**
     * History-compaction seam — the SAME one the durable loop uses. Voice and
     * text turns share one thread, so an agent that declares `compaction` must
     * get it here too; absent (or with no `compaction` config) the turn takes
     * the byte-identical uncompacted path.
     */
    compact?: AgentCompact;

    /** Stable per-socket id — the message-key prefix that keeps persisted rows idempotent. */
    connectionId: string;
    /** The Worker env (resolves a dynamic `instructions` thunk). */
    env: Record<string, unknown>;
    /** The agent's `lunora/agents.ts` export name (thread attribution). */
    exportName: string;
    /** Thread owner (the socket's verified identity), passed through to `ensureThread`. */
    owner?: string;
    /** Dispatch paths of the shared agent thread functions. */
    paths: AgentFunctionPaths;
    /** Buffered utterance PCM — transcribed via `transcribe` unless `text` is set. */
    pcm?: Uint8Array;
    /** The runtime dispatch seam reaching the agent's thread functions (`agents:*`). */
    run: AgentRunFunction;
    /** Send a JSON control frame. */
    send: VoiceSend;
    /** Send a binary audio frame. */
    sendAudio: VoiceSendAudio;
    /** Barge-in signal — aborts client output + TTS mid-turn. */
    signal: AbortSignal;
    /** The streaming LLM-turn seam (production wires AI SDK `streamText`). */
    streamGenerate: AgentStreamGenerate;
    /** Synthesize a sentence to audio. */
    synthesize: VoiceSynthesize;
    /** Typed input — when set, STT is skipped and this is the user turn. */
    text?: string;
    /** The shared agent thread key. */
    threadKey: string;
    /** Transcribe buffered `pcm` (unused when `text` is set). */
    transcribe: VoiceTranscribe;
    /** Monotonic per-connection turn index — part of the idempotent message keys. */
    turn: number;
    /** Optional outbound-audio backpressure: awaited before each audio frame so a slow client can't balloon DO memory. Never throws. */
    waitForDrain?: () => Promise<void>;
}

/** Normalize a {@link VoiceAudioSource} to an async iterable of byte chunks. */
const toByteIterable = async function* (source: VoiceAudioSource): AsyncGenerator<Uint8Array> {
    if (source instanceof Uint8Array) {
        yield source;

        return;
    }

    if (source instanceof ReadableStream) {
        const reader = source.getReader();

        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop -- draining a stream reader is inherently sequential
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                yield value;
            }
        } finally {
            reader.releaseLock();
        }

        return;
    }

    yield* source;
};

/**
 * Wrap raw PCM in a minimal 44-byte WAV (RIFF) header so the STT model decodes
 * it — Workers AI transcription expects an encoded container, not bare samples.
 */
const pcmToWav = (
    pcm: Uint8Array,
    sampleRate: number = PCM_SAMPLE_RATE,
    channels: number = PCM_CHANNELS,
    bitsPerSample: number = PCM_BITS_PER_SAMPLE,
): Uint8Array => {
    const blockAlign = (channels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buffer);
    const writeAscii = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.codePointAt(index) ?? 0);
        }
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + pcm.byteLength, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeAscii(36, "data");
    view.setUint32(40, pcm.byteLength, true);

    const out = new Uint8Array(buffer);

    out.set(pcm, 44);

    return out;
};

/**
 * Split the accumulated stream buffer into whole sentences, returning them plus
 * the trailing incomplete remainder — the seam that lets TTS start on the first
 * complete sentence while the model is still generating the rest.
 */
const takeSentences = (buffer: string): { rest: string; sentences: string[] } => {
    const sentences: string[] = [];
    let rest = buffer;
    let match = SENTENCE_TERMINATOR.exec(rest);

    while (match) {
        // Cut through the terminator and the whitespace run after it. Sliced by
        // the match's END OFFSET, not by its length: the old code used
        // `rest.slice(consumed.length)` while the match could begin past 0 — any
        // `.` not followed by whitespace (a decimal, a version, a filename, an
        // `e.g.`) pushed the match right, so the text before it was dropped from
        // the sentence and the tail was spoken twice. "See v1.2 here. Next one."
        // came out as "2 here. here. Next one."
        let end = match.index + 1;

        while (end < rest.length && WHITESPACE.test(rest[end] ?? "")) {
            end += 1;
        }

        const sentence = rest.slice(0, end).trim();

        if (sentence.length > 0) {
            sentences.push(sentence);
        }

        rest = rest.slice(end);
        match = SENTENCE_TERMINATOR.exec(rest);
    }

    return { rest, sentences };
};

/**
 * Run one conversational voice turn IN-DO: transcribe the utterance (or take the
 * typed text), persist the user turn onto the SHARED agent thread, stream the
 * assistant reply, and synthesize it sentence-by-sentence back to the client —
 * TTS overlapping generation, both cancellable by a barge-in `signal`.
 *
 * This is NOT the replay-durable Workflow tool-loop: a voice turn is
 * conversational only (no tools in v1) and not replay-safe. Persistence stays
 * idempotent by `voice:{connectionId}:{turn}:{role}` message keys so a resent
 * frame never duplicates a row; the thread tables are the same ones the durable
 * agent loop and `useAgentChat` read, so a voice session and a text session on
 * the same `threadKey` share one history.
 * @experimental
 */
const runVoiceTurn = async (options: RunVoiceTurnOptions): Promise<VoiceTurnResult> => {
    const {
        agent,
        compact,
        connectionId,
        env,
        exportName,
        owner,
        paths,
        pcm,
        run,
        send,
        sendAudio,
        signal,
        streamGenerate,
        synthesize,
        text,
        threadKey,
        transcribe,
        turn,
        waitForDrain,
    } = options;

    // Reading `signal.aborted` through a call defeats TS control-flow narrowing —
    // it is a live getter the runtime flips mid-turn, not the literal TS infers.
    const isAborted = (): boolean => signal.aborted;

    const appendMessage = toFunctionReference(paths.appendMessage);
    const ensureThread = toFunctionReference(paths.ensureThread);
    const listMessages = toFunctionReference(paths.listMessages);
    const patchThread = toFunctionReference(paths.patchThread);

    // Bootstrap FIRST: `ensureThread` carries the thread's owner gate, and
    // everything below it — transcription above all — is a paid model call. A
    // caller this thread refuses must be refused before it buys one.
    await run(ensureThread, {
        agent: exportName,
        key: threadKey,
        ...(agent.initialState === undefined ? {} : { initialState: agent.initialState }),
        ...(owner === undefined ? {} : { owner }),
    });

    // From here on the thread is marked live, so EVERY exit — the silent-utterance
    // short-circuit, a failed history read, a throwing `instructions` thunk, a
    // provider error — must hand it back idle. `agentEnsureThread` treats
    // "running" as a live run, so one uncaught failure here rejected every later
    // voice turn AND every durable text run on this thread for ABANDONED_RUN_MS
    // (13 hours). The previous shape opened this `try` three statements too late.
    try {
        const userText = (text ?? (pcm ? await transcribe(pcm) : "")).trim();

        if (userText.length === 0) {
            await run(patchThread, { key: threadKey, status: "idle" });

            return { assistantText: "", interrupted: false, userText: "" };
        }

        send({ text: userText, type: "user_transcript" });

        // The user turn: a keyed (idempotent) append, then mark the turn running.
        await run(appendMessage, { content: userText, messageKey: `voice:${connectionId}:${String(turn)}:user`, role: "user", threadKey });
        await run(patchThread, { key: threadKey, status: "running" });

        const instructions = typeof agent.instructions === "function" ? agent.instructions({ env, input: userText, threadKey }) : agent.instructions;
        const rawHistory = (await run(listMessages, { key: threadKey })) as AgentMessageRow[];
        // The SAME compaction the durable loop applies. Voice and text turns share
        // one thread by design, so an agent configured with `compaction` was
        // getting it on text turns and silently losing it on voice — a long shared
        // conversation sent its entire history to the model on every spoken turn.
        const { history, summary } = await compactHistory({ agent, compact, env }, rawHistory);
        const messages = buildModelMessages({
            history,
            ...(instructions === undefined ? {} : { instructions }),
            ...(summary === undefined ? {} : { summary }),
        });

        // TTS overlaps generation: each completed sentence is chained onto a serial
        // promise so audio frames stay in order, and every step honors `signal` so a
        // barge-in stops both the client output and the in-flight synthesis.
        let pending = "";
        // The text whose audio was actually flushed to the socket (the spoken
        // prefix). Advanced inside `speak` AFTER a sentence's frames are sent — never
        // at enqueue time — because generation routinely outpaces synthesis, so at a
        // barge-in many sentences are already queued while only the first has played.
        // On an interrupt we persist THIS rather than the model's full `result.text`,
        // so the thread history reflects what the caller actually heard.
        let spoken = "";
        let ttsChain = Promise.resolve();

        const speak = async (sentence: string): Promise<void> => {
            if (isAborted() || sentence.length === 0) {
                return;
            }

            let flushed = false;

            try {
                for await (const chunk of toByteIterable(await synthesize(sentence, signal))) {
                    if (isAborted()) {
                        break;
                    }

                    // Outbound backpressure: yield until the socket send buffer
                    // drains below the cap so a slow client can't balloon DO memory.
                    await waitForDrain?.();

                    if (isAborted()) {
                        break;
                    }

                    sendAudio(chunk);
                    flushed = true;
                }
            } catch (error) {
                send({ message: error instanceof Error ? error.message : String(error), type: "error" });
            }

            // Record the sentence in the spoken prefix only once at least one audio
            // frame reached the socket — a never-started or fully-aborted sentence is
            // excluded so the persisted history matches what the caller heard.
            if (flushed) {
                spoken = spoken.length > 0 ? `${spoken} ${sentence}` : sentence;
            }
        };

        const enqueueSpeak = (sentence: string): void => {
            ttsChain = ttsChain.then(async () => speak(sentence));
        };

        const result = await streamGenerate({ messages, signal }, (delta) => {
            if (isAborted()) {
                return;
            }

            send({ text: delta, type: "assistant_delta" });
            pending += delta;

            const { rest, sentences } = takeSentences(pending);

            pending = rest;

            for (const sentence of sentences) {
                enqueueSpeak(sentence);
            }
        });

        // Flush the trailing partial sentence, then drain the serial TTS chain.
        if (!isAborted() && pending.trim().length > 0) {
            enqueueSpeak(pending.trim());
        }

        pending = "";
        await ttsChain;

        const interrupted = isAborted();
        // On a barge-in the model may have generated past what was spoken; persist
        // only the spoken prefix so the history matches what the caller heard.
        const assistantText = interrupted ? spoken : result.text;

        await run(appendMessage, { content: assistantText, messageKey: `voice:${connectionId}:${String(turn)}:assistant`, role: "assistant", threadKey });
        await run(patchThread, { key: threadKey, status: "idle" });

        send(interrupted ? { type: "interrupted" } : { text: assistantText, type: "assistant_done" });

        return { assistantText, interrupted, userText };
    } catch (error) {
        // Any failure after the thread was marked live (STT, the history read, an
        // `instructions` thunk, a provider/Workers AI error out of streamGenerate)
        // must not leave the SHARED thread wedged at status:"running": reset it to
        // idle before propagating so `useAgentChat`, `agentEnsureThread`'s live-run
        // check, and status-sensitive logic stay consistent. An abort does NOT
        // throw — streamGenerate resolves normally — so only genuine errors reach here.
        await run(patchThread, { key: threadKey, status: "idle" });

        throw error;
    }
};

/**
 * Parse the identity envelope forwarded on the `x-lunora-identity` upgrade
 * header. Delegates to {@link decodeIdentityHeader} (base64url-encoded, with a
 * fail-soft sniffing fallback for a legacy raw-JSON header value).
 */
const parseIdentity = (raw: string | null): Record<string, unknown> | undefined => decodeIdentityHeader(raw);

/** Read the `.text` field off a Workers AI transcription result, tolerating shape drift. */
const readTranscriptionText = (result: unknown): string => {
    if (typeof result === "object" && result !== null && "text" in result) {
        const { text } = result;

        return typeof text === "string" ? text : "";
    }

    return "";
};

/** Normalize a Workers AI TTS result (stream, `Response`, or `{ audio }`) to a {@link VoiceAudioSource}. */
// eslint-disable-next-line sonarjs/function-return-type -- deliberate normalizer: collapses several Workers AI result shapes into the VoiceAudioSource union
const readSynthesisAudio = (result: unknown): VoiceAudioSource => {
    if (result instanceof Uint8Array || result instanceof ReadableStream) {
        return result;
    }

    if (result instanceof Response && result.body) {
        return result.body;
    }

    if (typeof result === "object" && result !== null && "audio" in result) {
        const { audio } = result;

        if (typeof audio === "string") {
            // Some TTS models return the audio as an `{ audio }` base64 string.
            return fromBase64(audio);
        }

        if (audio instanceof ReadableStream || audio instanceof Uint8Array) {
            return audio;
        }
    }

    return new Uint8Array(0);
};

export type {
    RunVoiceTurnOptions,
    VoiceAudioSource,
    VoiceClientFrame,
    VoiceSend,
    VoiceSendAudio,
    VoiceServerFrame,
    VoiceSynthesize,
    VoiceTranscribe,
    VoiceTurnResult,
};
export { parseIdentity, pcmToWav, readSynthesisAudio, readTranscriptionText, runVoiceTurn, toByteIterable };
