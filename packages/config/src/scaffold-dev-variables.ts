import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    DEV_VARS_NEWLINE,
    parseDevVariableEntries,
    splitDevVariableLine,
    unquoteDevVariable,
} from "./dev-variables-format";

/**
 * Scaffolding `.dev.vars` from `.dev.vars.example`.
 *
 * `@cloudflare/vite-plugin` (and `wrangler dev`) load `.dev.vars` automatically,
 * but the file is gitignored — so a fresh clone has none, and the worker throws
 * the moment it reads a required secret (e.g. `AUTH_SECRET is required`). Rather
 * than make every contributor hand-copy the example and run `openssl` by hand,
 * `cirrus dev` and the Vite plugin offer to generate it: we read the committed
 * `.dev.vars.example`, fill in the secret-looking placeholders with real random
 * values, and keep everything else (comments, non-secret URLs) verbatim.
 *
 * The planner is pure: it turns the two file contents into the text to write.
 * The orchestrator (`ensureDevVariables`) wraps it with file I/O + a prompt.
 * The `.dev.vars` line grammar itself lives in {@link ./dev-variables-format}.
 */

/** Bytes of entropy per generated secret — 32 bytes → 64 hex chars (matches `openssl rand -hex 32`). */
const SECRET_BYTES = 32;

/** A key whose value is a secret we should generate rather than copy from the example. */
const SECRET_KEY = /(?:KEY|PASSWORD|SECRET|TOKEN)$/u;

/**
 * Substrings that mark a value as a fill-me-in placeholder rather than a usable
 * default. We only replace these — a secret-like key the example already pins to
 * a real value (rare, but e.g. a shared dev token) is left untouched. The list
 * leans toward catching the common placeholder conventions: missing one means a
 * `*_SECRET` ships verbatim (a worthless secret the user might even push to
 * prod), which is worse than the bounded, locally-recoverable cost of a false hit.
 */
const PLACEHOLDER_MARKERS = [
    "replace",
    "openssl",
    "changeme",
    "change-me",
    "change_me",
    "change-this",
    "change_this",
    "your-",
    "your_",
    "example",
    "placeholder",
    "todo",
    "fill-me",
    "fill_me",
    "fill-in",
    "fill_in",
    "xxx",
];

/**
 * Whether an (already-unquoted) value looks like a fill-me-in placeholder —
 * empty, angle-bracketed, or containing a known marker — rather than a real
 * value. Used both when scaffolding (which values to regenerate) and by
 * `cirrus env doctor` (which set values are still unfilled).
 */
const isPlaceholderValue = (value: string): boolean => {
    const normalised = value.trim().toLowerCase();

    if (normalised === "") {
        return true;
    }

    if (normalised.startsWith("<") && normalised.endsWith(">")) {
        return true;
    }

    return PLACEHOLDER_MARKERS.some((marker) => normalised.includes(marker));
};

const isPlaceholder = (rawValue: string): boolean => isPlaceholderValue(unquoteDevVariable(rawValue.trim()));

/** Default secret generator — 64 hex chars, like `openssl rand -hex 32`. */
const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

/**
 * The fresh secret to substitute for an example `key=value` entry, or `undefined`
 * when the example value should be used as-is (non-secret key, or a value the
 * example already pins to something real). The single rule both the full-file
 * generate and the missing-key augment share.
 */
const generatedSecretFor = (key: string, rawValue: string, randomHex: (bytes: number) => string): string | undefined =>
    SECRET_KEY.test(key) && isPlaceholder(rawValue) ? randomHex(SECRET_BYTES) : undefined;

/**
 * The outcome of planning a scaffold — a discriminated union so the orchestrator
 * never has to re-derive whether `content` is present.
 *
 * `exists`: `.dev.vars` is already there; nothing to do.
 * `no-example`: nothing to scaffold from (stay silent — the project may not use secrets).
 * `generate`: write `content`, a copy of the example with secret-looking placeholders replaced by fresh random hex (`generatedKeys` lists which).
 */
type ScaffoldPlan = { content: string; generatedKeys: string[]; status: "generate" } | { status: "exists" } | { status: "no-example" };

