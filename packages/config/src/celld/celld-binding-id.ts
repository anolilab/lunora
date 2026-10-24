/**
 * The id celld gets for a binding that carries none. celld takes any id as the
 * fleet-wide identity, so it names the Worker (two projects must not share a
 * resource) and the binding as written (`CACHE` and `cache` must not either).
 */
const celldBindingId = (workerName: unknown, binding: string): string =>
    `${typeof workerName === "string" && workerName.length > 0 ? workerName : "lunora"}-${binding}`;

export default celldBindingId;
