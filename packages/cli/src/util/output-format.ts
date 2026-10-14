import type { OptionDefinition } from "@visulima/cerebro";

import type { Logger } from "./logger";
import { createStderrLogger, isProcessStreamLogger } from "./logger";

/**
 * The two renderings every Lunora command speaks. `pretty` is the human-facing
 * default; `json` puts the command's structured result on stdout as a single
 * JSON document and moves every human line to stderr.
 *
 * Resolved ONCE, by `defineHandler`, from the raw `--format` string — a command
 * body receives this narrowed type and never re-validates it.
 */
type OutputFormat = "json" | "pretty";

/**
 * The envelope `--format json` puts on stdout — the same three keys for every
 * command, so a consumer parses one shape and never has to know which command
 * produced it.
 *
 * - `code` is the exit code the process will terminate with.
 * - `data` is the command's own payload, and is absent when the run produced
 * none — which is what a failure before any work looks like.
 * - `error` is the single-line reason for a non-zero `code`. It is the half that
 * makes a FAILURE machine-readable: before the envelope, a failed command wrote
 * nothing at all to stdout and the reason could only be scraped out of English
 * prose on stderr.
 *
 * `defineHandler` serializes exactly these keys, once, after the body returns —
 * so a body may return a richer result for its in-process callers without
 * widening the document, and a failure gets one for free.
 */
interface CommandResult<TData> {
    /** Process exit code — one of `EXIT_CODE`. */
    code: number;
    /** The command's structured payload. Absent when the run produced none. */
    data?: TData;

    /**
     * Set by a command that forwards `--format json` to a child process which
     * writes the document itself (`wrangler … --json`, `wrangler tail`). The
     * envelope is suppressed for that run: stdout already carries exactly one
     * document, and appending a second would make the stream unparseable.
     */
    delegated?: boolean;
    /** Why the run failed. Set whenever `code` is non-zero and a reason is known. */
    error?: string;
}

/**
 * The `--format` flag, declared once and shared by every command that offers it
 * so the name, type and description cannot drift apart across 23 modules.
 */
const OUTPUT_FORMAT_OPTION: OptionDefinition<string> = {
    description: "Output format: pretty (default) or json",
    name: "format",
    type: String,
};

/**
 * Resolve a raw `--format` value to an {@link OutputFormat}, or the error message
 * to print when it names neither rendering. An absent flag is `pretty`.
 *
 * The one place the question is asked: `defineHandler` calls this before the
 * command body runs, which is why no handler carries a `--format` guard of its
 * own.
 */
const parseOutputFormat = (command: string, raw: string | undefined): { error: string } | { format: OutputFormat } => {
    if (raw === undefined) {
        return { format: "pretty" };
    }

    if (raw === "json" || raw === "pretty") {
        return { format: raw };
    }

    return { error: `${command}: unknown --format "${raw}" — expected pretty | json` };
};

/**
 * Pick the logger a command should use for its human/progress output given the
 * requested format. In `json` mode a logger that writes the process streams is
 * routed to stderr (via {@link createStderrLogger}) so stdout carries only the
 * JSON document; in `pretty` mode the command's normal logger is used unchanged.
 *
 * A logger the CALLER supplied is kept in both modes: it is already off stdout,
 * so the swap would achieve nothing and throw their sink away — which is how an
 * embedder passing `{ format: "json", logger }` lost every line to the real
 * stderr. See `isProcessStreamLogger`.
 */
const loggerForFormat = (format: OutputFormat, prettyLogger: Logger): Logger =>
    format === "json" && isProcessStreamLogger(prettyLogger) ? createStderrLogger() : prettyLogger;

/**
 * Print a structured command result as a single pretty-printed JSON document on
 * stdout (trailing newline), so `… --format json` stays cleanly pipeable.
 */
const printJson = (result: unknown): void => {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
};

export type { CommandResult, OutputFormat };
export { loggerForFormat, OUTPUT_FORMAT_OPTION, parseOutputFormat, printJson };