/** Decide whether (and what) to scaffold. Pure — given the current state of the two files. */
const planDevVariablesScaffold = (input: {
    devVarsExists: boolean;
    exampleContent: string | undefined;
    /** Injectable for deterministic tests; defaults to `crypto.randomBytes`. */
    randomHex?: (bytes: number) => string;
}): ScaffoldPlan => {
    if (input.devVarsExists) {
        return { status: "exists" };
    }

    if (input.exampleContent === undefined) {
        return { status: "no-example" };
    }

    const randomHex = input.randomHex ?? defaultRandomHex;
    const generatedKeys: string[] = [];

    const lines = input.exampleContent.split(DEV_VARS_NEWLINE).map((line) => {
        const parsed = splitDevVariableLine(line);
        const secret = parsed ? generatedSecretFor(parsed.key, parsed.value, randomHex) : undefined;

        if (!parsed || secret === undefined) {
            return line;
        }

        generatedKeys.push(parsed.key);

        return `${parsed.key}="${secret}"`;
    });

    return { content: lines.join("\n"), generatedKeys, status: "generate" };
};

interface AugmentPlan {
    /** The `.dev.vars` lines to append, in example order. */
    additions: string[];
    /** The subset of `missingKeys` whose values were freshly generated. */
    generatedKeys: string[];
    /** Keys present in the example but absent from the current `.dev.vars`. */
    missingKeys: string[];
}

/**
 * Plan how to top up an existing `.dev.vars` from the example: every example key
 * not already present becomes an appended line (secret placeholders filled with
 * fresh random hex, other values copied). Pure — no I/O. Empty `missingKeys`
 * means the file is already complete.
 */
const planDevVariablesAugment = (input: {
    exampleContent: string;
    existingContent: string;
    /** Injectable for deterministic tests; defaults to `crypto.randomBytes`. */
    randomHex?: (bytes: number) => string;
}): AugmentPlan => {
    const randomHex = input.randomHex ?? defaultRandomHex;
    const present = new Set(parseDevVariableEntries(input.existingContent).map((entry) => entry.key));

    const additions: string[] = [];
    const generatedKeys: string[] = [];
    const missingKeys: string[] = [];

    for (const line of input.exampleContent.split(DEV_VARS_NEWLINE)) {
        const parsed = splitDevVariableLine(line);

        if (!parsed || present.has(parsed.key)) {
            continue;
        }

        const secret = generatedSecretFor(parsed.key, parsed.value, randomHex);

        missingKeys.push(parsed.key);

        if (secret === undefined) {
            additions.push(`${parsed.key}="${unquoteDevVariable(parsed.value)}"`);
        } else {
            generatedKeys.push(parsed.key);
            additions.push(`${parsed.key}="${secret}"`);
        }
    }

    return { additions, generatedKeys, missingKeys };
};

interface EnsureDevVariablesDeps {
    /**
     * Ask the user to confirm generating the file. Return `true` to generate.
     * Consumers pass a TTY-aware prompt; in non-interactive contexts they should
     * resolve `false` (we then report `"declined"` and the caller can hint).
     */
    confirm: (message: string) => Promise<boolean>;
    cwd: string;
    /** Emit a human-facing line (success / hint). */
    info: (message: string) => void;
    /** Injectable for tests; defaults to `crypto.randomBytes` hex. */
    randomHex?: (bytes: number) => string;
    /** Generate without prompting (e.g. a `--yes` flag). */
    yes?: boolean;
}

// Distinct from `ScaffoldPlan["status"]` on purpose: the plan is pre-prompt,
// the result is post-prompt. `generated` = wrote a fresh file, `augmented` =
// topped up an existing one, `declined` = user said no.
type EnsureDevVariablesStatus = "augmented" | "declined" | "exists" | "generated" | "no-example";

interface EnsureDevVariablesResult {
    /** Keys appended to an existing file, when `status` is `"augmented"`. */
    addedKeys: string[];
    /** Keys whose values were freshly generated, when `status` is `"generated"`/`"augmented"`. */
    generatedKeys: string[];
    status: EnsureDevVariablesStatus;
}

