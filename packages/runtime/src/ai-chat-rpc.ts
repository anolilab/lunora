/**
 * The worker-served assistant ops — `__lunora_admin__:aiChat`, the Studio's
 * conversational SQL assistant (plan 364 W1/W2), and `__lunora_admin__:aiAvailable`,
 * the probe that tells the Studio whether it can run and at which data-sharing
 * level. They share one deps object precisely so the level the probe REPORTS is
 * the level the chat gate READS.
 *
 * **Why it lives at the worker, not in the DO.** Its three one-shot siblings
 * (`aiGenerateSql`, `aiTableFilter`, `aiChartConfig`) are registered on the shard
 * DO's admin dispatch, which is single-threaded — `shared/sql-assistant.ts` puts
 * a 15 s deadline on one inference precisely so a hung model cannot hold that
 * dispatch open. A multi-turn exchange cannot be given a deadline that small, and
 * holding the dispatch for the length of a conversation would block every other
 * admin read on that shard. Intercepting the op here means it never touches the
 * dispatch at all.
 *
 * Structurally a copy of `auth-audit-rpc.ts` — a `*_OP` constant, a deps closure,
 * a builder, and a `*_NOT_CONFIGURED` 400 — deliberately, so there is one
 * worker-RPC idiom rather than two.
 */
import type {
    AiOptInLevel,
    AiRunBinding,
    ChatArgs,
    ChatResult,
    ChatStreamEvent,
    ChatToolRunner,
    ForwardedToolCall,
    ForwardedToolName,
    SchemaFact,
} from "../../../shared/ai-chat";
import { generateChat } from "../../../shared/ai-chat";
import { SSE_HEADERS, sseFrame } from "../../../shared/sse";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";

/**
 * Reserved RPC path the studio's chat panel invokes via `useAdminQuery`. Shares
 * the `__lunora_admin__:` prefix and its gating with the shard-served ops;
 * `batch.ts` already excludes that prefix from coalescing, so a long turn cannot
 * be batched behind unrelated calls.
 */
const AI_CHAT_OP = "__lunora_admin__:aiChat";

/**
 * The availability probe the Studio asks once on mount.
 *
 * Served HERE rather than on the shard, which is where it used to live, so that
 * the level it reports is the level that GATES a turn — `deps.optInLevel()`, the
 * same call {@link buildAiChat} makes on the same deps object. The shard read
 * `env.LUNORA_AI_OPT_IN` itself, so the readout was a second answer to the
 * question rather than a report of the first, and the two could only be trusted
 * to agree for as long as codegen was the only thing wiring the worker.
 *
 * The shard still narrows the same var for its own one-shot assistant ops
 * (`ShardDO.aiBinding`) — a READER of `LUNORA_AI_OPT_IN` through the same
 * `asOptInLevel`, not a second decision about what the level is.
 */
const AI_AVAILABLE_OP = "__lunora_admin__:aiAvailable";

/** Closure-scoped worker helpers the handler borrows. */
interface AiChatRpcDeps {
    /** Throw 403 (`ADMIN_FORBIDDEN`) unless the request carries a valid admin bearer. */
    assertAdmin: (request: Request) => void;
    /** The worker's root shard key, used when the caller names no shard. */
    defaultShardKey: () => string;

    /**
     * The worker's shard forwarder, and the admin headers to forward with.
     *
     * Injected rather than imported. Omit it and a turn simply runs without tools.
     * `headers` is resolved per request by the caller because an Access-authorized
     * admin presents no bearer of their own — see `resolveAdminForwardContext`.
     */
    forwardToShard?: (request: Request) => Promise<{ forward: ForwardToShard; headers: Record<string, string> }>;

    /** The app's Workers `AI` binding, or undefined when none is wired. */
    getBinding: () => AiRunBinding | undefined;

