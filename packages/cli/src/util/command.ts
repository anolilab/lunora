import { findSolutionByMessage, isLunoraError } from "@lunora/errors";
import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import { EXIT_CODE, exitCodeForError } from "./exit-code";
import type { Logger } from "./logger";
import { createLogger } from "./logger";
import type { OutputFormat } from "./output-format";
import { loggerForFormat, parseOutputFormat } from "./output-format";
import PromptCancelledError from "./prompt-cancelled";
import { renderLunoraError } from "./render-lunora-error";

/** The context a command body receives — the toolbox bits every command needs. */
interface CommandContext<TOptions extends Record<string, unknown>> {
    /** Positional arguments (`toolbox.argument`). */
    argument: string[];
    /** The working directory (`toolbox.process.cwd`). */
    cwd: string;

    /**
     * The resolved `--format`, parsed once here instead of re-validated by every
     * command. A body reads it to decide what belongs on stdout; it never has to
     * ask whether the raw flag was spelled correctly.
     */
    format: OutputFormat;

    /**
     * A fresh Lunora logger, already routed for {@link CommandContext.format} —
     * in `json` mode it writes stderr, leaving stdout to the result document.
     */
    logger: Logger;
    /** Parsed, camelCased options (`toolbox.options`). */
    options: TOptions;
}

/** A command body: read the {@link CommandContext} and resolve to an exit code. */
type CommandBody<TOptions extends Record<string, unknown>> = (context: CommandContext<TOptions>) => Promise<{ code: number }> | { code: number };

/**
 * The cerebro `execute` a command handler exports — the return type of
 * {@link defineHandler}. Handlers annotate their `execute` with this so the
 * exported symbol has an explicit type (required under `isolatedDeclarations`).
 */
type CommandHandler<TOptions extends Record<string, unknown>> = CommandExecute<Toolbox<Console, TOptions>>;

/**
 * Wrap a command body in the shared `execute` envelope so every command handler
 * stays a thin adapter: resolve `--format` and the logger it implies, hand the
 * body the toolbox context, set the exit code it returns via
 * `toolbox.process.exit`, and convert any thrown error into a logged exit
 * through the taxonomy in {@link EXIT_CODE}. The result is a cerebro
 * {@link CommandExecute} — the default a lazy `loader` resolves to.
 */
const defineHandler =
    <TOptions extends Record<string, unknown>>(body: CommandBody<TOptions>): CommandExecute<Toolbox<Console, TOptions>> =>
    async (toolbox) => {
        const logger = createLogger();
        // Before the body runs, and before anything is logged: an unreadable
        // `--format` leaves every decision below (what goes on stdout, where the
        // progress lines land) unanswerable, and it is the invocation that is
        // wrong — the same exit 2 a bad flag has always produced. Every
        // `--format` is declared `type: String`, so cerebro hands over a string
        // or nothing.
        const parsed = parseOutputFormat(toolbox.commandName, (toolbox.options as { format?: string }).format);

        if ("error" in parsed) {
            logger.error(parsed.error);
            toolbox.process.exit(EXIT_CODE.USAGE);

            return;
        }

        const { format } = parsed;

        try {
            const { code } = await body({
                argument: toolbox.argument,
                cwd: toolbox.process.cwd,
                format,
                logger: loggerForFormat(format, logger),
                options: toolbox.options,
            });

            toolbox.process.exit(code);
        } catch (error: unknown) {
            if (error instanceof PromptCancelledError) {
                // User cancelled an interactive prompt — not a failure. Exit quietly
                // with the conventional interactive-cancel code and without touching
                // the red error channel.
                toolbox.process.exit(EXIT_CODE.CANCELLED);

                return;
            }

            const message = error instanceof Error ? error.message : String(error);

            // A Lunora error (or a plain message a solution rule recognises)
            // renders with its actionable hint block — the same treatment
            // `cli.ts` gives an error that escapes cerebro itself. Anything else
            // logs the bare message.
            logger.error(isLunoraError(error) || findSolutionByMessage(message) !== undefined ? renderLunoraError(error) : message);
            toolbox.process.exit(exitCodeForError(error));
        }
    };

export { defineHandler };
export type { CommandBody, CommandContext, CommandHandler };