/** `" (generated A, B)"` for a log line, or `""` when nothing was generated. */
const generatedSuffix = (keys: string[]): string => (keys.length > 0 ? ` (generated ${keys.join(", ")})` : "");

/** Append lines to an existing `.dev.vars`, inserting a separating newline only if needed. */
const appendDevVariables = (path: string, additions: string[]): void => {
    const existing = readFileSync(path, "utf8");
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

    writeFileSync(path, `${existing}${separator}${additions.join("\n")}\n`, "utf8");
};

/**
 * Reconcile the project's `.dev.vars` with its `.dev.vars.example`:
 *
 * - file missing → offer to generate it (secret placeholders auto-filled);
 * - file present but missing keys the example lists → offer to append them;
 * - file present and complete → nothing to do.
 *
 * Prompts via `confirm` (skipped when `yes`); never overwrites existing values.
 * Returns what happened so the caller can tailor any follow-up. Shared by
 * `cirrus dev` and the `@cirrus/vite` dev server. All side effects funnel
 * through `confirm`/`info`/`randomHex`.
 */
const ensureDevVariables = async (deps: EnsureDevVariablesDeps): Promise<EnsureDevVariablesResult> => {
    const devVariablesPath = join(deps.cwd, DEV_VARS_FILE);
    const examplePath = join(deps.cwd, DEV_VARS_EXAMPLE_FILE);

    if (!existsSync(examplePath)) {
        return { addedKeys: [], generatedKeys: [], status: "no-example" };
    }

    const exampleContent = readFileSync(examplePath, "utf8");

    // File missing entirely → offer to generate the whole thing.
    if (!existsSync(devVariablesPath)) {
        const plan = planDevVariablesScaffold({ devVarsExists: false, exampleContent, randomHex: deps.randomHex });

        if (plan.status !== "generate") {
            return { addedKeys: [], generatedKeys: [], status: "no-example" };
        }

        const proceed =
            deps.yes === true || (await deps.confirm(`No ${DEV_VARS_FILE} found. Generate it from ${DEV_VARS_EXAMPLE_FILE} (secrets auto-filled)?`));

        if (!proceed) {
            deps.info(`Skipped — copy ${DEV_VARS_EXAMPLE_FILE} to ${DEV_VARS_FILE} and fill it in when you're ready.`);

            return { addedKeys: [], generatedKeys: [], status: "declined" };
        }

        writeFileSync(devVariablesPath, plan.content, "utf8");
        deps.info(`Created ${DEV_VARS_FILE}${generatedSuffix(plan.generatedKeys)}.`);

        return { addedKeys: [], generatedKeys: plan.generatedKeys, status: "generated" };
    }

    // File present → top up any keys the example lists but the file lacks.
    const augment = planDevVariablesAugment({ existingContent: readFileSync(devVariablesPath, "utf8"), exampleContent, randomHex: deps.randomHex });

    if (augment.missingKeys.length === 0) {
        return { addedKeys: [], generatedKeys: [], status: "exists" };
    }

    const list = augment.missingKeys.join(", ");
    const proceed =
        deps.yes === true ||
        (await deps.confirm(`${DEV_VARS_FILE} is missing ${String(augment.missingKeys.length)} key(s) from ${DEV_VARS_EXAMPLE_FILE} (${list}). Add them?`));

    if (!proceed) {
        deps.info(`Skipped — add ${list} to ${DEV_VARS_FILE} when you're ready.`);

        return { addedKeys: [], generatedKeys: [], status: "declined" };
    }

    appendDevVariables(devVariablesPath, augment.additions);
    deps.info(`Updated ${DEV_VARS_FILE} — added ${list}${generatedSuffix(augment.generatedKeys)}.`);

    return { addedKeys: augment.missingKeys, generatedKeys: augment.generatedKeys, status: "augmented" };
};

export type { AugmentPlan, EnsureDevVariablesDeps, EnsureDevVariablesResult, EnsureDevVariablesStatus, ScaffoldPlan };
export { ensureDevVariables, isPlaceholderValue, planDevVariablesAugment, planDevVariablesScaffold };
