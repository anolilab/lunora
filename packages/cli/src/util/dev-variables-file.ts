/**
 * Which `.dev.vars`-shaped file holds one environment's values. `deploy` records
 * the secrets it mints for a named environment here and `env` reads and writes
 * the same file, so the two must resolve it identically.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEV_VARS_FILE, ensureGitignoreEntries } from "@lunora/config";

import type { Logger } from "./logger";

/** The name is spliced into a filename, so anything but a plain fragment (`../x`) is refused. */
const SAFE_ENV_NAME = /^[\w-]+$/u;

/**
 * `.dev.vars.example` is the committed template the ignore patterns keep visible, so no secret may be written to it.
 * Compared case-insensitively: on a case-insensitive filesystem `.dev.vars.Example` is that same file.
 */
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set(["example"]);

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
 * safe filename fragment or names the committed example file.
 */
const devVariablesFileFor = (environment: string | undefined): string | undefined => {
    if (environment === undefined) {
        return DEV_VARS_FILE;
    }

    return SAFE_ENV_NAME.test(environment) && !RESERVED_ENV_NAMES.has(environment.toLowerCase()) ? `${DEV_VARS_FILE}.${environment}` : undefined;
};

/** Add the ignore patterns, returning why that failed, or `undefined` once `.gitignore` covers every `.dev.vars` file. */
const addDevVariablesIgnorePatterns = (cwd: string, logger: Logger): string | undefined => {
    try {
        const missing = ensureGitignoreEntries(cwd, DEV_VARS_IGNORE_PATTERNS);

        if (missing.length > 0) {
            logger.info(`.gitignore: added ${missing.join(", ")} so the recorded secret cannot be committed`);
        }

        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
};

/**
 * Make sure the project's `.gitignore` covers the `.dev.vars`-shaped file about
 * to receive a secret. Every scaffolded project ships the bare pattern only, so
 * without this the `.dev.vars.<env>` sibling is untracked but NOT ignored and
 * the next `git add -A` commits it.
 *
 * Best-effort, for a value that is already pushed: a `.gitignore` that cannot be
 * written must not cost the user the only recoverable copy of a write-only
 * secret, so it warns and lets the write proceed. Anything that has not pushed
 * yet checks {@link refuseUnsafeSecretFile} instead.
 */
const ensureDevVariablesIgnored = (cwd: string, logger: Logger): void => {
    const failure = addDevVariablesIgnorePatterns(cwd, logger);

    if (failure !== undefined) {
        logger.warn(`could not update .gitignore (${failure}) — add \`${DEV_VARS_IGNORE_PATTERNS.join("` and `")}\` by hand before committing.`);
    }
};

/**
 * The other `.dev.vars`-shaped file in `cwd` that `file` is a symlink or hard link to, or `undefined`.
 * Reading or writing through such a link reaches another environment's values.
 */
const linkedDevVariablesFile = (cwd: string, file: string): string | undefined => {
    const own = statSync(join(cwd, file), { throwIfNoEntry: false });

    if (own === undefined) {
        return undefined;
    }

    let names: string[];

    try {
        names = readdirSync(cwd);
    } catch {
        return undefined;
    }

    // On a case-insensitive filesystem `file` may be listed under another case; on a case-sensitive one
    // a case-only sibling is a separate entry and can be a link like any other.
    const self = names.includes(file) ? file : names.find((name) => name.toLowerCase() === file.toLowerCase());

    return names.find((name) => {
        if (name === self || (name !== DEV_VARS_FILE && !name.startsWith(`${DEV_VARS_FILE}.`))) {
            return false;
        }

        const other = statSync(join(cwd, name), { throwIfNoEntry: false });

        return other?.dev === own.dev && other.ino === own.ino;
    });
};

/**
 * Whether git already tracks `file`: an ignore pattern does not apply to a tracked file, so a
 * secret written there shows up as a change the next `git commit -a` records. Outside a repository,
 * or without git, nothing is tracked.
 *
 * Matched case-insensitively: on a case-insensitive filesystem `--env Production` writes the tracked
 * `.dev.vars.production`. On a case-sensitive one that refuses a file the write would not reach,
 * which costs a rename and leaks nothing.
 */
const isDevVariablesFileTracked = (cwd: string, file: string): boolean =>
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH (install location varies); args are fixed and no shell is involved
    spawnSync("git", ["ls-files", "--error-unmatch", "--", `:(icase)${file}`], { cwd, stdio: "ignore" }).status === 0;

/**
 * Why `file` must not receive a secret, or `undefined` once it is safe and git-ignored. Checked before
 * anything is written, minted or pushed: a file that links to another `.dev.vars` file writes that
 * environment's values, a tracked one stays committable whatever `.gitignore` says, and one
 * `.gitignore` cannot cover is one `git add -A` from the repository.
 */
const refuseUnsafeSecretFile = (cwd: string, file: string, logger: Logger): string | undefined => {
    const linked = linkedDevVariablesFile(cwd, file);
    // A named file linked to the bare `.dev.vars` is refused wherever it is read or written; the bare
    // file is the source others link to, so it is refused only when it is itself the link.
    const isTheLink = file !== DEV_VARS_FILE || lstatSync(join(cwd, file), { throwIfNoEntry: false })?.isSymbolicLink() === true;

    if (linked !== undefined && isTheLink) {
        return `${file} is a link to ${linked}, so a secret written to it would land in ${linked}. Give ${file} its own contents`;
    }

    if (isDevVariablesFileTracked(cwd, file)) {
        return `${file} is tracked by git, so a secret written to it could be committed. Run \`git rm --cached ${file}\``;
    }

    const failure = addDevVariablesIgnorePatterns(cwd, logger);

    return failure === undefined
        ? undefined
        : `.gitignore could not be updated (${failure}), so ${file} could be committed. Add \`${DEV_VARS_IGNORE_PATTERNS.join("` and `")}\` to it by hand`;
};

const LINE_BREAK = /\r?\n/u;

/**
 * Heads the comment deploy writes beside a key's active value when it minted a new one whose push
 * failed: either value may be the live one until the user keeps exactly one.
 */
const UNCONFIRMED_MINT_MARKER = "# Minted by a deploy whose push failed; the live value if that push applied: ";

/** The keys in `raw` still carrying {@link UNCONFIRMED_MINT_MARKER}. */
const unconfirmedMintKeys = (raw: string): string[] => [
    ...new Set(
        raw
            .split(LINE_BREAK)
            .filter((line) => line.startsWith(UNCONFIRMED_MINT_MARKER))
            .map((line) => line.slice(UNCONFIRMED_MINT_MARKER.length).split("=")[0]?.trim() ?? "")
            .filter((key) => key !== ""),
    ),
];

export {
    devVariablesFileFor,
    ensureDevVariablesIgnored,
    isDevVariablesFileTracked,
    linkedDevVariablesFile,
    refuseUnsafeSecretFile,
    UNCONFIRMED_MINT_MARKER,
    unconfirmedMintKeys,
};
