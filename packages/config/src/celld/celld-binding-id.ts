import { LunoraError } from "@lunora/errors";

/**
 * The id celld gets for a binding that carries none. celld takes any id as the
 * fleet-wide identity, so it names the Worker (two projects must not share a
 * resource) and the binding as written (`CACHE` and `cache` must not either). A
 * Worker with no name has nothing to tell it apart from another, so it is refused
 * rather than given a shared fallback.
 */
const celldBindingId = (workerName: unknown, binding: string): string => {
    if (typeof workerName !== "string" || workerName.length === 0) {
        throw new LunoraError(
            "BAD_REQUEST",
            `the celld projection needs the Worker's \`name\` to give the id-less binding "${binding}" a fleet-wide id; set \`name\` in wrangler.jsonc`,
        );
    }

    return `${workerName}-${binding}`;
};

export default celldBindingId;
