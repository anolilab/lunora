/** The schema-extension key the agent tables merge under (`agent_*` physical names). */
const AGENT_EXTENSION_KEY = "agent";

/**
 * Loose structural view of a registered Lunora function — wide enough for any
 * concrete `RegisteredMutation`/`RegisteredQuery` (whose precise validator-map
 * generics make them invariant), narrow enough for re-export, dispatch, and
 * tests. Codegen registers the runtime value; it never needs the generics.
 */
interface AgentRegisteredFunction {
    readonly args: unknown;
    readonly handler: (context: unknown, args: never) => unknown;
    readonly kind: "mutation" | "query";
    readonly visibility?: "internal" | "public";
}

/** Stamp a registered function internal — server-side callable only. */
const asInternal = <T>(function_: T): T => {
    return { ...function_, visibility: "internal" };
};

/**
 * Drop the `undefined`-valued keys from an optional-column bag so a
 * `defineTable` insert never writes an explicit `undefined` (which the
 * validators reject) — the spread-and-omit pattern for `owner`/`title`/
 * `instanceId`/`state`, hoisted out of the insert to keep the handler's
 * cyclomatic complexity flat as more optional columns are added.
 */
const definedColumns = (columns: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(columns)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
};

export type { AgentRegisteredFunction };
export { AGENT_EXTENSION_KEY, asInternal, definedColumns };
