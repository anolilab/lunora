/**
 * Which `.dev.vars`-shaped file holds one environment's values. `deploy` records
 * the secrets it mints for a named environment here and `env` reads and writes
 * the same file, so the two must resolve it identically.
 */
import { DEV_VARS_FILE, ensureGitignoreEntries } from "@lunora/config";

import type { Logger } from "./logger";

/** The name is spliced into a filename, so anything but a plain fragment (`../x`) is refused. */
const SAFE_ENV_NAME = /^[\w-]+$/u;

/**
 * The `.gitignore` lines that cover every `.dev.vars`-shaped file. `.dev.vars`
 * alone is an exact-name pattern and does not match the `.dev.vars.<env>`
 * sibling; the negation keeps a checked-in `.dev.vars.example` visible. Same set
 * the `lunora init` overlay writes.
 *
 * ORDER IS LOAD-BEARING: git is last-match-wins, so the negation only works
 * while it sits below every pattern that would otherwise catch the example file.
 */
const DEV_VARS_IGNORE_PATTERNS = [".dev.vars", ".dev.vars.*", "!.dev.vars.example"];

/**
 * The file for `environment`: the bare `.dev.vars` for the default environment
 * (the one `lunora dev` reads), `.dev.vars.<name>` for a named one so its
 * values are never shared with local dev. `undefined` when the name is not a
 * safe filename fragment.
 */
const devVariablesFileFor = (environment: string | undefined): string | undefined => {
    if (environment === undefined) {
        return DEV_VARS_FILE;
    }

    return SAFE_ENV_NAME.test(environment) ? `${DEV_VARS_FILE}.${environment}` : undefined;
};

/**
 * Make sure the project's `.gitignore` covers the `.dev.vars`-shaped file about
 * to receive a secret. Every scaffolded project ships the bare pattern only, so
 * without this the `.dev.vars.<env>` sibling is untracked but NOT ignored and
 * the next `git add -A` commits it.
 *
 * Best-effort: a `.gitignore` that cannot be written (read-only checkout, no
 * git at all) must not cost the user the only recoverable copy of a write-only
 * secret, so it warns and lets the write proceed.
 */
const ensureDevVariablesIgnored = (cwd: string, logger: Logger): void => {
    try {
        const missing = ensureGitignoreEntries(cwd, DEV_VARS_IGNORE_PATTERNS);

        if (missing.length > 0) {
            logger.info(`.gitignore: added ${missing.join(", ")} so the recorded secret cannot be committed`);
        }
    } catch (error) {
        logger.warn(
            `could not update .gitignore (${error instanceof Error ? error.message : String(error)}) — add \`${DEV_VARS_IGNORE_PATTERNS.join("` and `")}\` by hand before committing.`,
        );
    }
};

export { devVariablesFileFor, ensureDevVariablesIgnored };
