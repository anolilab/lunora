import { findSolutionByMessage, isLunoraError } from "@lunora/errors";
import type { CommandExecute, Toolbox } from "@visulima/cerebro";

import { EXIT_CODE, exitCodeForError } from "./exit-code";
import type { Logger } from "./logger";
import { createLogger } from "./logger";
import PromptCancelledError from "./prompt-cancelled";
import { renderLunoraError } from "./render-lunora-error";

/** The context a command body receives — the toolbox bits every command needs. */
interface CommandContext<TOptions extends Record<string, unknown>> {
    /** Positional arguments (`toolbox.argument`). */
    argument: string[];
    /** The working directory (`toolbox.process.cwd`). */
    cwd: string;
    /** A fresh Lunora logger. */
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
 * stays a thin adapter: build the logger, hand the body the toolbox context, set
 * the exit code it returns via `toolbox.process.exit`, and convert any thrown
 * error into a logged exit through the taxonomy in {@link EXIT_CODE}. The result
 * is a cerebro {@link CommandExecute} — the default a lazy `loader` resolves to.
 */
const defineHandler =
    <TOptions extends Record<string, unknown>>(body: CommandBody<TOptions>): CommandExecute<Toolbox<Console, TOptions>> =>
    async (toolbox) => {
        const logger = createLogger();

        try {
            const { code } = await body({ argument: toolbox.argument, cwd: toolbox.process.cwd, logger, options: toolbox.options });

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
