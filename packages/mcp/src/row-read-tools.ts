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
 * Coerce an MCP `arguments` bag into the `findRelated` admin payload.
 *
 * Only SHAPE is enforced here. The range checks that matter (`depth` 1-4,
 * `limit` 1-200, a known edge name) belong to `ctx.db.related` itself, and its
 * refusals name the cap — a second copy here would drift from them.
 */
const readRelatedArguments = (input: Record<string, unknown>): { args: Record<string, unknown>; shardKey: string | undefined } => {
    const { cursor, depth, direction, edges, id, limit, shardKey, table } = input;

    if (typeof table !== "string" || table.length === 0) {
        throw new LunoraError("BAD_REQUEST", '"table" is required and must be a non-empty string');
    }

    if (typeof id !== "string" || id.length === 0) {
        throw new LunoraError("BAD_REQUEST", '"id" is required and must be a non-empty string');
    }

    return {
        args: {
            id,
            table,
            ...(typeof cursor === "string" ? { cursor } : {}),
            ...(typeof depth === "number" ? { depth } : {}),
            ...(typeof direction === "string" ? { direction } : {}),
            ...(Array.isArray(edges) ? { edges } : {}),
            ...(typeof limit === "number" ? { limit } : {}),
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
