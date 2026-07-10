import type { AiBindingLike } from "@lunora/ai";
import { createAi } from "@lunora/ai";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchRunner } from "@lunora/dispatch";

import { createStreamGenerate } from "./generate";
import { buildModelMessages } from "./model-messages";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "./paths";
import type { AgentDefinition, AgentFunctionPaths, AgentMessageRow, AgentRunFunction, AgentStreamGenerate } from "./types";

/** Default Workers AI speech-to-text model — batch per-utterance transcription. */
const DEFAULT_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Default Workers AI text-to-speech model — streamed MP3 synthesis. */
const DEFAULT_TTS_MODEL = "@cf/deepgram/aura-1";

/** Client-side capture format the STT WAV wrapper assumes: 16kHz, mono, 16-bit PCM. */
const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;

/** Cap a single utterance's buffered PCM (~8MB, roughly 4 min of 16kHz/16-bit audio) to bound DO memory. */
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;

/** Outbound-audio backpressure: pause synthesis when the socket send buffer exceeds ~256KB so a slow client can't balloon DO memory. */
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;

/** Poll interval while waiting for the socket send buffer to drain (ms). */
const DRAIN_POLL_MS = 15;

/** Ceiling on how long one frame waits for the buffer to drain before proceeding anyway (ms) — never block a turn indefinitely. */
const MAX_DRAIN_WAIT_MS = 5000;

/**
 * Sentence boundary — a run of terminal punctuation followed by whitespace.
 * Trailing whitespace is required (no end-of-buffer alternative) so a delta that
 * momentarily ends at punctuation isn't cut mid-sentence before the next delta
 * arrives; the incomplete trailing remainder is flushed once at end-of-turn. The
 * two character classes (`[^.!?]` and `[.!?]`) are disjoint, so no input can
 * backtrack across them; the ReDoS heuristic is a false positive.
 */
// eslint-disable-next-line sonarjs/slow-regex -- disjoint char classes make this linear; see the note above
const SENTENCE_BOUNDARY = /[^.!?]*[.!?]+\s+/u;

/**
 * A control frame the server sends the client as a JSON text message (audio
 * rides separate binary frames). `ready` announces the negotiated codec on
 * connect; `user_transcript` carries the STT result; `assistant_delta` streams
 * the live LLM text; `assistant_done` is the final turn text; `interrupted`
 * acks a barge-in; `error` reports a non-fatal turn failure.
 */
type VoiceServerFrame =
    | { audioFormat: "mp3" | "wav"; type: "ready" }
    | { message: string; type: "error" }
    | { text: string; type: "assistant_delta" }
    | { text: string; type: "assistant_done" }
    | { text: string; type: "user_transcript" }
    | { type: "interrupted" };

/** A control frame the client sends the server (audio rides separate binary frames). */
type VoiceClientFrame = { text: string; type: "text" } | { type: "commit" } | { type: "interrupt" };

/** A synthesized-audio source the TTS seam yields — normalized to bytes by {@link toByteIterable}. */
type VoiceAudioSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array;

/** Transcribe one buffered utterance (16kHz mono 16-bit PCM) to text. */
type VoiceTranscribe = (pcm: Uint8Array) => Promise<string>;

/** Synthesize one sentence to an audio byte stream; honors `signal` for barge-in. */
type VoiceSynthesize = (text: string, signal: AbortSignal) => Promise<VoiceAudioSource>;

/** Send a JSON control frame to the client. */
type VoiceSend = (frame: VoiceServerFrame) => void;

/** Send a binary audio frame to the client. */
type VoiceSendAudio = (bytes: Uint8Array) => void;

/** The outcome of one voice turn. */
interface VoiceTurnResult {
    /** The final assistant text (may be partial if `interrupted`). */
    assistantText: string;
    /** Whether a barge-in aborted the turn mid-stream. */
    interrupted: boolean;
    /** The transcribed (or typed) user text — empty when the utterance was silence. */
    userText: string;
}

