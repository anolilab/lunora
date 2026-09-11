/**
 * The raw-row read surface: one traversal that follows the schema's foreign keys
 * out of a row and hands back the rows it is connected to.
 *
 * Its own module for the same reason `./error-tools` and `./observability-tools`
 * are theirs — one family owns its definitions, its name set and its dispatch,
 * and `./tools` stays the router rather than the router plus one family's guts.
 *
 * Gated behind `allowDataReads`, and for a sharper version of the argument the
 * observability tools already make. `lunora_find_related` does not run a
 * declared function the way `lunora_run_query` does — it reaches the shard's
 * `__lunora_admin__:findRelated` op, whose writer is built by the generated
 * `adminWriter()` WITHOUT `enforceRls`. So it returns rows straight out of
 * arbitrary tables with RLS policies and column masks bypassed, plus everything
 * transitively reachable within `depth` hops. Holding the admin bearer already
 * confers that authority; what must not be implied is handing it to a MODEL by
 * default.
 */
import type { FunctionReference, LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { ADMIN_FUNCTIONS } from "@lunora/shard-engine";

import { ok } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tool-types";

/** The traversal touches no state; every call goes to the deployment. */
const READ_ONLY_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true } as const;

const FIND_RELATED_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        cursor: { description: "Opaque cursor from a previous call's continueCursor, to fetch the next page.", type: "string" },
        depth: { description: "How many hops to follow. 1 (default) is the direct neighbourhood; maximum 4.", type: "number" },
        direction: {
            description:
                'Which way to follow foreign keys: "out" follows the ids this row holds (ticket → customer), "in" the rows that point at it (customer → tickets), "both" (default) does both.',
            type: "string",
        },
        edges: {
            description:
                'Restrict the walk to these edge names, each "<table>.<column>" (e.g. "tickets.customerId"). Omit to follow every declared foreign key.',
            items: { type: "string" },
            type: "array",
        },
        id: { description: "Document id of the row to start from.", type: "string" },
        limit: { description: "Maximum related rows to return (default 50, maximum 200).", type: "number" },
        shardKey: { description: "Shard to read from on a .shardBy()-partitioned deployment. Omit for the default (unsharded) shard.", type: "string" },
        table: { description: 'Table the start row lives in, e.g. "customers".', type: "string" },
    },
    required: ["table", "id"],
    type: "object",
};

/** Tools that hand back RAW USER ROWS. Exposed only when `allowDataReads` is set. */
const ROW_READ_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Find rows related to a row" },
        description:
            "Follow the schema's foreign keys out of one row and return the rows it is connected to, each with its hop distance, the edge names walked to reach it, and a depth-decaying score. Use this to answer 'what is connected to this' — a customer's tickets, those tickets' messages — which keyword and semantic search cannot, because the connection lives in a foreign key rather than in the text. Read-only, but it reads through the deployment's ADMIN writer: RLS policies and column masks do not apply to what it returns.",
        inputSchema: FIND_RELATED_INPUT_SCHEMA,
        name: "lunora_find_related",
    },
];

/** Names of the raw-row tools — used to route dispatch and to gate them out of a server without the opt-in. */
const ROW_READ_TOOL_NAMES: ReadonlySet<string> = new Set(ROW_READ_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * Reject a malformed traversal option — the optional half of
 * {@link readRelatedArguments}' rule set, split out so neither half carries the
 * whole set's branching. The two are one parser and are read together.
 *
 * Every default this op has is its WIDEST setting, which is why a malformed
 * narrowing option is refused rather than dropped: `direction: "sideways"`
 * falling back to `"both"` walks both directions, and `edges:
 * "orders.customerId"` (a string, not an array) falls back to EVERY edge.
 */
const assertTraversalOptions = (input: Record<string, unknown>): void => {
    const { cursor, depth, direction, edges, limit } = input;

    if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
        throw new LunoraError("BAD_REQUEST", "findRelated: `cursor` must be a string");
    }

    if (depth !== undefined && typeof depth !== "number") {
        throw new LunoraError("BAD_REQUEST", "findRelated: `depth` must be a number");
    }

    if (direction !== undefined && direction !== "both" && direction !== "in" && direction !== "out") {
        throw new LunoraError("BAD_REQUEST", 'findRelated: `direction` must be one of "in", "out" or "both"');
    }

    if (limit !== undefined && typeof limit !== "number") {
        throw new LunoraError("BAD_REQUEST", "findRelated: `limit` must be a number");
    }

    if (edges !== undefined && (!Array.isArray(edges) || !edges.every((entry) => typeof entry === "string"))) {
        throw new LunoraError("BAD_REQUEST", "findRelated: `edges` must be an array of edge-name strings");
    }
};

