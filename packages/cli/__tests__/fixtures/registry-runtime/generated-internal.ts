/**
 * Runtime stand-in for the `lunora/_generated/internal` codegen emits into a project,
 * which does not exist in this checkout. A reference only has to name its
 * function: `internal.payment.holdCheckout[FUNCTION_PATH]` is
 * `"payment.holdCheckout"`, which a test's `ctx.runMutation` routes on.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */
const FUNCTION_PATH = Symbol("functionPath");

const reference = (path: string[]): unknown =>
    new Proxy(
        {},
        {
            get: (_target, key) => {
                if (key === FUNCTION_PATH) {
                    return path.join(".");
                }

                return typeof key === "string" ? reference([...path, key]) : undefined;
            },
        },
    );

const internal = reference([]) as Record<string, Record<string, Record<typeof FUNCTION_PATH, string>>>;

export { FUNCTION_PATH, internal };
