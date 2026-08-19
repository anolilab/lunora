/**
 * The worker-served `__lunora_admin__:aiChat` op — the Studio's conversational
 * SQL assistant (plan 364 W1/W2).
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
import type { AiOptInLevel, AiRunBinding, ChatArgs, ChatResult, ChatToolCall, ChatToolRunner, SchemaFact } from "../../../shared/sql-assistant";
import { generateChat } from "../../../shared/sql-assistant";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";

/**
 * Reserved RPC path the studio's chat panel invokes via `useAdminQuery`. Shares
 * the `__lunora_admin__:` prefix and its gating with the shard-served ops;
 * `batch.ts` already excludes that prefix from coalescing, so a long turn cannot
 * be batched behind unrelated calls.
 */
const AI_CHAT_OP = "__lunora_admin__:aiChat";

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

/** The admin op behind each tool. A record, so a tool added without an op is a compile error. */
const TOOL_OPS: Readonly<Record<ChatToolCall["name"], string>> = {
    describeTables: "__lunora_admin__:describeTables",
    readLogs: "__lunora_admin__:getLogs",
    runSql: "__lunora_admin__:runSql",
};

/** Log lines handed to one turn. The buffer holds far more, and `observation()` would truncate mid-JSON. */
const MAX_LOG_LINES = 20;

/**
 * Trim a `getLogs` payload to what a turn can use.
 *
 * The op answers the WHOLE in-memory buffer, newest first, which is orders of
 * magnitude past the observation cap — without this the model reads a JSON
 * fragment cut off mid-object rather than twenty complete lines.
 */
const recentLogs = (decoded: unknown): unknown => {
    const entries = (decoded as { entries?: unknown } | null | undefined)?.entries;

    return Array.isArray(entries) ? { entries: entries.slice(0, MAX_LOG_LINES) } : decoded;
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
    async (call: ChatToolCall): Promise<unknown> => {
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
        const decoded = decodeWire(body.result);

        return call.name === "readLogs" ? recentLogs(decoded) : decoded;
    };

/**
 * Build the `__lunora_admin__:aiChat` handler.
 *
 * Admin-gated FIRST, before the not-configured check, so an unauthenticated
 * caller cannot probe whether the feature is wired — the same ordering, for the
 * same reason, as `buildGetAuthAuditLog`.
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
         * A missing binding degrades rather than throwing a 400.
         *
         * The panel's visibility latch is driven by `no-ai-binding`, and it is
         * sticky — so answering that way is what makes the surface disappear on an
         * app with no `AI` binding. A 400 left the panel rendered and every send
         * failing with a generic "could not be reached", which is the exact
         * failure mode the latch exists to prevent.
         */
        if (binding === undefined) {
            return Response.json(
                { result: encodeWire({ degraded: true, reason: "no-ai-binding" } satisfies ChatResult) },
                { headers: { "content-type": "application/json" }, status: 200 },
            );
        }

        const runner =
            deps.forwardToShard === undefined
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

        const result: ChatResult = await generateChat(binding, chatArgs, schema, deps.optInLevel(), runner);

        // The RPC envelope, not a bare body — `client.query()` reads
        // `decodeWire(body.result)`, and a bare body decodes to `undefined`.
        return Response.json({ result: encodeWire(result) }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return handle;
};

export { AI_CHAT_OP, buildAiChat };
export type { AiChatRpcDeps, AiChatRpcHandler };
