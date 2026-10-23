/** One OpenRPC method in the shape codegen emits. */
const method = (
    name: string,
    kind: string,
    options: { args?: Record<string, unknown>; argsRequired?: boolean; result?: Record<string, unknown> } = {},
): Record<string, unknown> => {
    return {
        errors: [],
        name,
        params: [
            {
                description: "The function's argument object (the RPC envelope's `args`).",
                name: "args",
                required: options.argsRequired ?? Object.keys(options.args ?? {}).length > 0,
                schema: { additionalProperties: false, properties: options.args ?? {}, required: [], type: "object" },
            },
        ],
        result: { name: "result", schema: options.result ?? { description: "Result is TS-inferred; best-effort — any JSON." } },
        summary: `${kind}: ${name}`,
        "x-lunora-function-kind": kind,
    };
};

export default method;
