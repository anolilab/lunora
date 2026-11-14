import type { FunctionKind } from "../../lib/types";

/** Inputs every function snippet builder closes over — the split path plus its `kind`. */
interface SnippetInput {
    /** The file segment of the `file:function` path. */
    readonly file: string;
    /** The function-name segment of the `file:function` path. */
    readonly fn: string;
    readonly kind: FunctionKind;
}

/** The client method each function kind is invoked through. */
const CLIENT_METHOD: Record<FunctionKind, string> = {
    action: "action",
    mutation: "mutation",
    query: "query",
};

/**
 * Split a `file:function` descriptor path into its two halves. A path with no
 * colon is treated as a bare function in an empty file so the builders still
 * produce a usable (if odd) snippet rather than throwing.
 */
const splitPath = (path: string): { file: string; fn: string } => {
    const index = path.indexOf(":");

    if (index === -1) {
        return { file: "", fn: path };
    }

    return { file: path.slice(0, index), fn: path.slice(index + 1) };
};

/** Browser-SDK usage for a function: a single awaited call through the typed `client`. */
const buildClientSnippet = ({ file, fn, kind }: SnippetInput): string => `await client.${CLIENT_METHOD[kind]}(api.${file}.${fn}, { /* args */ });`;

/**
 * React-hook usage for a function. Queries read with `useQuery`; mutations bind
 * a callable with `useMutation`. Actions have no hook, so they fall back to the
 * client snippet.
 */
const buildReactSnippet = (input: SnippetInput): string => {
    const reference = `api.${input.file}.${input.fn}`;

    switch (input.kind) {
        case "action": {
            return `const { call: ${input.fn} } = useAction(${reference});`;
        }
        case "mutation": {
            return `const ${input.fn} = useMutation(${reference});`;
        }
        default: {
            return `const data = useQuery(${reference}, { /* args */ });`;
        }
    }
};

/** CLI usage for a function. */
const buildCliSnippet = ({ file, fn }: SnippetInput): string => `lunora run ${file}:${fn} --args '{ }'`;

/** The typed data-model usage for one table: query/insert plus the generated row/id types. */
const buildTableSnippet = (table: string): string =>
    [
        `// Read rows`,
        `const rows = await ctx.db.query("${table}").collect();`,
        ``,
        `// Insert a row`,
        `const id = await ctx.db.insert("${table}", { /* fields */ });`,
        ``,
        `// Generated types`,
        `type Row = Doc<"${table}">;`,
        `type RowId = Id<"${table}">;`,
    ].join("\n");

export type { SnippetInput };
export { buildClientSnippet, buildCliSnippet, buildReactSnippet, buildTableSnippet, splitPath };