    /**
     * How much of the deployment this app lets the assistant read.
     *
     * A dep rather than a request field on purpose: a level the browser sends is
     * a level the browser chose, which is not a gate. The studio is told what the
     * level is (through a refusal it can render) and can never raise it.
     */
    optInLevel: () => AiOptInLevel;
}

/** The worker-served handler for {@link AI_CHAT_OP}. */
type AiChatRpcHandler = (request: Request, args: Record<string, unknown>) => Promise<Response>;

/** What {@link AI_AVAILABLE_OP} answers. Mirrored by `AiAvailableResult` in `@lunora/studio`. */
interface AiAvailableResult {
    /** Whether an assistant turn can run at all — a binding is wired and the level is not `disabled`. */
    readonly available: boolean;
    /** The level this worker enforces, so the Studio can show the operator where they are on the ladder. */
    readonly level: AiOptInLevel;
}

/** Most grounding facts accepted from a caller. `groundingBlock` slices to 40; this bounds what reaches it. */
const MAX_SCHEMA_FACTS = 60;

/** Cap on a caller-supplied table or column name. */
const NAME_CAP = 120;

/** Narrow one caller-supplied grounding fact, or drop it. */
const schemaFact = (value: unknown): SchemaFact | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { columns, table } = value as { columns?: unknown; table?: unknown };

    if (typeof table !== "string" || table === "" || !Array.isArray(columns)) {
        return undefined;
    }

    return {
        // Length-capped like every other caller-supplied field: this is the one
        // input on this op that is neither prompt nor transcript, so it would
        // otherwise be the only unbounded one.
        columns: columns.filter((column): column is string => typeof column === "string").map((column) => column.slice(0, NAME_CAP)),
        table: table.slice(0, NAME_CAP),
    };
};

/** The worker's shard forwarder, as this module needs it. Injected, so nothing here learns how to reach a shard. */
type ForwardToShard = (
    request: Request,
    functionPath: string,
    args: Record<string, unknown>,
    shardKey: string,
    headers: Record<string, string>,
) => Promise<Response>;

/**
 * The admin op behind each forwarded tool. A record, so a tool added without an
 * op is a compile error.
 *
 * Keyed by `ForwardedToolName`, which is `ChatToolName` minus `loadKnowledge` —
 * that one is answered from a digest inside the engine and has no op to name.
 */
const TOOL_OPS: Readonly<Record<ForwardedToolName, string>> = {
    describeTables: "__lunora_admin__:describeTables",
    readAdvisors: "__lunora_admin__:getAdvisories",
    readLogs: "__lunora_admin__:getLogs",
    // The read-only RLS inspector's own op: codegen-discovered `(table, on,
    // procedure, file)` triples plus role/permission names, and never a `when`
    // predicate. There is no write sibling to name here — a policy is TypeScript
    // on the developer's disk, not DDL — so the assistant proposes one in prose
    // and the operator applies it with the dev host's policy scaffolder.
    readPolicies: "__lunora_admin__:rlsPolicies",
    runSql: "__lunora_admin__:runSql",
};

/**
 * Build a tool runner over the worker's forwarder.
 *
 * Lives here rather than in `create-worker.ts` because it closes over nothing
 * from that closure except `forward` itself — everything else is an argument. Put
 * there it needed a forward-declared `let` and a hand-kept type annotation a
 * thousand lines from its definition; here it is an ordinary function.
 *
 * Goes through the same forwarder and the same admin ops the studio itself calls,
 * so the security question stays "does the existing gate still hold" rather than
 * "is this new capability safe". `runSql`'s statement has already passed
 * `classifyStatement` in the engine before it arrives.
 */
