import type { AiBindingLike } from "@lunora/ai";
import { createAi } from "@lunora/ai";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchRunner } from "@lunora/dispatch";

import { toBase64 } from "../../../shared/base64";
import { decodeIdentityExpiryHeader, decodeUserIdHeader, dropExpiredCredentialSocket, isIdentityExpired } from "../../../shared/identity-header";
import { createCompact, createStreamGenerate } from "./generate";
import { DEFAULT_AGENT_FUNCTION_PATHS, toFunctionReference } from "./paths";
import type { AgentDefinition, AgentFunctionPaths, AgentRunFunction, AgentStreamGenerate } from "./types";
import type { VoiceAudioSource, VoiceClientFrame, VoiceServerFrame } from "./voice-turn";
import { parseIdentity, pcmToWav, readSynthesisAudio, readTranscriptionText, runVoiceTurn, toByteIterable } from "./voice-turn";

/** Default Workers AI speech-to-text model — batch per-utterance transcription. */
const DEFAULT_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Default Workers AI text-to-speech model — streamed MP3 synthesis. */
const DEFAULT_TTS_MODEL = "@cf/deepgram/aura-1";

/** Cap a single utterance's buffered PCM (~8MB, roughly 4 min of 16kHz/16-bit audio) to bound DO memory. */
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;

/**
 * Default cap on turns one socket may run before it is closed. Each turn is a
 * full LLM generation plus sentence-by-sentence TTS — billed and persisted —
 * and the one-turn-in-flight guard bounds concurrency, not volume. Overridable
 * per agent via `voice.maxTurns`.
 */
const DEFAULT_MAX_SESSION_TURNS = 100;

/** Cap on a `text` frame's length. Beyond this the frame is refused before it reaches the model. */
const MAX_TEXT_FRAME_CHARS = 4000;

/**
 * Cap on the RAW control frame, checked before `JSON.parse`.
 *
 * The `text` bound below is measured on the parsed frame, so a 32MiB string
 * message — Cloudflare's own delivery ceiling — was fully parsed before anything
 * looked at its size, once per frame, on the DO's single thread. The margin over
 * {@link MAX_TEXT_FRAME_CHARS} is the JSON envelope plus room for escaping: a
 * frame past it cannot carry an acceptable `text` under any encoding, so there is
 * nothing to answer and the socket is closed rather than left to repeat it.
 */
const MAX_CONTROL_FRAME_CHARS = MAX_TEXT_FRAME_CHARS * 4 + 1024;

/** Close code for a socket that exhausted its turn budget (reconnect for a fresh one). */
const TURN_LIMIT_CLOSE_CODE = 4002;

/** Close code for a socket that overran the utterance buffer without committing. */
const UTTERANCE_LIMIT_CLOSE_CODE = 4003;

/** Close code for a socket that sent a control frame past {@link MAX_CONTROL_FRAME_CHARS}. */
const CONTROL_FRAME_LIMIT_CLOSE_CODE = 4004;

/** Outbound-audio backpressure: pause synthesis when the socket send buffer exceeds ~256KB so a slow client can't balloon DO memory. */
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;

/** Poll interval while waiting for the socket send buffer to drain (ms). */
const DRAIN_POLL_MS = 15;

/** Ceiling on how long one frame waits for the buffer to drain before proceeding anyway (ms) — never block a turn indefinitely. */
const MAX_DRAIN_WAIT_MS = 5000;

/**
 * Per-socket state stamped on the hibernation attachment so it survives an
 * eviction and replays to the message handlers (which get no request of their
 * own). The in-flight audio buffer + abort controller live in-memory only (a
 * mid-utterance eviction drops them — acceptable for short utterances in v1).
 */
interface VoiceSocketAttachment {
    connectionId: string;

