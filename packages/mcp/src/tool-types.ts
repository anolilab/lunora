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

interface ToolDefinition {
    description: string;
    inputSchema: ToolInputSchema;
    name: string;
}

/** The MCP `CallToolResult` shape this package's tools return. */
interface ToolResult {
    content: { text: string; type: "text" }[];
    isError?: boolean;
}

export type { ToolDefinition, ToolInputSchema, ToolResult };
