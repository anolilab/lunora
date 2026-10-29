/**
 * The cancellation signal for interactive prompts, kept in its own dependency-free
 * module so the universal command wrapper (`command.ts`, on the load path of every
 * command) can detect it with `instanceof` without importing `tui-prompts`, which
 * eagerly pulls in the `@visulima/tui` (Ink/React) runtime.
 */

/**
 * Thrown when the user hits Ctrl-C during a prompt or the scaffold tasks, so the
 * flow can abort cleanly instead of continuing with defaults. The exit code it
 * resolves to lives with the rest of the taxonomy, as `EXIT_CODE.CANCELLED`.
 *
 * A default export because it is this module's ONLY export — which is what keeps
 * the module dependency-free, per the note above.
 */
class PromptCancelledError extends Error {
    public constructor() {
        super("cancelled");
        this.name = "PromptCancelledError";
    }
}

export default PromptCancelledError;