/**
 * Coerce an MCP `arguments` bag into the `findRelated` admin payload, under the
 * SAME rules — and with the same refusal text — that `@lunora/do`'s
 * `parseFindRelatedArgs` applies when the payload reaches the shard.
 *
 * The two used to disagree over one payload: this side required only a
 * non-EMPTY `table`/`id` (so `"   "` travelled to the shard to be rejected
 * there) and passed `edges` through on `Array.isArray` alone (so
 * `["tickets.customerId", 7]` left here intact). A pre-check that disagreed
 * with the real check about which payloads are well-formed is worse than none.
 *
 * It is a second copy rather than a shared call, deliberately:
 * `parseFindRelatedArgs` is module-private to `@lunora/do` (its public entry
 * re-exports no part of `./admin-rpc-args`), and depending on `@lunora/do` from
 * here would drag the whole Durable Object runtime — plus
 * `@lunora/platform-cloudflare` and `drizzle-orm` — into a stdio/HTTP MCP server
 * that never runs a DO. Keeping the rules and the messages identical is what
 * keeps the copy honest, and the tests pin exactly that.
 *
 * Only SHAPE is enforced, on both sides. The range checks that matter (`depth`
 * 1-4, `limit` 1-200, a known edge name) belong to `ctx.db.related` itself, and
 * its refusals name the cap — a third copy here would drift from them.
 */
const readRelatedArguments = (input: Record<string, unknown>): { args: Record<string, unknown>; shardKey: string | undefined } => {
    const { cursor, depth, direction, edges, id, limit, shardKey, table } = input;

    if (typeof table !== "string" || table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "findRelated: `table` is required");
    }

    if (typeof id !== "string" || id.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "findRelated: `id` is required");
    }

    assertTraversalOptions(input);

    return {
        args: {
            id,
            table,
            ...(typeof cursor === "string" ? { cursor } : {}),
            ...(depth === undefined ? {} : { depth }),
            ...(direction === undefined ? {} : { direction }),
            ...(edges === undefined ? {} : { edges }),
            ...(limit === undefined ? {} : { limit }),
        },
        shardKey: typeof shardKey === "string" && shardKey.length > 0 ? shardKey : undefined,
    };
};

/**
 * Dispatch a raw-row tool.
 *
 * Served by the shard's `__lunora_admin__:findRelated` op over the same
 * `client.query` transport the observability tools use: the traversal needs the
 * app's schema-derived edge set, which only the deployment has. The op path
 * comes from `ADMIN_FUNCTIONS`; a hand-written `"__lunora_admin__:…"` literal is
 * how a renamed op ships a 404 to one consumer and not another.
 */
const callRowReadTool = async (client: LunoraClient, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    if (name !== "lunora_find_related") {
        throw new LunoraError("INTERNAL", `unknown row-read tool: ${name}`);
    }

    const { args, shardKey } = readRelatedArguments(input);
    const reference = { __lunoraRef: ADMIN_FUNCTIONS.findRelated } as FunctionReference;

    return ok(await client.query(reference, args, { ...(shardKey === undefined ? {} : { shardKey }) }));
};

export { callRowReadTool, ROW_READ_TOOL_DEFINITIONS, ROW_READ_TOOL_NAMES };
