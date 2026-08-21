/**
 * Loading the chain toolchains (`@x402/evm` + viem, `@x402/svm` + `@solana/kit`)
 * and `@coinbase/cdp-sdk`, which are optional peers so an EVM-only deployment
 * never installs Solana's (heavy) toolchain.
 */
import { LunoraError } from "@lunora/errors";

/** Node/workerd resolution failures. `MODULE_NOT_FOUND` is the CJS spelling. */
const NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * Bundlers and test runners raise a plain `Error` with no `code`, so the message
 * is the only signal left. Deliberately narrow: anything unmatched is treated as
 * a real failure inside an installed peer and rethrown untouched.
 */
const NOT_FOUND_MESSAGE = /cannot find (?:module|package)|module not found|failed to resolve (?:module|import)/i;

/**
 * Walks `cause`: loaders and test runners wrap the resolution failure in their own
 * error, so the signal is often one or two links down. Bounded, so a self-referential
 * chain cannot spin.
 */
const isModuleNotFound = (error: unknown, depth = 3): boolean => {
    if (typeof error !== "object" || error === null || depth < 0) {
        return false;
    }

    const { cause, code, message } = error as { cause?: unknown; code?: unknown; message?: unknown };

    if (typeof code === "string" && NOT_FOUND_CODES.has(code)) {
        return true;
    }

    if (typeof message === "string" && NOT_FOUND_MESSAGE.test(message)) {
        return true;
    }

    return isModuleNotFound(cause, depth - 1);
};

/**
 * `import()` an optional peer, turning a *missing* module into `guidance` (an
 * `ENV_INVALID` naming the peer and the alternative) and leaving every other
 * failure alone — an installed-but-broken peer (workerd incompatibility, a bad
 * transitive dep, a throw at evaluation time) must report its own cause, not
 * "install it". The original error is attached as `cause` either way.
 *
 * Callers pass a thunk holding a literal specifier (`() => import("viem/accounts")`)
 * so the bundler still sees the dependency.
 * @experimental
 */
export const importOptionalPeer = async <T>(load: () => Promise<T>, guidance: string): Promise<T> => {
    try {
        return await load();
    } catch (error) {
        if (!isModuleNotFound(error)) {
            throw error;
        }

        throw new LunoraError("ENV_INVALID", guidance, { cause: error });
    }
};
