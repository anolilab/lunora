/**
 * The MCP wire shapes every tool surface in this package speaks — the
 * deployment tools (`./tools`), the agent tools (`./agent-tools`), and the
 * documentation tools (`./docs`).
 *
 * They live in their own module (rather than in `./tools`) so a consumer that
 * only wants the docs surface can import the types without dragging
 * `@lunora/client` into its bundle. `./tools` re-exports them, so the package's
 * public API is unchanged.
 */

/** A JSON-Schema object describing a tool's arguments, per the MCP spec. */
interface ToolInputSchema {
    properties: Record<string, unknown>;
    required?: ReadonlyArray<string>;
    type: "object";
}

/**
 * MCP tool annotations — hints a client may use to decide how to present a tool
 * (badge it read-only, confirm before a destructive call).
 *
 * They are hints, not enforcement: this package's actual guarantees are made at
 * dispatch, where a write tool is refused unless `allowWrites` is set. These
 * exist so a client can *show* the user what the server already enforces,
 * instead of every tool looking equally dangerous.
 */
interface ToolAnnotations {
    /** The tool may perform irreversible changes. Only meaningful when `readOnlyHint` is false. */
    destructiveHint?: boolean;
    /** Repeating the call with the same arguments has no additional effect. */
    idempotentHint?: boolean;
    /** The tool reaches systems beyond this server (the network, external services). */
    openWorldHint?: boolean;
    /** The tool does not modify anything. */
    readOnlyHint?: boolean;
    /** Human-facing title, shown instead of the raw tool name. */
    title?: string;
}

interface ToolDefinition {
    annotations?: ToolAnnotations;
    description: string;
    inputSchema: ToolInputSchema;
    name: string;
}

/** The MCP `CallToolResult` shape this package's tools return. */
interface ToolResult {
    content: { text: string; type: "text" }[];
    isError?: boolean;
}

export type { ToolAnnotations, ToolDefinition, ToolInputSchema, ToolResult };