const chatToolRunner =
    (forward: ForwardToShard, shardKey: string, headers: Record<string, string>, request: Request): ChatToolRunner =>
    async (call: ForwardedToolCall): Promise<unknown> => {
        const path = TOOL_OPS[call.name];
        const response = await forward(request, path, call.sql === undefined ? {} : { sql: call.sql }, shardKey, headers);

        // A non-2xx body is an error envelope, not data. Without this check it was
        // JSON-stringified into an observation prefixed "Tool result:", telling the
        // model that a 403 was what the table contained.
        if (!response.ok) {
            return { error: `the tool call failed (${response.status.toString()})` };
        }

        // Shard admin ops answer `{ result: encodeWire(...) }`, so the raw body
        // hands the model the envelope plus bigint/bytes sentinels rather than the
        // rows. Every other consumer decodes; so must this one.
        const body: { result?: unknown } = await response.json();

        return decodeWire(body.result);
    };

/**
 * Build the `__lunora_admin__:aiChat` handler.
 *
 * Admin-gated FIRST, before anything else this handler does, so an
 * unauthenticated caller cannot probe whether the feature is wired — the same
 * ordering, for the same reason, as `buildGetAuthAuditLog`. It runs before the
 * stream is constructed, so a refused caller still gets an ordinary JSON error
 * response rather than an event stream carrying a refusal.
 *
 * **Answers `text/event-stream`, always** (plan 364 W5). One transport, not two:
 * a streaming op beside a whole-answer one would be two places for the admin
 * gate, the data-sharing level and the approval ticket to drift, and this repo is
 * pre-1.0 so the old path is gone rather than deprecated. Nothing is lost by it —
 * the terminal `event: complete` frame carries the same whole {@link ChatResult}
 * the op used to answer with, in the same wire envelope, so a reader that only
 * waits for that frame behaves exactly as before. The `data:` frames in front of
 * it are narration (see `ChatStreamEvent`) and carry nothing a caller must act
 * on, which is what makes an interrupted stream safe: a turn that never reaches
 * its terminal frame has produced nothing to commit.
 *
 * Never throws for a model failure: `generateChat` returns a degraded result
 * carrying a reason the UI renders, which is the contract every other assistant
 * surface already follows.
 */
