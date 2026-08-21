/**
 * The durable-stream state machine: who may attach to a stored run, and who
 * drives the producer.
 *
 * Lives here rather than in a host because nothing about it is host-specific —
 * it touches SQLite through {@link SqlExec}, the transcript store next door, and
 * one optional `waitUntil`. The host's job is narrower: turn a socket into a
 * {@link DurableStreamSink} and hand over a run key.
 *
 * The rule the whole feature turns on: **a transcript is the record of one
 * execution, not a cached response.** A caller resuming a run it already holds
 * part of gets the rest; a caller asking the same question fresh gets a fresh
 * run. Getting that backwards makes a durable stream a response cache with a
 * 24-hour TTL — stale answers for everyone, and a failed run re-served as the
 * same error with no way to retry.
 */
import { LunoraError, toErrorBody } from "@lunora/errors";

import { encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import type { DurableStreamRun } from "./durable-stream";
import { appendStreamChunk, claimStreamRun, deleteStreamRun, finishStreamRun, readStreamChunks, readStreamRun, trimStreamRuns } from "./durable-stream";

/**
 * Hard ceiling on the chunks one run may persist.
 *
 * A token-at-a-time generation is thousands of chunks, which is fine; a runaway
 * generator is unbounded, which is not — the transcript shares the shard's
 * SQLite with application data, so "grow until the storage limit" takes every
 * other function on that shard down with it.
 */
const MAX_DURABLE_STREAM_CHUNKS = 50_000;

/**
 * Hard ceiling on the BYTES one run may persist.
 *
 * The chunk count alone bounds nothing that matters: 50,000 chunks of 1 MiB is
 * ~50 GiB against a per-DO ceiling of 10 GiB, and this store shares the shard's
 * SQLite with application data. 64 MiB is far past any token stream and far
 * under the point where one run threatens the shard.
 */
const MAX_DURABLE_STREAM_BYTES = 64 * 1024 * 1024;

/** Default retention for a finished transcript: long enough to survive a reload and a commute. */
const DEFAULT_TTL_MS = 86_400_000;

/** Minimum spacing between TTL sweeps, amortized onto a run start. */
const GC_INTERVAL_MS = 3_600_000;

/**
 * One consumer attached to a run. The producer fans every chunk out to each
 * attached sink and calls exactly one terminal; a detached sink is simply no
 * longer in the set.
 */
interface DurableStreamSink {
    /**
     * Deliver one chunk. `false` = the consumer is gone, and the sink is
     * dropped. `generation` is the run's `startedAt` stamp — the host forwards
     * it to the consumer so a resume can prove it is continuing the same run.
     */
    readonly chunk: (chunk: { data: unknown; generation?: number; seq: number }) => boolean;
    /** The run finished successfully. */
    readonly complete: () => void;
    /** The run failed — the message is already redacted. */
    readonly fail: (failure: { code: string; message: string }) => void;
}

/** What an attach should do about the run row it found — see {@link decideDurableAttach}. */
type DurableAttachDecision = "attach" | "interrupted" | "reclaim" | "replay-terminal";

/**
 * Decide how a stored run may serve this caller.
 *
 * Pure, and the interesting part of the feature: the answer turns entirely on
 * whether the caller is RESUMING a transcript it already holds part of, or
 * asking fresh.
 *
 * `replay-terminal` is a finished run whose watcher came back — hand back the
 * tail plus the recorded outcome. `interrupted` is a producer that died mid-run
 * while this caller holds a prefix; the tail cannot be spliced on and
 * re-generating would duplicate it, so say so rather than pretend. `reclaim` is
 * a stored run this caller has no claim on (finished, or dead with nobody
 * resuming) — drop it and produce, so an eviction cannot wedge the key until its
 * TTL expires. `attach` joins the live producer, or starts one.
 *
 * `context.generation` is the `startedAt` stamp of the run the caller's held
 * prefix belongs to. The run key is shared across a user's tabs, so a resume
 * can land on a DIFFERENT run under the same key (another tab reclaimed it and
 * started over) — a generation mismatch is `"interrupted"`, checked before the
 * `live` short-circuit precisely because the live producer can be the foreign
 * run. A caller that sends no generation (older client) keeps the previous
 * behavior.
 */
const decideDurableAttach = (run: DurableStreamRun | undefined, context: { generation?: number; live: boolean; resuming: boolean }): DurableAttachDecision => {
    if (run === undefined) {
        // A resuming caller holds a prefix of a transcript that no longer
        // exists (trimmed, or reclaimed); attaching fresh would silently
        // splice a new run onto it.
        return context.resuming ? "interrupted" : "attach";
    }

    if (context.resuming && context.generation !== undefined && context.generation !== run.startedAt) {
        return "interrupted";
    }

    if (context.live) {
        return "attach";
    }

    if (run.status === "complete" || run.status === "error") {
        return context.resuming ? "replay-terminal" : "reclaim";
    }

    // `running` with no live producer: the instance died mid-generation.
    return context.resuming ? "interrupted" : "reclaim";
};

/** One attach request, from the host's point of view. */
interface DurableStreamAttach {
    /**
     * `startedAt` stamp of the run the caller's held prefix belongs to, echoed
     * back by a resuming consumer. Absent on a first attach and from older
     * clients that predate the stamp.
     */
    readonly generation?: number;
    /** Builds the handler's async iterable; called only when this attach starts the run. */
    readonly iterator: (signal: AbortSignal) => AsyncIterable<unknown>;
    /** Identity of the run — the host folds in the caller's identity, function path, and arguments. */
    readonly runKey: string;
    /** Highest chunk `seq` the caller already holds; `0` means "asking fresh". */
    readonly sinceChunk: number;
    readonly sink: DurableStreamSink;
    /** Retention for a run this attach starts. */
    readonly ttlMs?: number;
}

/**
 * Settle an `"interrupted"` attach. On a generation mismatch the persisted
 * chunks belong to a DIFFERENT run than the prefix the caller holds, so they
 * are NOT replayed — delivering them is exactly the splice the decision exists
 * to prevent. A dead producer of the caller's own run replays the persisted
 * tail first.
 */
const failInterrupted = (run: DurableStreamRun | undefined, request: DurableStreamAttach, sink: DurableStreamSink, replay: () => boolean): void => {
    const mismatched = run !== undefined && request.generation !== undefined && request.generation !== run.startedAt;

    if (mismatched || replay()) {
        sink.fail({
            code: "STREAM_INTERRUPTED",
            message: mismatched
                ? "the run this durable stream resumed from no longer exists; start a new run"
                : "the producer for this durable stream did not survive; start a new run",
        });
    }
};

/**
 * Drives durable runs for one shard. In-memory state tracks who is *currently*
 * producing; the transcript itself lives in SQLite, which is what lets an attach
 * on a later instance still replay it.
 */
class DurableStreamRunner {
    private lastTrimAt = 0;

    private readonly runs = new Map<string, { generation: number; sinks: Set<DurableStreamSink> }>();

    private readonly sql: () => SqlExec;

    private readonly waitUntil: ((promise: Promise<unknown>) => void) | undefined;

    public constructor(dependencies: { sql: () => SqlExec; waitUntil?: (promise: Promise<unknown>) => void }) {
        this.sql = dependencies.sql;
        this.waitUntil = dependencies.waitUntil;
    }

    /**
     * Attach a consumer, starting the run when this attach is the first.
     *
     * Nothing awaits between reading the run row and registering the sink — a DO
     * handles one event at a time — so there is no window in which a chunk is
     * neither replayed nor delivered live.
     */
    public async attach(request: DurableStreamAttach): Promise<void> {
        try {
            await this.attachOrThrow(request);
        } catch (error: unknown) {
            // The host has already acked by the time this runs, so a throw that
            // escapes leaves the consumer waiting on a stream that can never
            // settle — the store read is the likely source (a pre-migration
            // shard, a stub handle). Fail the sink instead: it is the only path
            // that releases the consumer AND its host-side slot.
            const { body, redacted } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "internal error" });

            if (redacted) {
                // eslint-disable-next-line no-console -- server-side diagnostic for an internal/unhandled attach error
                console.error("[@lunora/shard-engine] durable stream attach failed:", error);
            }

            request.sink.fail({ code: body.code, message: body.message });
        }
    }

    /** Detach a consumer without disturbing the producer — cancelling a durable stream leaves the run going. */
    public detach(runKey: string, sink: DurableStreamSink): void {
        this.runs.get(runKey)?.sinks.delete(sink);
    }

    /** Whether a run is currently producing on this instance. */
    public isLive(runKey: string): boolean {
        return this.runs.has(runKey);
    }

    /** The attach state machine proper — see {@link DurableStreamRunner.attach}, which owns its failure path. */
    private async attachOrThrow(request: DurableStreamAttach): Promise<void> {
        const sql = this.sql();
        const { runKey, sinceChunk, sink } = request;
        const run = readStreamRun(sql, runKey);
        const resuming = sinceChunk > 0;
        const live = this.runs.get(runKey);
        const decision = decideDurableAttach(run, { generation: request.generation, live: live !== undefined, resuming });
        const replay = (): boolean => {
            for (const chunk of readStreamChunks(sql, runKey, sinceChunk)) {
                if (!sink.chunk({ data: JSON.parse(chunk.dataJson) as unknown, generation: run?.startedAt, seq: chunk.seq })) {
                    return false;
                }
            }

            return true;
        };

        if (decision === "replay-terminal") {
            if (replay()) {
                if (run?.status === "error") {
                    sink.fail({ code: run.errorCode ?? "INTERNAL_SERVER_ERROR", message: run.error ?? "stream failed" });
                } else {
                    sink.complete();
                }
            }

            return;
        }

        if (decision === "interrupted") {
            failInterrupted(run, request, sink, replay);

            return;
        }

        if (live) {
            // Replay the prefix this attach missed, THEN subscribe.
            if (replay()) {
                live.sinks.add(sink);
            }

            return;
        }

        if (decision === "reclaim") {
            deleteStreamRun(sql, runKey);
        }

        this.trim(sql);

        // On a reclaim, never reuse the replaced run's stamp: two claims inside
        // the same millisecond would otherwise share a generation, and a resume
        // holding the old one could splice after all.
        const startedAt = Math.max(Date.now(), run === undefined ? 0 : run.startedAt + 1);

        claimStreamRun(sql, runKey, startedAt, request.ttlMs ?? DEFAULT_TTL_MS);

        const state = { generation: startedAt, sinks: new Set<DurableStreamSink>([sink]) };

        this.runs.set(runKey, state);

        // Detached from the socket and handed to `waitUntil` where the host has
        // one, so the run isn't cut short the moment the last consumer leaves —
        // a durable stream that dies with its opener is an ephemeral stream with
        // extra writes. Awaited as well so the caller's error path stays attached.
        const producing = this.produce(runKey, request.iterator, state);

        this.waitUntil?.(producing);

        await producing;
    }

    /**
     * Drive one run: persist each chunk under the next `seq`, then fan it out to
     * whichever consumers are attached right now — possibly none, since a run
     * whose viewers all left still finishes and is still there for the next
     * attach.
     */
    private async produce(
        runKey: string,
        iterator: (signal: AbortSignal) => AsyncIterable<unknown>,
        state: { generation: number; sinks: Set<DurableStreamSink> },
    ): Promise<void> {
        const sql = this.sql();
        // Not wired to any consumer's cancel: a consumer leaving must not end the
        // run. The controller exists to satisfy the handler's signature.
        const controller = new AbortController();
        let seq = 0;
        let bytes = 0;

        try {
            for await (const chunk of iterator(controller.signal)) {
                const data = encodeWire(chunk);
                const encoded = JSON.stringify(data);

                seq += 1;
                bytes += encoded.length;

                // Whichever ceiling trips first. The count catches a chatty
                // generator, the byte total catches a few enormous chunks — and
                // only the second one actually bounds what lands in SQLite.
                if (seq > MAX_DURABLE_STREAM_CHUNKS || bytes > MAX_DURABLE_STREAM_BYTES) {
                    throw new LunoraError(
                        "STREAM_TOO_LONG",
                        `durable stream exceeded its ceiling (${String(MAX_DURABLE_STREAM_CHUNKS)} chunks / ${String(MAX_DURABLE_STREAM_BYTES)} bytes); yield less, or drop \`durable\``,
                        { status: 507 },
                    );
                }

                appendStreamChunk(sql, runKey, seq, encoded);

                for (const sink of state.sinks) {
                    // A consumer that refused the frame is gone: drop it rather
                    // than re-attempting on every remaining chunk. It loses
                    // nothing — the transcript is durable and it resumes from its
                    // last `seq`.
                    if (!sink.chunk({ data, generation: state.generation, seq })) {
                        state.sinks.delete(sink);
                    }
                }
            }

            finishStreamRun(sql, runKey, "complete", seq);

            for (const sink of state.sinks) {
                sink.complete();
            }
        } catch (error: unknown) {
            // Redact BEFORE persisting: the stored message is replayed to every
            // later attach, so a leaked internal detail would leak repeatedly.
            const { body, redacted } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "internal error" });

            if (redacted) {
                // eslint-disable-next-line no-console -- server-side diagnostic for an internal/unhandled stream error
                console.error("[@lunora/shard-engine] unhandled durable stream error:", error);
            }

            finishStreamRun(sql, runKey, "error", seq, { code: body.code, message: body.message });

            for (const sink of state.sinks) {
                sink.fail({ code: body.code, message: body.message });
            }
        } finally {
            this.runs.delete(runKey);
        }
    }

    /** Throttled TTL sweep. Each run carries its own retention, so one procedure's sweep never trims another's transcripts. */
    private trim(sql: SqlExec): void {
        const now = Date.now();

        if (now - this.lastTrimAt <= GC_INTERVAL_MS) {
            return;
        }

        this.lastTrimAt = now;

        try {
            trimStreamRuns(sql, now);
        } catch {
            // Best-effort GC (pre-migration shard, stub sql handle) must never
            // fail the stream that triggered it.
        }
    }
}

export type { DurableAttachDecision, DurableStreamAttach, DurableStreamSink };
export { decideDurableAttach, DurableStreamRunner, MAX_DURABLE_STREAM_BYTES, MAX_DURABLE_STREAM_CHUNKS };
