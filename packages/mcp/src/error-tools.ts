/**
 * The error-explanation tool surface: one read that turns a Lunora error code
 * — or the raw message an agent scraped out of a log — into the catalog's own
 * account of it, plus a link to the published reference.
 *
 * Part of the ALWAYS-exposed tier, alongside the introspection tools. Unlike
 * every other tool here it touches no deployment: `ERROR_CATALOG` and the
 * solution tables are static data compiled into `@lunora/errors`, so the answer
 * carries no user data, needs no admin bearer, and works with nothing running.
 * That is why it is neither write-gated nor observability-gated.
 *
 * The matching is NOT re-implemented here. `resolveHint` and `findIssueSolution`
 * are the same seams the CLI renderer, the Vite overlay and the Studio Issues
 * panel resolve through — a second matcher in this file would answer differently
 * from the surfaces the developer is looking at while the agent talks to them.
 */
import type { ErrorCatalogEntry, ErrorHint, Solution } from "@lunora/errors";
import { findIssueSolution, getCatalogEntry, isInternalCode, resolveHint } from "@lunora/errors";

import { errorResult, okStructured } from "./tool-result";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "./tool-types";

/** Static catalog content: no state, no deployment, same answer every time. */
const READ_ONLY_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true } as const;

/** The published reference this tool links into — the page generated from the same catalog. */
const ERROR_REFERENCE_URL = "https://lunora.sh/docs/errors";

const EXPLAIN_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        code: { description: 'The error code to explain, e.g. "CONFLICT" or "RLS_REQUIRED". Case-sensitive; codes are SCREAMING_SNAKE_CASE.', type: "string" },
        message: {
            description:
                "The raw error message, when there is no code (codegen and Cloudflare platform errors arrive as plain text). Matched against the solution tables.",
            type: "string",
        },
    },
    type: "object",
};

const EXPLAIN_OUTPUT_SCHEMA: ToolInputSchema = {
    properties: {
        code: { description: "The code that was looked up, when one was given.", type: "string" },
        docsUrl: { description: "Link to this code's section of the published error reference.", type: "string" },
        found: { description: "False when neither the code nor the message matched anything — the other fields are then absent.", type: "boolean" },
        hint: { description: "Actionable Markdown remediation, when the catalog or a message rule has one.", type: "string" },
        internal: {
            description:
                "True when the code is redacted on the wire: its real message is logged server-side and never reaches a client, so it is absent from the published reference.",
            type: "boolean",
        },
        solution: { description: "A message-matched solution: { id, header, body }, from Lunora's rules or the Cloudflare platform table.", type: "object" },
        status: { description: "HTTP/RPC status this code maps to on the wire.", type: "number" },
        title: { description: "Short human-readable summary of the code.", type: "string" },
    },
    required: ["found"],
    type: "object",
};

const ERROR_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        annotations: { ...READ_ONLY_ANNOTATIONS, title: "Explain a Lunora error" },
        description:
            "Explain a Lunora error before guessing at a fix: pass its code (CONFLICT, RLS_REQUIRED, …) or the raw error message, and get the catalog's transport status, title and actionable hint, plus any matched codegen/Cloudflare solution and a link to the reference. Static catalog data — no deployment and no credentials needed.",
        inputSchema: EXPLAIN_INPUT_SCHEMA,
        name: "lunora_explain_error",
        outputSchema: EXPLAIN_OUTPUT_SCHEMA,
    },
];

/** Names of the error tools — used to route dispatch to {@link callErrorTool}. */
const ERROR_TOOL_NAMES: ReadonlySet<string> = new Set(ERROR_TOOL_DEFINITIONS.map((tool) => tool.name));

/** A non-empty input string, or `undefined`. */
const readText = (raw: unknown): string | undefined => (typeof raw === "string" && raw.length > 0 ? raw : undefined);

/** An `ErrorHint` is a Markdown string or an array of lines; the model reads either as Markdown. */
const flatten = (hint: ErrorHint): string => (typeof hint === "string" ? hint : hint.join("\n"));

/**
 * Where to send the caller for more. A code's own `docsUrl` wins when the
 * catalog carries one; otherwise the generated reference, anchored on the
 * heading it emits for that code (`### \`CONFLICT\`` → `#conflict`). Internal
 * codes have no section there — they are deliberately unpublished — so they get
 * the bare page.
 */
const documentationUrlFor = (code: string | undefined, entry: ErrorCatalogEntry | undefined): string => {
    if (entry?.docsUrl !== undefined) {
        return entry.docsUrl;
    }

    if (code === undefined || entry === undefined || isInternalCode(code)) {
        return ERROR_REFERENCE_URL;
    }

    return `${ERROR_REFERENCE_URL}#${code.toLowerCase()}`;
};

/**
 * Everything the catalog and the solution tables know about this code/message
 * pair, as the tool's `structuredContent`.
 *
 * `hint` and `solution` stay separate on purpose: `hint` is what the catalog
 * says about the CODE (the same text the CLI and the overlay print), `solution`
 * is what the message-matching tables recognise in the TEXT. Resolving the hint
 * through the message as well would emit the matched rule's body twice.
 */
const explainError = (code: string | undefined, message: string | undefined): Record<string, unknown> => {
    const entry: ErrorCatalogEntry | undefined = code === undefined ? undefined : getCatalogEntry(code);
    const hint: ErrorHint | undefined = code === undefined ? undefined : resolveHint({ code });
    const solution: Solution | undefined = message === undefined ? undefined : findIssueSolution(message);

    const explanation: Record<string, unknown> = {
        docsUrl: documentationUrlFor(code, entry),
        found: entry !== undefined || solution !== undefined,
    };

    if (code !== undefined) {
        explanation.code = code;

        if (isInternalCode(code)) {
            explanation.internal = true;
        }
    }

    if (entry !== undefined) {
        explanation.status = entry.status;
        explanation.title = entry.title;
    }

    if (hint !== undefined) {
        explanation.hint = flatten(hint);
    }

    if (solution !== undefined) {
        explanation.solution = { body: solution.body, header: solution.header, id: solution.id };
    }

    return explanation;
};

/**
 * Dispatch an error tool. Synchronous, and returns a result rather than throwing
 * on bad input: the answer comes from compiled-in data, and `./local` routes
 * these straight here (they need no deployment), so there is no shared try/catch
 * in front of every caller the way `callTool` has one.
 */
const callErrorTool = (name: string, input: Record<string, unknown>): ToolResult => {
    if (name !== "lunora_explain_error") {
        return errorResult(`unknown error tool: ${name}`);
    }

    const code = readText(input.code);
    const message = readText(input.message);

    if (code === undefined && message === undefined) {
        return errorResult('lunora_explain_error needs a "code" or a "message" (or both); received neither.');
    }

    // A miss comes back as `found: false`, not an `isError`: "nothing knows this
    // one" is a real answer, and an error result reads to a model as a broken
    // tool worth retrying.
    return okStructured(explainError(code, message));
};

export { callErrorTool, ERROR_REFERENCE_URL, ERROR_TOOL_DEFINITIONS, ERROR_TOOL_NAMES };