const buildAiChat = (deps: AiChatRpcDeps): AiChatRpcHandler => {
    const handle = async (request: Request, args: Record<string, unknown>): Promise<Response> => {
        deps.assertAdmin(request);

        const binding = deps.getBinding();
        const rawSchema = args["schema"];
        const chatArgs: ChatArgs = {
            /*
             * Passed through unnarrowed, like `transcript` below: the engine owns
             * the approval's shape AND its verification, and the two must not be
             * able to disagree. Narrowing here would put half a security check in
             * the transport.
             */
            approval: args["approval"],
            ...(typeof args["model"] === "string" ? { model: args["model"] } : {}),
            prompt: args["prompt"],
            // Passed through unnarrowed on purpose: `generateChat` owns the
            // transcript budget and the per-turn fencing, because a cap applied
            // here would be a second place for it to drift from the prompt that
            // relies on it.
            transcript: args["transcript"],
        };

        const schema = Array.isArray(rawSchema)
            ? rawSchema
                  .slice(0, MAX_SCHEMA_FACTS)
                  .map((fact) => schemaFact(fact))
                  .filter((fact): fact is SchemaFact => fact !== undefined)
            : [];

        /*
         * A missing binding is not an error here, and is not special-cased here
         * either: `generateChat` answers `no-ai-binding` for it. The panel's
         * visibility latch keys on that reason and is sticky, so it is what makes
         * the surface disappear on an app with no `AI` binding — a 400 left the
         * panel rendered and every send failing with a generic "could not be
         * reached", which is the exact failure the latch exists to prevent. The
         * only thing skipped is resolving a tool runner no turn will reach.
         */
        const runner =
            binding === undefined || deps.forwardToShard === undefined
                ? undefined
                : await (async (): Promise<ChatToolRunner> => {
                      const { forward, headers } = await (deps.forwardToShard as NonNullable<AiChatRpcDeps["forwardToShard"]>)(request);

                      /*
                       * The shard the console has OPEN, named by the caller — which
                       * answers plan 364's open question 2, and which the reply
                       * echoes back in `toolCalls`.
                       *
                       * An absent or empty key means the ROOT shard, the same
                       * convention every other dispatch path uses. Forwarding `""`
                       * raw addressed a Durable Object literally named "", which
                       * has no tables — so every tool read came back empty.
                       */
                      const named = args["shardKey"];
                      const shardKey = typeof named === "string" && named !== "" ? named : deps.defaultShardKey();

                      return chatToolRunner(forward, shardKey, headers, request);
                  })();

        const level = deps.optInLevel();
        const encoder = new TextEncoder();

        const body = new ReadableStream<Uint8Array>({
            async start(controller) {
                let open = true;

                /*
                 * Best-effort, by design. A frame written after the operator closed
                 * the panel throws on an already-closed controller, and narration is
                 * not worth failing a turn over — the terminal frame is the only one
                 * that carries anything, and if nobody is listening it carries it to
                 * nobody.
                 */
                const send = (frame: unknown, event?: "complete" | "error"): void => {
                    if (!open) {
                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(sseFrame(frame, event)));
                    } catch {
                        open = false;
                    }
                };

                try {
                    /*
                     * The terminal frame carries the SAME `{ result: encodeWire(...) }`
                     * payload the op answered with before it streamed, so the client
                     * decodes it exactly as it decodes any other worker-served op —
                     * one envelope contract, not a second one for streams.
                     */
                    const result: ChatResult = await generateChat(binding, chatArgs, schema, level, runner, (event: ChatStreamEvent) => {
                        send(event);
                    });

                    send({ result: encodeWire(result) }, "complete");
                } catch {
                    /*
                     * Unreachable through `generateChat`, which degrades rather than
                     * throwing — this is the transport's own failure arm, and it is
                     * deliberately terse: a turn's internals must not be echoed to a
                     * browser, and the reader turns any error frame into the same
                     * "could not be reached" the degrade arms produce.
                     */
                    send({ code: "AI_CHAT_FAILED", message: "the assistant turn failed" }, "error");
                } finally {
                    if (open) {
                        controller.close();
                    }
                }
            },
        });

        /*
         * ponytail: a turn whose reader disconnects still runs to completion
         * server-side — bounded by `MAX_TOOL_CALLS` + 1 inferences, each under the
         * engine's single deadline, and on Workers the invocation is usually torn
         * down with the connection anyway. Thread a cancellation signal into the
         * engine only if a real deployment shows abandoned turns costing anything.
         */
        return new Response(body, { headers: SSE_HEADERS, status: 200 });
    };

    return handle;
};

/**
 * Build the `__lunora_admin__:aiAvailable` handler.
 *
 * Admin-gated first, like its sibling, so an unauthenticated caller cannot read
 * a deployment's data-sharing posture off an unauthenticated probe.
 *
 * `available` folds the two facts the Studio treats identically (no binding, and
 * `disabled`) into the one boolean its sticky latch consumes; `level` is the
 * readout, and it is deliberately NOT what any gate reads — the studio is told
 * the level and can never send one.
 */
const buildAiAvailable = (deps: Pick<AiChatRpcDeps, "assertAdmin" | "getBinding" | "optInLevel">): AiChatRpcHandler => {
    const handle = (request: Request): Promise<Response> => {
        deps.assertAdmin(request);

        const level = deps.optInLevel();
        const result: AiAvailableResult = { available: level !== "disabled" && deps.getBinding() !== undefined, level };

        return Promise.resolve(Response.json({ result: encodeWire(result) }, { headers: { "content-type": "application/json" }, status: 200 }));
    };

    return handle;
};

export { AI_AVAILABLE_OP, AI_CHAT_OP, buildAiAvailable, buildAiChat };
export type { AiAvailableResult, AiChatRpcDeps, AiChatRpcHandler };
