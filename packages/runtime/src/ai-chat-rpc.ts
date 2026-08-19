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
import type { AiRunBinding, ChatArgs, ChatResult, ChatToolRunner, SchemaFact } from "../../../shared/sql-assistant";
import { generateChat } from "../../../shared/sql-assistant";
import { encodeWire } from "../../../shared/wire-codec";
import { LunoraError } from "./errors";

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
    /** The app's Workers `AI` binding, or undefined when none is wired. */
    getBinding: () => AiRunBinding | undefined;

    /**
     * Dispatch one already-validated read-only tool call against `shardKey`.
     *
     * Injected rather than imported: the engine must not learn how to reach a
     * shard, and this module must not reach into the worker's closure. Omit it
     * and a turn simply runs without tools.
     */
    runTool?: (shardKey: string, request: Request) => ChatToolRunner;
}

/** The worker-served handler for {@link AI_CHAT_OP}. */
type AiChatRpcHandler = (request: Request, args: Record<string, unknown>) => Promise<Response>;

/** Narrow one caller-supplied grounding fact, or drop it. */
const schemaFact = (value: unknown): SchemaFact | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { columns, table } = value as { columns?: unknown; table?: unknown };

    if (typeof table !== "string" || table === "" || !Array.isArray(columns)) {
        return undefined;
    }

    return { columns: columns.filter((column): column is string => typeof column === "string"), table };
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

        if (binding === undefined) {
            throw new LunoraError("the studio chat assistant requires a Workers `AI` binding on the worker", {
                code: "AI_CHAT_NOT_CONFIGURED",
                status: 400,
            });
        }

        const rawSchema = args["schema"];
        const chatArgs: ChatArgs = {
            ...(typeof args["model"] === "string" ? { model: args["model"] } : {}),
            prompt: args["prompt"],
            schema: Array.isArray(rawSchema) ? rawSchema.map((fact) => schemaFact(fact)).filter((fact): fact is SchemaFact => fact !== undefined) : [],
            // Passed through unnarrowed on purpose: `generateChat` owns the
            // transcript budget and the per-turn fencing, because a cap applied
            // here would be a second place for it to drift from the prompt that
            // relies on it.
            transcript: args["transcript"],
            // Answers plan 364's open question 2: the tool reads the shard the
            // console has OPEN, named by the caller, and the answer echoes which
            // tools ran — so a reply is never ambiguous about what it read.
            ...(deps.runTool === undefined ? {} : { runTool: deps.runTool(typeof args["shardKey"] === "string" ? args["shardKey"] : "", request) }),
        };

        const result: ChatResult = await generateChat(binding, chatArgs);

        // The RPC envelope, not a bare body — `client.query()` reads
        // `decodeWire(body.result)`, and a bare body decodes to `undefined`.
        return Response.json({ result: encodeWire(result) }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return handle;
};

export { AI_CHAT_OP, buildAiChat };
export type { AiChatRpcDeps, AiChatRpcHandler };
