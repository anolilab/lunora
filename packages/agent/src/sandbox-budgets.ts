/**
 * The time budgets a sandbox tool call runs under, in one place because the two
 * halves of the call have to agree and they live in different modules: the tool
 * (`sandbox.ts`, which imports the `ai` SDK) picks the DISPATCH budget, and the
 * runtime component (`sandbox-component.ts`, which must stay `ai`-free so it
 * tree-shakes into the `/component` subpath) applies the INNER one.
 *
 * The invariant that matters is `inner < dispatch`, for every op. A dispatch
 * that times out answers 503; a 503 is not a deterministic dispatch failure
 * (timeouts are transient by definition), so the tool's `step.do` rethrows and
 * the host retries the step — re-dispatching the same call while the first is
 * still running. For a browser render that is a second bill; for a container
 * `exec` it is the command running a second time. Nothing dedupes it:
 * `resolveAgentRun` deliberately sends no dedup id, and `sandbox:invoke` takes
 * no idempotency key (an action ctx has nowhere to record one). Keeping the
 * inner deadline strictly tighter means the OP aborts itself, inside its own
 * dispatch, and the tool step completes with that outcome instead of the
 * platform abandoning a still-running side effect.
 */

/**
 * Per-op navigation budget handed to `ctx.browser`, and the ceiling
 * `@lunora/browser` clamps its own `timeoutMs` to. Pinned rather than left to
 * the app's factory default (30s) so the budget a sandbox op actually runs
 * under is known here — which is what lets the dispatch budget be provably
 * wider than it.
 */
export const SANDBOX_BROWSER_NAV_TIMEOUT_MS = 120_000;

/** Dispatch budget for a browser op — strictly wider than the navigation budget. */
export const SANDBOX_BROWSER_DISPATCH_TIMEOUT_MS = 150_000;

/**
 * Per-command budget handed to `ctx.containers.<name>.exec`. Sent on to the
 * container as well, so a well-behaved runner kills the process rather than
 * leaking it when the caller walks away.
 */
export const SANDBOX_EXEC_TIMEOUT_MS = 120_000;

/**
 * Dispatch budget for a container op — strictly wider than
 * {@link SANDBOX_EXEC_TIMEOUT_MS}.
 *
 * REMAINING CEILING, stated plainly: this widens the window, it does not make
 * an `exec` exactly-once. A command that outlives {@link SANDBOX_EXEC_TIMEOUT_MS}
 * is killed; one that somehow outlives the dispatch budget on top of that is
 * still re-dispatched by the step retry. An `exec` that cannot afford to run
 * twice must be idempotent itself, or mark its own completion inside the
 * container. Removing the ceiling entirely needs a fire-then-poll shape — start
 * the command, return an id, poll it — and that needs somewhere durable to
 * record the id, which an action ctx does not have.
 */
export const SANDBOX_CONTAINER_DISPATCH_TIMEOUT_MS = 150_000;