/** Options for one {@link runVoiceTurn}. */
interface RunVoiceTurnOptions {
    /** The agent whose thread + models back this session. */
    agent: AgentDefinition;
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
const pcmToWav = (pcm: Uint8Array, sampleRate = PCM_SAMPLE_RATE, channels = PCM_CHANNELS, bitsPerSample = PCM_BITS_PER_SAMPLE): Uint8Array => {
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
    let match = SENTENCE_BOUNDARY.exec(rest);

    while (match && match[0].length > 0) {
        const consumed = match[0];
        const sentence = consumed.trim();

        if (sentence.length > 0) {
            sentences.push(sentence);
        }

        rest = rest.slice(consumed.length);
        match = SENTENCE_BOUNDARY.exec(rest);
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
 */
const runVoiceTurn = async (options: RunVoiceTurnOptions): Promise<VoiceTurnResult> => {
    const {
        agent,
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

    const userText = (text ?? (pcm ? await transcribe(pcm) : "")).trim();

    if (userText.length === 0) {
        return { assistantText: "", interrupted: false, userText: "" };
    }

    send({ text: userText, type: "user_transcript" });

    // Bootstrap + user turn: get-or-create thread, keyed append (both idempotent).
    await run(ensureThread, {
        agent: exportName,
        key: threadKey,
        ...(agent.initialState === undefined ? {} : { initialState: agent.initialState }),
        ...(owner === undefined ? {} : { owner }),
    });
    await run(appendMessage, { content: userText, messageKey: `voice:${connectionId}:${String(turn)}:user`, role: "user", threadKey });
    await run(patchThread, { key: threadKey, status: "running" });

    const instructions = typeof agent.instructions === "function" ? agent.instructions({ env, input: userText, threadKey }) : agent.instructions;
    const history = (await run(listMessages, { key: threadKey })) as AgentMessageRow[];
    const messages = buildModelMessages({ history, ...(instructions === undefined ? {} : { instructions }) });

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

    try {
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
        // A non-abort failure (e.g. a provider/Workers AI error thrown by
        // streamGenerate) must not leave the SHARED thread wedged at
        // status:"running": reset it to idle before propagating so `useAgentChat`
        // and status-sensitive logic stay consistent. An abort does NOT throw —
        // streamGenerate resolves normally — so only genuine errors reach here.
        await run(patchThread, { key: threadKey, status: "idle" });

        throw error;
    }
};

/**
 * Per-socket state stamped on the hibernation attachment so it survives an
 * eviction and replays to the message handlers (which get no request of their
 * own). The in-flight audio buffer + abort controller live in-memory only (a
 * mid-utterance eviction drops them — acceptable for short utterances in v1).
 */
interface VoiceSocketAttachment {
    connectionId: string;
    identity?: Record<string, unknown>;
    threadKey: string;
    turn: number;
    userId?: string;
}

/** Structural subset of `DurableObjectState` the voice DO needs (typed locally for unit doubles). */
interface VoiceSessionState {
    acceptWebSocket: (ws: WebSocket, tags?: string[]) => void;
    getWebSockets: (tag?: string) => WebSocket[];
    waitUntil?: (promise: Promise<unknown>) => void;
}

/** The hibernation-attachment methods the runtime adds to every accepted socket. */
interface HibernatableWebSocket {
    deserializeAttachment?: () => unknown;
    send: (data: ArrayBuffer | ArrayBufferView | string) => void;
    serializeAttachment?: (value: unknown) => void;
}

/** Parse the JSON identity envelope forwarded on the `x-lunora-identity` upgrade header. */
const parseIdentity = (raw: string | null): Record<string, unknown> | undefined => {
    if (!raw) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

/** Read the `.text` field off a Workers AI transcription result, tolerating shape drift. */
const readTranscriptionText = (result: unknown): string => {
    if (typeof result === "object" && result !== null && "text" in result) {
        const { text } = result;

        return typeof text === "string" ? text : "";
    }

    return "";
};

/**
 * Base64-encode bytes for the Workers AI transcription input — Whisper expects
 * `{ audio: &lt;base64 string> }`, not a raw number array. Encoded in fixed-size
 * chunks so a large utterance never blows the call stack via a spread into
 * `String.fromCharCode`.
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
    const CHUNK = 0x80_00;
    let binary = "";

    for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCodePoint(...bytes.subarray(index, index + CHUNK));
    }

    return btoa(binary);
};

/** Base64-decode a string to bytes (some TTS models return an `{ audio }` base64 string). */
const base64ToBytes = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
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
            return base64ToBytes(audio);
        }

        if (audio instanceof ReadableStream || audio instanceof Uint8Array) {
            return audio;
        }
    }

    return new Uint8Array(0);
};

/**
 * A hibernatable-WebSocket Durable Object that runs an agent's real-time VOICE
 * session. One instance per `threadKey`: the client opens a WebSocket, streams
 * 16kHz mono PCM as binary frames, and marks utterance boundaries with a JSON
 * `{ type: "commit" }` control frame; the DO transcribes the utterance, streams
 * the agent's reply through the LLM, and synthesizes it back as MP3 binary
 * frames — all IN-DO. It SHARES the agent's `agent_threads`/`agent_messages`
 * tables through the same runtime dispatch seam the durable loop uses, so voice
 * and text turns interleave on one history.
 *
 * Codegen emits a thin subclass per voice-enabled agent (e.g.
 * `SupportVoiceDO extends VoiceSessionDO`, constructed with the agent
 * definition + its export name) bound under the agent's `VOICE_...` Durable
 * Object binding.
 */
class VoiceSessionDO {
    protected readonly agent: AgentDefinition;

    protected readonly ai: ReturnType<typeof createAi>;

    protected readonly env: Record<string, unknown>;

    protected readonly exportName: string;

    protected readonly paths: AgentFunctionPaths;

    protected readonly streamGenerate: AgentStreamGenerate;

    protected readonly sttModel: string;

    protected readonly ttsModel: string;

    private readonly audioBuffers = new Map<string, Uint8Array[]>();

    private readonly bufferedBytes = new Map<string, number>();

    private readonly controllers = new Map<string, AbortController>();

    private readonly state: VoiceSessionState;

    public constructor(state: VoiceSessionState, env: Record<string, unknown>, agent: AgentDefinition, exportName: string) {
        this.state = state;
        this.env = env;
        this.agent = agent;
        this.exportName = exportName;
        this.paths = DEFAULT_AGENT_FUNCTION_PATHS;
        this.ai = createAi({ binding: env["AI"] as AiBindingLike });
        this.streamGenerate = createStreamGenerate(agent, env);
        this.sttModel = agent.voice?.stt ?? DEFAULT_STT_MODEL;
        this.ttsModel = agent.voice?.tts ?? DEFAULT_TTS_MODEL;
    }

    /** HTTP entry — only a WebSocket upgrade carrying a `threadKey` is accepted. */
    public fetch(request: Request): Response {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected a WebSocket upgrade", { status: 426 });
        }

        const url = new URL(request.url);
        const threadKey = url.searchParams.get("threadKey");

        if (!threadKey) {
            return new Response("Missing threadKey", { status: 400 });
        }

        // `WebSocketPair` + the `webSocket` ResponseInit field are workerd-only
        // globals absent from the DOM lib this package types against — reach them
        // structurally off `globalThis` rather than pulling in workers-types.
        const WebSocketPairConstructor = (globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;
        const pair = new WebSocketPairConstructor();
        const client = pair[0];
        const server = pair[1];

        this.state.acceptWebSocket(server);

        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- workerd provides the Web Crypto global; this DO never runs under Node
        const connectionId = crypto.randomUUID();
        const identity = parseIdentity(request.headers.get("x-lunora-identity"));
        const userId = request.headers.get("x-lunora-userid") ?? undefined;

        (server as unknown as HibernatableWebSocket).serializeAttachment?.({
            connectionId,
            threadKey,
            turn: 0,
            ...(identity === undefined ? {} : { identity }),
            ...(userId === undefined ? {} : { userId }),
        } satisfies VoiceSocketAttachment);

        this.send(server, { audioFormat: this.agent.voice?.audioFormat ?? "mp3", type: "ready" });

        const greeting = this.agent.voice?.greeting;

        if (greeting && greeting.length > 0) {
            this.state.waitUntil?.(this.speakGreeting(server, connectionId, threadKey, userId, identity, greeting));
        }

        // eslint-disable-next-line unicorn/no-null -- Web Response body for a 101 upgrade is `BodyInit | null`; null is the standard "no body" value
        return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
    }

    /** Hibernation message handler — never throws (a thrown handler is fatal to the socket). */
    public async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
        const attachment = (ws as unknown as HibernatableWebSocket).deserializeAttachment?.() as VoiceSocketAttachment | undefined;

        if (!attachment) {
            return;
        }

        try {
            if (typeof message === "string") {
                await this.handleControl(ws, attachment, message);

                return;
            }

            this.bufferAudio(attachment.connectionId, new Uint8Array(message), ws);
        } catch (error) {
            this.send(ws, { message: error instanceof Error ? error.message : String(error), type: "error" });
        }
    }

    /** Abort any in-flight turn + free the socket's buffers on close. Never throws. */
    public webSocketClose(ws: WebSocket): void {
        this.cleanupSocket(ws);
    }

    /** Abort any in-flight turn + free the socket's buffers on error. Never throws. */
    public webSocketError(ws: WebSocket): void {
        this.cleanupSocket(ws);
    }

    /**
     * The runtime dispatch seam reaching the shared agent thread functions. When
     * the socket carries a verified identity it is forwarded so the `agents:*`
     * thread writes are attributed to the caller (RLS / row ownership) rather
     * than the anonymous system dispatch.
     */
    protected resolveRun(userId?: string, claims?: Record<string, unknown>): AgentRunFunction {
        const identity =
            userId === undefined && claims === undefined
                ? undefined
                : { ...(claims === undefined ? {} : { claims }), ...(userId === undefined ? {} : { userId }) };

        return createDispatchRunner({ env: this.env, label: "@lunora/agent voice", ...(identity === undefined ? {} : { identity }) });
    }

    /** Production STT seam: WAV-wrap the utterance and run the batch transcription model. */
    protected async transcribe(pcm: Uint8Array): Promise<string> {
        const wav = pcmToWav(pcm);

        return readTranscriptionText(await this.ai.run(this.sttModel, { audio: bytesToBase64(wav) }));
    }

    /** Production TTS seam: synthesize one sentence to a normalized audio source; `signal` aborts an in-flight barge-in. */
    protected async synthesize(text: string, signal?: AbortSignal): Promise<VoiceAudioSource> {
        const speaker = this.agent.voice?.speaker;

        return readSynthesisAudio(
            await this.ai.run(this.ttsModel, { text, ...(speaker === undefined ? {} : { speaker }) }, signal === undefined ? undefined : { signal }),
        );
    }

    /** Route a JSON control frame (`commit` / `interrupt` / `text`). */
    private async handleControl(ws: WebSocket, attachment: VoiceSocketAttachment, raw: string): Promise<void> {
        let frame: VoiceClientFrame;

        try {
            frame = JSON.parse(raw) as VoiceClientFrame;
        } catch {
            return;
        }

        if (frame.type === "interrupt") {
            this.controllers.get(attachment.connectionId)?.abort();

            return;
        }

        if (this.controllers.has(attachment.connectionId)) {
            // A turn is already in flight — the client must `interrupt` before the
            // next utterance. Drop the overlapping trigger rather than interleave.
            this.send(ws, { message: "a turn is already in progress — send an interrupt before the next utterance", type: "error" });

            return;
        }

        if (frame.type === "commit") {
            const pcm = this.drainAudio(attachment.connectionId);

            await this.runTurn(ws, attachment, { pcm });

            return;
        }

        await this.runTurn(ws, attachment, { text: frame.text });
    }

    /** Append a binary audio frame to the socket's utterance buffer (bounded). */
    private bufferAudio(connectionId: string, chunk: Uint8Array, ws: WebSocket): void {
        const total = (this.bufferedBytes.get(connectionId) ?? 0) + chunk.byteLength;

        if (total > MAX_UTTERANCE_BYTES) {
            this.audioBuffers.delete(connectionId);
            this.bufferedBytes.delete(connectionId);
            this.send(ws, { message: "utterance exceeded the maximum buffer — send a commit sooner", type: "error" });

            return;
        }

        const chunks = this.audioBuffers.get(connectionId) ?? [];

        chunks.push(chunk);
        this.audioBuffers.set(connectionId, chunks);
        this.bufferedBytes.set(connectionId, total);
    }

    /** Concatenate + clear the socket's buffered utterance. */
    private drainAudio(connectionId: string): Uint8Array {
        const chunks = this.audioBuffers.get(connectionId) ?? [];

        this.audioBuffers.delete(connectionId);
        this.bufferedBytes.delete(connectionId);

        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const pcm = new Uint8Array(total);
        let offset = 0;

        for (const chunk of chunks) {
            pcm.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return pcm;
    }

    /** Execute a turn under a fresh abort controller, advancing the socket's turn index. */
    private async runTurn(ws: WebSocket, attachment: VoiceSocketAttachment, input: { pcm?: Uint8Array; text?: string }): Promise<void> {
        const controller = new AbortController();

        this.controllers.set(attachment.connectionId, controller);

        try {
            await runVoiceTurn({
                agent: this.agent,
                connectionId: attachment.connectionId,
                env: this.env,
                exportName: this.exportName,
                paths: this.paths,
                run: this.resolveRun(attachment.userId, attachment.identity),
                send: (frame) => {
                    this.send(ws, frame);
                },
                sendAudio: (bytes) => {
                    this.sendAudio(ws, bytes);
                },
                signal: controller.signal,
                streamGenerate: this.streamGenerate,
                synthesize: async (text, signal) => this.synthesizeWithSignal(text, signal),
                threadKey: attachment.threadKey,
                transcribe: async (pcm) => this.transcribe(pcm),
                turn: attachment.turn,
                waitForDrain: async () => this.waitForSocketDrain(ws),
                ...(attachment.userId === undefined ? {} : { owner: attachment.userId }),
                ...(input.pcm === undefined ? {} : { pcm: input.pcm }),
                ...(input.text === undefined ? {} : { text: input.text }),
            });
        } finally {
            if (this.controllers.get(attachment.connectionId) === controller) {
                this.controllers.delete(attachment.connectionId);
            }

            (ws as unknown as HibernatableWebSocket).serializeAttachment?.({ ...attachment, turn: attachment.turn + 1 } satisfies VoiceSocketAttachment);
        }
    }

    /** Synthesize a greeting on connect and persist it as the thread's opening assistant turn. */
    private async speakGreeting(
        ws: WebSocket,
        connectionId: string,
        threadKey: string,
        userId: string | undefined,
        identity: Record<string, unknown> | undefined,
        greeting: string,
    ): Promise<void> {
        const run = this.resolveRun(userId, identity);
        const controller = new AbortController();
        // Read `aborted` through a call so TS control-flow narrowing doesn't treat
        // it as the literal `false` from the first check across the awaits — the
        // runtime flips it mid-loop on a barge-in (same reason `runVoiceTurn` uses
        // an `isAborted` helper).
        const isAborted = (): boolean => controller.signal.aborted;

        // Register the greeting under the connection's controller key so it is
        // interruptible and guarded like a normal turn: an `interrupt` frame aborts
        // it (handleControl calls `controllers.get(connectionId).abort()`), and a
        // concurrent `commit`/`text` hits the in-progress guard instead of running
        // runTurn() alongside it — otherwise both would emit binary frames on the
        // same socket and the audio would interleave.
        this.controllers.set(connectionId, controller);

        try {
            await run(toFunctionReference(this.paths.ensureThread), {
                agent: this.exportName,
                key: threadKey,
                ...(this.agent.initialState === undefined ? {} : { initialState: this.agent.initialState }),
                ...(userId === undefined ? {} : { owner: userId }),
            });

            for await (const chunk of toByteIterable(await this.synthesizeWithSignal(greeting, controller.signal))) {
                if (isAborted()) {
                    break;
                }

                await this.waitForSocketDrain(ws);

                if (isAborted()) {
                    break;
                }

                this.sendAudio(ws, chunk);
            }

            // On a barge-in over the greeting the caller never heard the whole
            // line, so skip persisting it and the done frame — mirrors a turn's
            // "reflect what the caller heard" invariant.
            if (!isAborted()) {
                // Keyed stably per thread (NOT per connection) so a greeting
                // persists exactly once no matter how many sockets a thread opens —
                // the append is idempotent by `messageKey`.
                await run(toFunctionReference(this.paths.appendMessage), {
                    content: greeting,
                    messageKey: "voice:greeting:assistant",
                    role: "assistant",
                    threadKey,
                });
                this.send(ws, { text: greeting, type: "assistant_done" });
            }
        } catch (error) {
            this.send(ws, { message: error instanceof Error ? error.message : String(error), type: "error" });
        } finally {
            // Free the greeting's controller slot so subsequent turns register
            // their own (guard against clobbering an in-flight turn's controller).
            if (this.controllers.get(connectionId) === controller) {
                this.controllers.delete(connectionId);
            }
        }
    }

    /** Bridge the pipeline's `(text, signal)` synthesize seam onto the class TTS method, forwarding the barge-in signal. */
    private async synthesizeWithSignal(text: string, signal: AbortSignal): Promise<VoiceAudioSource> {
        if (signal.aborted) {
            return new Uint8Array(0);
        }

        return this.synthesize(text, signal);
    }

    /** Abort an in-flight turn and free a socket's transient buffers. */
    private cleanupSocket(ws: WebSocket): void {
        const attachment = (ws as unknown as HibernatableWebSocket).deserializeAttachment?.() as VoiceSocketAttachment | undefined;

        if (!attachment) {
            return;
        }

        this.controllers.get(attachment.connectionId)?.abort();
        this.controllers.delete(attachment.connectionId);
        this.audioBuffers.delete(attachment.connectionId);
        this.bufferedBytes.delete(attachment.connectionId);
    }

    /** Send a JSON control frame, swallowing a closed-socket error (never throw from a handler). */
    // eslint-disable-next-line class-methods-use-this -- instance method (kept non-static for subclass override symmetry); acts on the passed socket
    private send(ws: WebSocket, frame: VoiceServerFrame): void {
        try {
            (ws as unknown as HibernatableWebSocket).send(JSON.stringify(frame));
        } catch {
            /* socket may already be closed */
        }
    }

    /** Send a binary audio frame, swallowing a closed-socket error. */
    // eslint-disable-next-line class-methods-use-this -- instance method (kept non-static for subclass override symmetry); acts on the passed socket
    private sendAudio(ws: WebSocket, bytes: Uint8Array): void {
        try {
            (ws as unknown as HibernatableWebSocket).send(bytes);
        } catch {
            /* socket may already be closed */
        }
    }

    /**
     * Outbound backpressure: if the socket exposes `bufferedAmount`, yield in
     * short polls until the send buffer drains below the cap so a slow client
     * can't balloon DO memory. Bounded by {@link MAX_DRAIN_WAIT_MS} so a stuck
     * socket never blocks a turn forever, and never throws (a socket without
     * `bufferedAmount` resolves immediately).
     */
    // eslint-disable-next-line class-methods-use-this -- instance method (kept non-static for subclass override symmetry); acts on the passed socket
    private async waitForSocketDrain(ws: WebSocket): Promise<void> {
        const socket = ws as unknown as { bufferedAmount?: number };
        let waited = 0;

        while (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES && waited < MAX_DRAIN_WAIT_MS) {
            // eslint-disable-next-line no-await-in-loop -- polling loop: each iteration must wait before re-reading bufferedAmount
            await new Promise((resolve) => {
                setTimeout(resolve, DRAIN_POLL_MS);
            });
            waited += DRAIN_POLL_MS;
        }
    }
}

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
export { runVoiceTurn, VoiceSessionDO };
