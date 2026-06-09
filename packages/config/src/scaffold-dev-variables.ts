import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEV_VARS_EXAMPLE_FILE, DEV_VARS_FILE, DEV_VARS_NEWLINE, splitDevVariableLine, unquoteDevVariable } from "./dev-variables-format";

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

const isPlaceholder = (rawValue: string): boolean => {
    const value = unquoteDevVariable(rawValue.trim()).toLowerCase();

    if (value === "") {
        return true;
    }

    if (value.startsWith("<") && value.endsWith(">")) {
        return true;
    }

    return PLACEHOLDER_MARKERS.some((marker) => value.includes(marker));
};

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

    const randomHex = input.randomHex ?? ((bytes: number): string => randomBytes(bytes).toString("hex"));
    const generatedKeys: string[] = [];

    const lines = input.exampleContent.split(DEV_VARS_NEWLINE).map((line) => {
        const parsed = splitDevVariableLine(line);

        if (!parsed || !SECRET_KEY.test(parsed.key) || !isPlaceholder(parsed.value)) {
            return line;
        }

        generatedKeys.push(parsed.key);

        return `${parsed.key}="${randomHex(SECRET_BYTES)}"`;
    });

    return { content: lines.join("\n"), generatedKeys, status: "generate" };
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

// Distinct from `ScaffoldPlan["status"]` on purpose: the plan is pre-prompt
// (`generate` = "could generate"), the result is post-prompt (`generated` =
// "did", `declined` = "user said no").
type EnsureDevVariablesStatus = "declined" | "exists" | "generated" | "no-example";

interface EnsureDevVariablesResult {
    /** Keys whose values were freshly generated, when `status` is `"generated"`. */
    generatedKeys: string[];
    status: EnsureDevVariablesStatus;
}

/**
 * Read the project's `.dev.vars`/`.dev.vars.example`, and — when the former is
 * missing but an example exists — offer to generate it (prompting via `confirm`,
 * unless `yes`). On confirmation, writes `.dev.vars` with secret placeholders
 * filled by fresh random hex and logs which keys were generated. Returns what
 * happened so the caller can tailor any follow-up message.
 *
 * Shared by `cirrus dev` and the `@cirrus/vite` dev server so both behave
 * identically. All side effects funnel through `confirm`/`info`/`randomHex`.
 */
const ensureDevVariables = async (deps: EnsureDevVariablesDeps): Promise<EnsureDevVariablesResult> => {
    const devVariablesPath = join(deps.cwd, DEV_VARS_FILE);
    const examplePath = join(deps.cwd, DEV_VARS_EXAMPLE_FILE);

    const plan = planDevVariablesScaffold({
        devVarsExists: existsSync(devVariablesPath),
        exampleContent: existsSync(examplePath) ? readFileSync(examplePath, "utf8") : undefined,
        randomHex: deps.randomHex,
    });

    if (plan.status !== "generate") {
        // "exists" / "no-example" — nothing to offer, stay quiet.
        return { generatedKeys: [], status: plan.status };
    }

    const proceed = deps.yes === true || (await deps.confirm(`No ${DEV_VARS_FILE} found. Generate it from ${DEV_VARS_EXAMPLE_FILE} (secrets auto-filled)?`));

    if (!proceed) {
        deps.info(`Skipped — copy ${DEV_VARS_EXAMPLE_FILE} to ${DEV_VARS_FILE} and fill it in when you're ready.`);

        return { generatedKeys: [], status: "declined" };
    }

    writeFileSync(devVariablesPath, plan.content, "utf8");

    const generated = plan.generatedKeys.length > 0 ? ` (generated ${plan.generatedKeys.join(", ")})` : "";

    deps.info(`Created ${DEV_VARS_FILE}${generated}.`);

    return { generatedKeys: plan.generatedKeys, status: "generated" };
};

export type { EnsureDevVariablesDeps, EnsureDevVariablesResult, EnsureDevVariablesStatus, ScaffoldPlan };
export { ensureDevVariables, planDevVariablesScaffold };