    /**
     * Token-expiry (epoch ms) of the credential resolved at upgrade, when the
     * runtime forwarded one (`x-lunora-identity-exp`). The DO drops the socket
     * with a `TOKEN_EXPIRED` error + close code `4001` the next time it
     * receives a frame at or after this instant, so the client reconnects and
     * re-resolves a fresh identity. Absent for sockets whose identity declares
     * no expiry.
     */
    expiresAt?: number;
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
    close?: (code?: number, reason?: string) => void;
    deserializeAttachment?: () => unknown;
    send: (data: ArrayBuffer | ArrayBufferView | string) => void;
    serializeAttachment?: (value: unknown) => void;
}

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
 * @experimental
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

    /** Turn budget for one socket — see {@link DEFAULT_MAX_SESSION_TURNS}. */
    private readonly maxSessionTurns: number;

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
        // `env` also enables opt-in AI Gateway routing (LUNORA_AI_GATEWAY_*).
        this.ai = createAi({ binding: env["AI"] as AiBindingLike, env });
        this.streamGenerate = createStreamGenerate(agent, env);
        this.sttModel = agent.voice?.stt ?? DEFAULT_STT_MODEL;
        this.ttsModel = agent.voice?.tts ?? DEFAULT_TTS_MODEL;

        const configured = agent.voice?.maxTurns;

        this.maxSessionTurns = Number.isInteger(configured) && (configured as number) > 0 ? (configured as number) : DEFAULT_MAX_SESSION_TURNS;
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
        const userId = decodeUserIdHeader(request.headers.get("x-lunora-userid"));
        const expiresAt = decodeIdentityExpiryHeader(request.headers.get("x-lunora-identity-exp"));

        // A credential that was ALREADY expired before the upgrade completed
        // (the runtime forwards `x-lunora-identity-exp` but does not itself
        // reject a lapsed one — enforcing `exp` is this DO's job) must never
        // reach `ready`/a greeting: `webSocketMessage`'s check only gates
        // frames the CLIENT sends, but `speakGreeting` below runs unconditionally
        // from this handler, so without this check an already-expired socket
        // still buys one full LLM+TTS greeting turn — billed, and written to
        // the caller's thread — before any inbound frame could trip it.
        if (isIdentityExpired(expiresAt)) {
            dropExpiredCredentialSocket(server);

            // eslint-disable-next-line unicorn/no-null -- Web Response body for a 101 upgrade is `BodyInit | null`; null is the standard "no body" value
            return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
        }

        (server as unknown as HibernatableWebSocket).serializeAttachment?.({
            connectionId,
            threadKey,
            turn: 0,
            ...(expiresAt === undefined ? {} : { expiresAt }),
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

        // Same shared boundary check + `TOKEN_EXPIRED`/`4001` drop helper
        // `@lunora/do`'s `ShardDO` uses, so the two DOs can never disagree.
        if (isIdentityExpired(attachment.expiresAt)) {
            dropExpiredCredentialSocket(ws);

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

        // Whisper expects `{ audio: <base64 string> }`, not a raw number array.
        return readTranscriptionText(await this.ai.run(this.sttModel, { audio: toBase64(wav) }));
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
        // Before the parse, not after: the `text` bound further down is measured
        // on the parsed frame, so the 32MiB message Cloudflare will deliver was
        // parsed in full first.
        if (raw.length > MAX_CONTROL_FRAME_CHARS) {
            this.send(ws, { message: `control frame exceeds the maximum of ${String(MAX_CONTROL_FRAME_CHARS)} characters`, type: "error" });
            this.closeSocket(ws, CONTROL_FRAME_LIMIT_CLOSE_CODE, "control_frame_limit");

            return;
        }

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

        // Input bound, checked before anything schedules work: an unmeasured
        // `text` frame went straight to the model (a 500k-character one reached
        // it). Refuse the frame; the socket stays usable for a sane next turn.
        if (frame.type === "text" && frame.text.length > MAX_TEXT_FRAME_CHARS) {
            this.send(ws, { message: `text frame exceeds the maximum of ${String(MAX_TEXT_FRAME_CHARS)} characters`, type: "error" });

            return;
        }

        // Session bound. `turn` is the socket's monotonic turn index (advanced in
        // `runTurn`'s finally and stamped on the hibernation attachment, so it
        // survives eviction). Without this the only guard was one-turn-in-flight,
        // which bounds concurrency and not volume — an unattended socket could run
        // paid LLM+TTS turns for as long as it stayed open.
        if (attachment.turn >= this.maxSessionTurns) {
            this.send(ws, { message: `voice session reached its ${String(this.maxSessionTurns)}-turn limit — reconnect to continue`, type: "error" });
            this.closeSocket(ws, TURN_LIMIT_CLOSE_CODE, "turn_limit");

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
            // Dropping the buffer alone reset the counter, so the cap bounded peak
            // memory and NOT throughput: a client that never commits could push
            // unlimited audio, one error frame per 8MB, forever. A client that
            // overruns 8MB (~4 minutes) without a commit is not following the
            // protocol — close the socket so the bound is on the stream, not the
            // snapshot. It reconnects if it wants another utterance.
            this.closeSocket(ws, UTTERANCE_LIMIT_CLOSE_CODE, "utterance_too_large");

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
                // Same history compaction the durable loop wires. Dormant unless
                // the agent declares a `compaction` config — voice and text turns
                // share one thread, so it must not apply to only one of them.
                compact: createCompact(),
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
            const ensured = (await run(toFunctionReference(this.paths.ensureThread), {
                agent: this.exportName,
                key: threadKey,
                ...(this.agent.initialState === undefined ? {} : { initialState: this.agent.initialState }),
                ...(userId === undefined ? {} : { owner: userId }),
            })) as { outcome?: string } | undefined;

            // Greet once per THREAD, not once per upgrade. The greeting's append
            // is already keyed per thread ("voice:greeting:assistant") so it never
            // duplicated in history — but the SYNTHESIS ran unthrottled on every
            // connect, so 20 reconnects bought 20 paid TTS calls of one line. A
            // thread that already exists has been greeted (or has a history that
            // makes an opening line wrong anyway).
            if (ensured?.outcome !== "created") {
                return;
            }

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

    /** Close a socket that broke a session bound, swallowing an already-closed error (never throw from a handler). */
    // eslint-disable-next-line class-methods-use-this -- instance method (kept non-static for subclass override symmetry); acts on the passed socket
    private closeSocket(ws: WebSocket, code: number, reason: string): void {
        try {
            (ws as unknown as HibernatableWebSocket).close?.(code, reason);
        } catch {
            /* socket may already be closed */
        }
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

export default VoiceSessionDO;
