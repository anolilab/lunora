import type { Logger } from "./logger";
import { createStderrLogger } from "./logger";

/**
 * Machine-readable output formats Lunora commands understand. `pretty` is the
 * default human-facing rendering; `json` serializes the command's structured
 * result as a single JSON document on stdout.
 *
 * Mirrors the `logs` command's `--format` contract (option name `format`, type
 * String) so every command that grew a `--format` flag validates identically.
 */
const OUTPUT_FORMATS = new Set<string>(["json", "pretty"]);

/**
 * Validate a `--format` value the same way `logs` does. Returns an error
 * message (matching the `logs` wording, scoped to `command`) when the value is
 * present but unknown, or `undefined` when it is absent or valid.
 */
const validateOutputFormat = (command: string, format: string | undefined): string | undefined => {
    if (format !== undefined && !OUTPUT_FORMATS.has(format)) {
        return `${command}: unknown --format "${format}" — expected pretty | json`;
    }

    return undefined;
};

/** True when the resolved `--format` selects JSON output. */
const isJsonFormat = (format: string | undefined): boolean => format === "json";

/**
 * Pick the logger a command should use for its human/progress output given the
 * requested format. In `json` mode every line is routed to stderr (via
 * {@link createStderrLogger}) so stdout carries only the JSON document; in
 * `pretty` mode the command's normal logger is used unchanged.
 */
const loggerForFormat = (format: string | undefined, prettyLogger: Logger): Logger => (isJsonFormat(format) ? createStderrLogger() : prettyLogger);

/**
 * Print a structured command result as a single pretty-printed JSON document on
 * stdout (trailing newline), so `… --format json` stays cleanly pipeable.
 */
const printJson = (result: unknown): void => {
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
};

export { isJsonFormat, loggerForFormat, printJson, validateOutputFormat };
