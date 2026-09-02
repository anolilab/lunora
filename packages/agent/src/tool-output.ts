/**
 * The cap on a tool output that is persisted as a tool message.
 *
 * A tool result is not written once and forgotten: it becomes a row on the
 * thread, and `buildModelMessages` renders every row into the prompt of every
 * LATER turn — and of every later run on the same thread. So one big output is
 * not one big response, it is a permanent per-turn tax that eventually overflows
 * the model's context window and fails the run, after which the next run reads
 * the same history back and fails the same way.
 *
 * Uncapped inputs are ordinary, not exotic: `fsTool`'s `read` returns up to 1 MB
 * and an MCP server's result is whatever the server sends.
 *
 * Shared so the two paths that persist a tool result — the loop's top-level tool
 * dispatch and `codeTool`'s per-step results — cap identically. `codeTool` had
 * the cap from the start and the top-level path did not, which is the wrong way
 * round: the composed path is the bounded one.
 */

/** Max serialized characters kept of a persisted, re-injected tool output. */
const MAX_TOOL_OUTPUT_CHARS = 4000;

/**
 * Appended to a cut output so the model knows it is looking at a prefix.
 *
 * Its length comes OUT of the cap rather than being added on top: the marker is
 * part of the value that gets persisted and re-injected, so slicing to the cap
 * and then appending persisted `MAX_TOOL_OUTPUT_CHARS + 13` characters — an
 * overrun, on every turn, of exactly the thing this module exists to bound.
 */
const TRUNCATION_MARKER = "… [truncated]";

/** Trim `text` to {@link MAX_TOOL_OUTPUT_CHARS}, marking that it was cut so the model can ask for the rest. */
const capToolOutputText = (text: string): string => {
    if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
        return text;
    }

    return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
};

export { capToolOutputText, MAX_TOOL_OUTPUT_CHARS };
