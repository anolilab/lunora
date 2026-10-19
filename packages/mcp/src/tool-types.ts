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
 * A tool's `outputSchema`. Either a success shape, or the root `anyOf` a composed
 * tool gets so an error result also validates. The root stays `type: "object"`,
 * which the MCP SDK requires, so `properties` is absent on that root.
 */
interface ToolOutputSchema {
    $defs?: Record<string, unknown>;
    anyOf?: ReadonlyArray<object>;
    definitions?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    required?: ReadonlyArray<string>;
    type: "object";
}

/**
 * Hints every tool carries, whether it reads or writes.
 */
interface ToolAnnotationsBase {
    /** The tool reaches systems beyond this server (the network, external services). */
    openWorldHint?: boolean;
    /** Human-facing title, shown instead of the raw tool name. */
    title?: string;
}

/**
 * A tool that does not modify anything. `destructiveHint` may only be `false`
 * here, so a read-only tool cannot also claim it is destructive.
 */
interface ReadOnlyToolAnnotations extends ToolAnnotationsBase {
    destructiveHint?: false;
    idempotentHint?: boolean;
    readOnlyHint: true;
}

/**
 * A tool that may modify something. Both hints are REQUIRED here: a write that
 * does not say whether it can destroy data, or whether a retry repeats its
 * effect, is exactly the omission this type exists to rule out.
 */
interface WriteToolAnnotations extends ToolAnnotationsBase {
    /** The tool may perform irreversible changes. */
    destructiveHint: boolean;
    /** Repeating the call with the same arguments has no additional effect. */
    idempotentHint: boolean;
    readOnlyHint: false;
}

/**
 * MCP tool annotations — hints a client may use to decide how to present a tool
 * (badge it read-only, confirm before a destructive call).
 *
 * They are hints, not enforcement: this package's actual guarantees are made at
 * dispatch, where a write tool is refused unless `allowWrites` is set. These
 * exist so a client can *show* the user what the server already enforces,
 * instead of every tool looking equally dangerous.
 *
 * `readOnlyHint` is required on every tool, so a new tool cannot ship without
 * declaring its access. See `./tool-annotations.test` for the compile-time proof.
 */
type ToolAnnotations = ReadOnlyToolAnnotations | WriteToolAnnotations;

interface ToolDefinition {
    /** Required: every tool declares its access (see {@link ToolAnnotations}). */
    annotations: ToolAnnotations;
    description: string;
    inputSchema: ToolInputSchema;
    name: string;

    /**
     * JSON Schema for the tool's `structuredContent`. Optional: a tool that
     * emits only a text block declares none, and a client that negotiated an
     * MCP revision older than `2025-06-18` ignores it either way.
     */
    outputSchema?: ToolOutputSchema;
}

/**
 * The MCP `CallToolResult` shape this package's tools return.
 *
 * A type alias rather than an interface: the SDK's `CallToolResult` has an open
 * index signature, which only an object-literal type satisfies implicitly.
 */
type ToolResult = {
    content: { text: string; type: "text" }[];
    isError?: boolean;

    /**
     * The machine-readable result, mirroring the text block. Present on success
     * for tools that declare an `outputSchema`, and on EVERY error result, where
     * it is `{ code, message }`. Per the MCP spec it must be a JSON OBJECT (never
     * a bare array) and must survive `JSON.stringify` — the transport serializes
     * it, so an un-mapped `bigint` here fails the whole response rather than one
     * field.
     */
    structuredContent?: Record<string, unknown>;
};

export type { ToolAnnotations, ToolDefinition, ToolInputSchema, ToolOutputSchema, ToolResult };
