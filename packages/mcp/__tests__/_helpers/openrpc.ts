/** One OpenRPC method in the shape codegen emits. */
const method = (
    name: string,
    kind: string,
    options: { args?: Record<string, unknown>; argsRequired?: boolean; requiredArgs?: string[]; result?: Record<string, unknown> } = {},
): Record<string, unknown> => {
    const argNames = Object.keys(options.args ?? {});
    const required = options.argsRequired ?? argNames.length > 0;

    return {
        errors: [],
        name,
        params: [
            {
                description: "The function's argument object (the RPC envelope's `args`).",
                name: "args",
                required,
                // Codegen names the required fields of the args object; by default every declared argument is required.
                schema: {
                    additionalProperties: false,
                    properties: options.args ?? {},
                    required: options.requiredArgs ?? (required ? argNames : []),
                    type: "object",
                },
            },
        ],
        result: { name: "result", schema: options.result ?? { description: "Result is TS-inferred; best-effort — any JSON." } },
        summary: `${kind}: ${name}`,
        "x-lunora-function-kind": kind,
    };
};

export default method;
