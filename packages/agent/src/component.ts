import type { SchemaExtension } from "@lunora/server";
import { defineSchemaExtension, defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

const AGENT_EXTENSION_KEY = "agent";

/** Bare table names — auto-prefixed with the extension key at merge time. */
const THREADS_BARE_TABLE = "threads";
const MESSAGES_BARE_TABLE = "messages";

/** The physical (merged) table names the runtime functions read/write. */
const THREADS_TABLE: "agent_threads" = `${AGENT_EXTENSION_KEY}_${THREADS_BARE_TABLE}`;
const MESSAGES_TABLE: "agent_messages" = `${AGENT_EXTENSION_KEY}_${MESSAGES_BARE_TABLE}`;

/**
 * The agent thread tables, shipped as a schema extension so an app merges
 * them with one call and they can never collide with app tables:
 *
 * ```ts
 * // lunora/schema.ts
 * export default defineSchema({ ... }).extend(agentExtension);
 * ```
 *
 * Message ordering follows the Convex-agent model: `seq` is the monotonic
 * per-thread position (allocated from the thread's `messageCount` counter, so
 * allocation is O(1) inside the serialized mutation), and `messageKey` is the
 * deterministic idempotency key — a workflow replay that re-persists the same
 * message is a no-op instead of a duplicate.
 */
const agentExtension: SchemaExtension = defineSchemaExtension(AGENT_EXTENSION_KEY, {
    tables: {
        [MESSAGES_BARE_TABLE]: defineTable({
            content: v.string(),
            createdAt: v.number(),
            messageKey: v.string(),
            role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
            seq: v.number(),
            stepName: v.optional(v.string()),
            threadKey: v.string(),
            toolCallId: v.optional(v.string()),
            toolCalls: v.optional(v.array(v.object({ id: v.string(), input: v.any(), name: v.string() }))),
            toolName: v.optional(v.string()),
        })
            // Drives the ordered thread read (the live subscription).
            .index("byThread", ["threadKey", "seq"])
            // Drives the idempotent-persist lookup; unique = the dedup guarantee.
            .index("byMessageKey", ["threadKey", "messageKey"], { unique: true }),
        [THREADS_BARE_TABLE]: defineTable({
            agent: v.string(),
            createdAt: v.number(),
            error: v.optional(v.string()),
            key: v.string(),
            // Next message seq — incremented on every append (see above).
            messageCount: v.number(),
            status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
            title: v.optional(v.string()),
            updatedAt: v.number(),
        })
            .index("byKey", ["key"], { unique: true })
            .index("byAgent", ["agent"]),
    },
});

// The runtime functions are built with the base procedure builders (no
// generated server inside a package), same as the presence component.
const { mutation, query } = initLunora.dataModel().create();

/** Stamp a registered function internal — server-side callable only. */
const asInternal = <T>(function_: T): T => {
    return { ...function_, visibility: "internal" };
};

/**
 * Loose structural view of a registered Lunora function — wide enough for any
 * concrete `RegisteredMutation`/`RegisteredQuery` (whose precise validator-map
 * generics make them invariant), narrow enough for re-export, dispatch, and
 * tests. Codegen registers the runtime value; it never needs the generics.
 */
export interface AgentRegisteredFunction {
    readonly args: unknown;
    readonly handler: (context: unknown, args: never) => unknown;
    readonly kind: "mutation" | "query";
    readonly visibility?: "internal" | "public";
}

export interface AgentComponent {
    extension: SchemaExtension;
    functions: {
        agentAppendMessage: AgentRegisteredFunction;
        agentEnsureThread: AgentRegisteredFunction;
        agentMessages: AgentRegisteredFunction;
        agentPatchThread: AgentRegisteredFunction;
        agentThread: AgentRegisteredFunction;
    };
}

/**
 * Build the agent runtime component: the thread schema extension plus the
 * functions the durable loop dispatches to (and the client subscribes to).
 * Codegen auto-registers them under the `agents:*` namespace whenever
 * `lunora/agents.ts` declares an agent — the loop's dispatch paths assume
 * that namespace, and apps never re-export these by hand.
 *
 * The mutations are **internal** (only the workflow's admin-authenticated
 * dispatch may call them); the queries are public so a client can subscribe
 * to `agents:agentMessages` for a live thread view.
 */
export const agentComponent = (): AgentComponent => {
    const agentEnsureThread = mutation
        .input({
            agent: v.string(),
            key: v.string(),
            title: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ created: boolean }> => {
            const now = Date.now();
            const existing = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (existing) {
                await context.db.patch(existing["_id"] as never, { error: undefined, status: "running", updatedAt: now });

                return { created: false };
            }

            await context.db.insert(THREADS_TABLE, {
                agent: args.agent,
                createdAt: now,
                key: args.key,
                messageCount: 0,
                status: "running",
                ...(args.title === undefined ? {} : { title: args.title }),
                updatedAt: now,
            });

            return { created: true };
        });

    const agentAppendMessage = mutation
        .input({
            content: v.string(),
            messageKey: v.string(),
            role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
            stepName: v.optional(v.string()),
            threadKey: v.string(),
            toolCallId: v.optional(v.string()),
            toolCalls: v.optional(v.array(v.object({ id: v.string(), input: v.any(), name: v.string() }))),
            toolName: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ seq: number }> => {
            // Idempotent by (threadKey, messageKey): a replayed persist returns
            // the recorded position instead of duplicating the row.
            const existing = await context.db
                .query(MESSAGES_TABLE)
                .withIndex("byMessageKey", (q) => q.eq("threadKey", args.threadKey).eq("messageKey", args.messageKey))
                .first();

            if (existing) {
                return { seq: existing["seq"] as number };
            }

            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                .first();

            if (!thread) {
                throw new Error(`@lunora/agent: cannot append to unknown thread "${args.threadKey}" — run agentEnsureThread first`);
            }

            const seq = thread["messageCount"] as number;
            const now = Date.now();

            await context.db.insert(MESSAGES_TABLE, {
                content: args.content,
                createdAt: now,
                messageKey: args.messageKey,
                role: args.role,
                seq,
                threadKey: args.threadKey,
                ...(args.stepName === undefined ? {} : { stepName: args.stepName }),
                ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
                ...(args.toolCalls === undefined ? {} : { toolCalls: args.toolCalls }),
                ...(args.toolName === undefined ? {} : { toolName: args.toolName }),
            });
            await context.db.patch(thread["_id"] as never, { messageCount: seq + 1, updatedAt: now });

            return { seq };
        });

    const agentPatchThread = mutation
        .input({
            error: v.optional(v.string()),
            key: v.string(),
            status: v.optional(v.union(v.literal("idle"), v.literal("running"), v.literal("error"))),
            title: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<void> => {
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (!thread) {
                return;
            }

            await context.db.patch(thread["_id"] as never, {
                updatedAt: Date.now(),
                ...(args.error === undefined ? {} : { error: args.error }),
                ...(args.status === undefined ? {} : { status: args.status }),
                ...(args.title === undefined ? {} : { title: args.title }),
            });
        });

    // KEEP IN SYNC: the arg/return TYPES of the two public queries below are
    // mirrored by hand into codegen's `syntheticAgentApiFunctions` (emit.ts) —
    // codegen cannot statically read this package's types, and only the arg
    // key sets are drift-tested. Changing an input or return shape here means
    // updating the emitted `api.agents.*` reference types there too.
    const agentThread = query.input({ key: v.string() }).query(async ({ args, ctx: context }): Promise<Record<string, unknown> | undefined> => {
        const thread = await context.db
            .query(THREADS_TABLE)
            .withIndex("byKey", (q) => q.eq("key", args.key))
            .first();

        return thread ?? undefined;
    });

    // The live thread view: subscribe to `agents:agentMessages` and every
    // append (user turn, tool call, tool result, assistant reply) streams to
    // the client over the existing reactive-subscription transport.
    const agentMessages = query
        .input({ key: v.string(), limit: v.optional(v.number()) })
        .query(async ({ args, ctx: context }): Promise<Record<string, unknown>[]> => {
            const rows = await context.db
                .query(MESSAGES_TABLE)
                .withIndex("byThread", (q) => q.eq("threadKey", args.key))
                .collect();

            const ordered = rows.toSorted((a, b) => (a["seq"] as number) - (b["seq"] as number));

            // A limit keeps the newest N (the tail of the conversation).
            return args.limit === undefined ? ordered : ordered.slice(Math.max(0, ordered.length - args.limit));
        });

    return {
        extension: agentExtension,
        functions: {
            agentAppendMessage: asInternal(agentAppendMessage),
            agentEnsureThread: asInternal(agentEnsureThread),
            agentMessages,
            agentPatchThread: asInternal(agentPatchThread),
            agentThread,
        },
    };
};

export { agentExtension };
