/**
 * The cancellation signal for interactive prompts, kept in its own dependency-free
 * module so the universal command wrapper (`command.ts`, on the load path of every
 * command) can detect it with `instanceof` without importing `tui-prompts`, which
 * eagerly pulls in the `@visulima/tui` (Ink/React) runtime.
 */

/** Thrown when the user hits Ctrl-C during a prompt or the scaffold tasks, so the flow can abort cleanly instead of continuing with defaults. */
export class PromptCancelledError extends Error {
    public constructor() {
        super("cancelled");
        this.name = "PromptCancelledError";
    }
}

/** Conventional exit code for an interactive cancel (128 + SIGINT). */
export const PROMPT_CANCEL_EXIT_CODE = 130;
