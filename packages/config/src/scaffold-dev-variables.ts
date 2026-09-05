/* eslint-disable no-secrets/no-secrets -- JSDoc quotes the `KEY="<placeholder>"` .dev.vars grammar, not a credential. */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

import { DEV_VARS_EXAMPLE_FILE, DEV_VARS_FILE, DEV_VARS_NEWLINE, parseDevVariableEntries, parseDevVariableLine } from "./dev-variables-format";
import type { SecretEntry } from "./package-secrets-registry";
import { CORE_SECRETS, MINTABLE_SECRET_KEYS, secretsForPackages } from "./package-secrets-registry";

/** Core (always-scaffolded) secrets followed by the package-specific ones for the detected capabilities. */
const requiredSecrets = (packageNames: ReadonlyArray<string>): SecretEntry[] => [...CORE_SECRETS, ...secretsForPackages(packageNames)];

/**
 * Scaffolding `.dev.vars` from `.dev.vars.example`.
 *
 * `@cloudflare/vite-plugin` (and `wrangler dev`) load `.dev.vars` automatically,
 * but the file is gitignored — so a fresh clone has none, and the worker throws
 * the moment it reads a required secret (e.g. `AUTH_SECRET is required`). Rather
 * than make every contributor hand-copy the example and run `openssl` by hand,
 * `lunora dev` and the Vite plugin offer to generate it: we read the committed
 * `.dev.vars.example`, fill in the secret-looking placeholders with real random
 * values, and keep everything else (comments, non-secret URLs) verbatim.
 *
 * The planner is pure: it turns the two file contents into the text to write.
 * The orchestrator (`ensureDevVariables`) wraps it with file I/O + a prompt.
 * The `.dev.vars` line grammar itself lives in {@link ./dev-variables-format}.
 */

/** Bytes of entropy per generated secret — 32 bytes → 64 hex chars (matches `openssl rand -hex 32`). */
const SECRET_BYTES = 32;

/**
 * Markers that flag a value as a fill-me-in placeholder rather than a usable
 * default. We only replace these — a secret-like key the example already pins to
 * a real value (rare, but e.g. a shared dev token) is left untouched. The list
 * leans toward catching the common placeholder conventions: missing one means a
 * `*_SECRET` ships verbatim (a worthless secret the user might even push to
 * prod), which is worse than the bounded, locally-recoverable cost of a false hit.
 *
 * Matching is **whole-token**, not raw substring (see {@link isPlaceholderValue}):
 * a marker matches only when it stands alone — bounded by the string edges or a
 * non-alphanumeric neighbour — so `todoist.com` / `examples-of-x` are NOT hits.
 * Markers ending in `-`/`_` (e.g. `your-`, `your_`) are **prefix** markers: their
 * trailing `-`/`_` is itself the boundary, so they match `your-key`, `your_token`, …
 * When adding a marker, keep this in mind: a plain word matches only as a whole
 * token, a `-`/`_`-terminated one matches as a prefix.
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

/** RegExp metacharacters escaped before a marker is spliced into a dynamic pattern. */
const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/gu;

/** A marker that ends in an alphanumeric char needs an explicit trailing word boundary. */
const MARKER_ENDS_ALPHANUMERIC = /[a-z0-9]$/u;

/**
 * Whether an (already-unquoted) value looks like a fill-me-in placeholder —
 * empty, angle-bracketed, or containing a known marker — rather than a real
 * value. Used both when scaffolding (which values to regenerate) and by
 * `lunora env doctor` (which set values are still unfilled).
 */
const isPlaceholderValue = (value: string): boolean => {
    const normalised = value.trim().toLowerCase();

    if (normalised === "") {
        return true;
    }

    if (normalised.startsWith("<") && normalised.endsWith(">")) {
        return true;
    }

    return PLACEHOLDER_MARKERS.some((marker) => {
        const escaped = marker.replaceAll(REGEXP_SPECIAL_CHARS, String.raw`\$&`);
        // A marker must stand alone: bounded on the left by a string edge or a
        // non-alphanumeric char. On the right we require the same boundary *unless*
        // the marker already ends in a non-alphanumeric char (a `-`/`_` prefix
        // marker like `your-`), whose own terminator is the boundary. This stops
        // `todoist` / `examples-of-x` matching while keeping `todo`, `change-me`,
        // and the `your-`/`your_` prefixes working.
        const needsTrailingBoundary = MARKER_ENDS_ALPHANUMERIC.test(marker);
        const pattern = needsTrailingBoundary ? `(^|[^a-z0-9])${escaped}([^a-z0-9]|$)` : `(^|[^a-z0-9])${escaped}`;

        return new RegExp(pattern, "u").test(normalised);
    });
};

/** Default secret generator — 64 hex chars, like `openssl rand -hex 32`. */
const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

/**
 * True for a secret key the registry says Lunora can mint locally (a random
 * 32-byte hex, like `openssl rand -hex 32`) — `AUTH_SECRET`,
 * `LUNORA_ADMIN_TOKEN`, `STORAGE_SIGNING_SECRET`, …
 *
 * Registry membership, NOT the key's name shape, is the rule. A secret-looking
 * key nothing in the registry declares (`OPENAI_API_KEY`,
 * `GITHUB_CLIENT_SECRET`, a project's own `*_TOKEN`) is provider-issued as far
 * as Lunora knows, so minting for it would write a value the provider rejects at
 * runtime — over the developer's own half-filled `.dev.vars` — and hide the gap
 * from `lunora env doctor`, whose job is to report it as unfilled.
 */
const isMintableSecretKey = (key: string): boolean => MINTABLE_SECRET_KEYS.has(key);

/**
 * The fresh secret to substitute for an example `key=value` entry, or `undefined`
 * when the example value should be used as-is (non-secret key, a provider-issued
 * key we cannot mint locally, or a value the example already pins to something
 * real). The single rule both the full-file generate and the missing-key augment
 * share.
 *
 * Only {@link isMintableSecretKey mintable} secret keys are regenerated:
 * provider-issued placeholders (e.g. `RESEND_API_KEY`, `STRIPE_SECRET_KEY`) and
 * every key outside the registry (`OPENAI_API_KEY`, a project's own
 * `*_CLIENT_SECRET`) are left verbatim so they stay detectable as unfilled by
 * `lunora env doctor` — minting a random value for one would be actively wrong
 * (the provider would reject it) and would hide the misconfiguration.
 */
const generatedSecretFor = (key: string, value: string, randomHex: (bytes: number) => string): string | undefined =>
    isMintableSecretKey(key) && isPlaceholderValue(value) ? randomHex(SECRET_BYTES) : undefined;

/** Mint a fresh strong secret value — 64 hex chars (32 bytes), like `openssl rand -hex 32`. */
const generateSecretValue = (randomHex: (bytes: number) => string = defaultRandomHex): string => randomHex(SECRET_BYTES);

/**
 * The content's lines with every mintable placeholder secret replaced by a
 * fresh generated value (recorded into `filledKeys`); comments and every other
 * line are preserved verbatim. Shared by the full-file scaffold and the
 * in-place fill.
 */
const fillSecretLines = (content: string, randomHex: (bytes: number) => string, filledKeys: string[]): string[] =>
    content.split(DEV_VARS_NEWLINE).map((line) => {
        const parsed = parseDevVariableLine(line);
        const secret = parsed ? generatedSecretFor(parsed.key, parsed.value, randomHex) : undefined;

        if (!parsed || secret === undefined) {
            return line;
        }

        filledKeys.push(parsed.key);

        return `${parsed.key}="${secret}"`;
    });

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

    const generatedKeys: string[] = [];
    const lines = fillSecretLines(input.exampleContent, input.randomHex ?? defaultRandomHex, generatedKeys);

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
 * Render `value` for interpolation into a double-quoted `.dev.vars` entry.
 *
 * `parseDevVariableLine` runs dotenv's own parser, which EXPANDS `\n` and `\r`
 * inside a double-quoted example value. Re-emitting that expansion verbatim
 * would put a physical line break inside the entry, and every rewrite here is
 * line-oriented (`env set` / `env unset` replace whole lines), so the tail would
 * be left behind as an orphaned fragment. Re-escaping puts the value back in the
 * form dotenv expands to exactly what it read.
 *
 * A literal `"` or `\` has no such form — dotenv does not unescape `\"`, so
 * there is no way to spell one inside a double-quoted value. Rather than emit a
 * line whose quote closes early and silently truncates the value, those render
 * empty for the developer to fill in, which is what an example placeholder is
 * for anyway.
 */
const renderExampleValue = (value: string): string => {
    if (value.includes('"') || value.includes("\\")) {
        return "";
    }

    return value.replaceAll("\r", String.raw`\r`).replaceAll("\n", String.raw`\n`);
};

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
        const parsed = parseDevVariableLine(line);

        if (!parsed || present.has(parsed.key)) {
            continue;
        }

        const secret = generatedSecretFor(parsed.key, parsed.value, randomHex);

        missingKeys.push(parsed.key);

        if (secret === undefined) {
            additions.push(`${parsed.key}="${renderExampleValue(parsed.value)}"`);
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
// `skipped-exists` = another process created `.dev.vars` between our existence
// check and the atomic rename (a create-race), so we left its file untouched.
type EnsureDevVariablesStatus = "augmented" | "declined" | "exists" | "generated" | "no-example" | "skipped-exists";

interface EnsureDevVariablesResult {
    /** Keys appended to an existing file, when `status` is `"augmented"`. */
    addedKeys: string[];
    /** Keys whose values were freshly generated, when `status` is `"generated"`/`"augmented"`. */
    generatedKeys: string[];
    status: EnsureDevVariablesStatus;
}

/** `" (generated A, B)"` for a log line, or `""` when nothing was generated. */
const generatedSuffix = (keys: string[]): string => (keys.length > 0 ? ` (generated ${keys.join(", ")})` : "");

/**
 * Atomically write `path`: write the content to a sibling temp file, then
 * `rename` it over the target. The rename is atomic within one filesystem, so
 * a reader can never observe a half-written file, and an interrupt mid-write
 * can't truncate the target. The temp lives in the same directory so the
 * rename never crosses devices (`EXDEV`); on any failure it is removed before
 * the error propagates, and the content is never logged or thrown.
 *
 * `mode: 0o600` for secret-bearing files so they are owner-only, not
 * world-readable on a shared host (Node otherwise defaults to 0o666 → 0o644
 * under the usual umask); `rename` preserves the temp file's mode. `flag:
 * "wx"` makes the temp write exclusive-create for callers racing a concurrent
 * `lunora dev` / Vite dev server.
 */
const atomicWrite = (path: string, content: string, options: { flag?: "wx"; mode?: number } = {}): void => {
    const temporaryPath = `${path}.tmp-${String(process.pid)}`;

    try {
        writeFileSync(temporaryPath, content, { encoding: "utf8", ...options });
        renameSync(temporaryPath, path);
    } catch (error) {
        rmSync(temporaryPath, { force: true });

        throw error;
    }
};

/**
 * Atomically (over)write a `.dev.vars`-shaped file, owner-only. For a file
 * holding secrets a torn write would destroy every other local value alongside
 * the new one, and the new value itself has no other recoverable copy if it
 * was never disclosed anywhere else (Cloudflare secrets are write-only).
 * Exported so a caller writing to a `.dev.vars`-shaped path outside this
 * module (`lunora deploy`'s minted-secret disclosure) reuses this instead of
 * hand-rolling another copy of the pattern.
 */
const writeDevVariablesFileAtomically = (path: string, content: string): void => {
    atomicWrite(path, content, { mode: 0o600 });
};

/** Retry budget for {@link appendDevVariables}'s compare-and-swap loop. */
const APPEND_MAX_ATTEMPTS = 5;

/** The bits of file identity we compare before trusting our read was still current at rename time. */
interface FileFingerprint {
    mtimeMs: number;
    size: number;
}

/** `undefined` when the path doesn't exist (e.g. it was deleted between attempts). */
const fingerprintOf = (path: string): FileFingerprint | undefined => {
    try {
        const stats = statSync(path);

        return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
        return undefined;
    }
};

const sameFingerprint = (a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean => {
    if (a === undefined || b === undefined) {
        return false;
    }

    return a.mtimeMs === b.mtimeMs && a.size === b.size;
};

/**
 * Append lines to an existing `.dev.vars`, atomically and owner-only, via a
 * compare-and-swap retry loop.
 *
 * Mirrors {@link atomicWrite} in shape (sibling temp file, `mode:
 * 0o600`, atomic `rename`), but a plain read-modify-write is not enough here:
 * two concurrent `lunora dev` / Vite processes could both read the same old
 * content, each append their own additions, and the second `rename` would
 * silently discard the first writer's lines. To close that window:
 *
 * 1. Each attempt reads the file and fingerprints it (`mtimeMs` + `size`).
 * 2. `buildAdditions(existing)` re-derives the lines to append from that fresh
 * read (the caller re-runs its planner, e.g. {@link planDevVariablesAugment},
 * so a peer's already-landed keys are recognised as present and skipped).
 * 3. The new content is written to an attempt-unique temp file (pid + random
 * suffix, so two processes never collide on the temp path itself).
 * 4. The target is re-fingerprinted immediately before the rename. If it
 * changed since step 1, a peer won the race — discard the temp file and
 * retry from a fresh read/merge instead of clobbering their append.
 *
 * Returns the additions actually written (from the attempt that won), or `[]`
 * if a fresh read showed nothing left to add (a peer already added everything
 * this call wanted). Throws after {@link APPEND_MAX_ATTEMPTS} losing attempts;
 * the error names only the path, never file content or additions.
 */
const appendDevVariables = (path: string, buildAdditions: (existing: string) => string[]): string[] => {
    for (let attempt = 0; attempt < APPEND_MAX_ATTEMPTS; attempt += 1) {
        const beforeFingerprint = fingerprintOf(path);
        const existing = readFileSync(path, "utf8");
        const additions = buildAdditions(existing);

        if (additions.length === 0) {
            return [];
        }

        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        const content = `${existing}${separator}${additions.join("\n")}\n`;

        const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomBytes(6).toString("hex")}`;

        try {
            writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });

            // Re-check the target's identity right before the swap: if it moved
            // since our read, another writer won the race — discard our temp file
            // and retry from a fresh read/merge instead of clobbering their append.
            const beforeRenameFingerprint = fingerprintOf(path);

            if (!sameFingerprint(beforeFingerprint, beforeRenameFingerprint)) {
                rmSync(temporaryPath, { force: true });

                continue;
            }

            renameSync(temporaryPath, path);

            return additions;
        } catch (error) {
            rmSync(temporaryPath, { force: true });

            throw error;
        }
    }

    throw new LunoraError("INTERNAL", `Failed to append to ${path} after ${String(APPEND_MAX_ATTEMPTS)} attempts — a concurrent writer kept winning the race.`);
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
 * `lunora dev` and the `@lunora/vite` dev server. All side effects funnel
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

        // Re-check right before the write: another process may have created the
        // file since the `existsSync` above. If so, bail rather than overwrite the
        // peer's (possibly secret-bearing) file. The `wx` temp write keeps the
        // create exclusive against a peer racing this same path.
        if (existsSync(devVariablesPath)) {
            return { addedKeys: [], generatedKeys: [], status: "skipped-exists" };
        }

        atomicWrite(devVariablesPath, plan.content, { flag: "wx", mode: 0o600 });
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

    // Re-plan from whatever `.dev.vars` looks like on each attempt: a concurrent
    // writer may have already landed some (or all) of these keys between our
    // initial read above and the rename, and re-running the (pure) planner
    // against the fresh content naturally treats those keys as already-present
    // and skips them, instead of clobbering the peer's append.
    const written = appendDevVariables(
        devVariablesPath,
        (currentContent) => planDevVariablesAugment({ existingContent: currentContent, exampleContent, randomHex: deps.randomHex }).additions,
    );
    const writtenKeys = written.map((line) => parseDevVariableLine(line)?.key).filter((key): key is string => key !== undefined);

    // A concurrent writer may have landed every missing key between our plan and
    // the CAS append, leaving nothing for us to write. Report that as an
    // unchanged file rather than logging a dangling "added ." line.
    if (writtenKeys.length === 0) {
        return { addedKeys: [], generatedKeys: [], status: "exists" };
    }

    const writtenGeneratedKeys = augment.generatedKeys.filter((key) => writtenKeys.includes(key));

    deps.info(`Updated ${DEV_VARS_FILE} — added ${writtenKeys.join(", ")}${generatedSuffix(writtenGeneratedKeys)}.`);

    return { addedKeys: writtenKeys, generatedKeys: writtenGeneratedKeys, status: "augmented" };
};

// ─────────────────────────────────────────────────────────────────────────────
// Package-aware .dev.vars.example scaffolding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The block of text that represents a single {@link SecretEntry} in a
 * `.dev.vars.example` file: a comment block (description + docs URL) followed
 * by the `KEY="<placeholder>"` assignment.
 *
 * Written through the dev-variables-format grammar so the format stays
 * consistent with every other reader/writer. The value is always a placeholder
 * — this function never writes a real secret.
 */
const secretEntryBlock = (entry: SecretEntry): string => {
    const lines: string[] = [`# ${entry.description}`, `# Docs: ${entry.docsUrl}`, `${entry.key}="${entry.placeholderValue}"`];

    return lines.join("\n");
};

/**
 * Build the text that should be merged into `.dev.vars.example` for the given
 * set of package names. Only entries whose key is not already present in
 * `existingKeys` are included (additive / idempotent). Returns an empty string
 * when there is nothing to add.
 *
 * The output is grouped by package with a blank-line separator so the file
 * reads cleanly when multiple packages each contribute several keys.
 *
 * **Safety invariant:** this function never writes a real secret — every value
 * in the output is the entry's `placeholderValue`.
 */
const buildPackageSecretsBlock = (packageNames: ReadonlyArray<string>, existingKeys: ReadonlySet<string>): string => {
    const entries = requiredSecrets(packageNames).filter((entry) => !existingKeys.has(entry.key));

    if (entries.length === 0) {
        return "";
    }

    return entries.map((entry) => secretEntryBlock(entry)).join("\n\n");
};

/**
 * Write (or update) `.dev.vars.example` so that it contains the secrets
 * required by `packageNames`. Existing lines are never removed or rewritten;
 * new entries are appended (with a blank-line separator after existing content).
 *
 * Idempotent: re-running with the same `packageNames` does not duplicate keys
 * already in the file. Returns the list of keys that were actually appended.
 *
 * **Safety invariant:** only placeholder values are written — no real secrets.
 */
const ensureDevVariablesExample = (cwd: string, packageNames: ReadonlyArray<string>): string[] => {
    const examplePath = join(cwd, DEV_VARS_EXAMPLE_FILE);
    const existing = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
    const existingKeys = new Set(parseDevVariableEntries(existing).map((entry) => entry.key));

    const block = buildPackageSecretsBlock(packageNames, existingKeys);

    if (block === "") {
        return [];
    }

    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

    // `.dev.vars.example` is committed and public — no need for 0o600.
    atomicWrite(examplePath, `${existing}${separator}\n${block}\n`);

    // Return the keys we actually added.
    return requiredSecrets(packageNames)
        .filter((entry) => !existingKeys.has(entry.key))
        .map((entry) => entry.key);
};

interface DevSecretsFillPlan {
    /** {@link CORE_SECRETS} keys appended because they were absent (each generated). */
    addedKeys: string[];
    /** The full new file content to write. */
    content: string;
    /** Existing empty/placeholder secret-keyed entries filled with fresh values. */
    filledKeys: string[];
}

/**
 * Plan the in-place generation of dev secrets for a `.dev.vars`. First, every
 * line whose key is {@link isMintableSecretKey mintable} — registry membership,
 * NOT the key's name shape — and whose value is empty or a placeholder gets a
 * freshly generated value, so a `lunora add`-scaffolded `.dev.vars` (which
 * writes each secret blank) becomes usable on `lunora dev` / `vite dev` without
 * the user running `openssl` by hand. A provider-issued key (`OPENAI_API_KEY`,
 * `STRIPE_SECRET_KEY`) is left verbatim so `lunora env doctor` can still report
 * it as unfilled. Second, any {@link CORE_SECRETS} key absent from
 * the file is appended (generated) — notably `LUNORA_ADMIN_TOKEN`, which the
 * local Studio needs to call the worker's admin gate in dev (without it the
 * Studio shows its login gate).
 *
 * Pure (given `randomHex`): real (non-placeholder) values are never touched, and
 * comments + non-secret entries are preserved verbatim.
 */
const planDevSecretsFill = (input: { existingContent: string; randomHex?: (bytes: number) => string }): DevSecretsFillPlan => {
    const randomHex = input.randomHex ?? defaultRandomHex;
    const filledKeys: string[] = [];

    // 1. Fill empty/placeholder secret-keyed values in place.
    const lines = fillSecretLines(input.existingContent, randomHex, filledKeys);

    // 2. Append any missing core secret (a present-but-empty one is already
    //    handled by the fill pass — every CORE_SECRETS key is secret-named).
    const present = new Set(parseDevVariableEntries(input.existingContent).map((entry) => entry.key));
    const addedKeys: string[] = [];
    const additions: string[] = [];

    for (const entry of CORE_SECRETS) {
        if (present.has(entry.key)) {
            continue;
        }

        addedKeys.push(entry.key);
        additions.push(`# ${entry.description}`, `${entry.key}="${randomHex(SECRET_BYTES)}"`);
    }

    const body = lines.join("\n");

    if (additions.length === 0) {
        return { addedKeys, content: body, filledKeys };
    }

    const separator = body === "" || body.endsWith("\n") ? "" : "\n";

    return { addedKeys, content: `${body}${separator}${additions.join("\n")}\n`, filledKeys };
};

interface FillDevSecretsResult {
    /** Core secret keys appended (generated) because they were missing. */
    addedKeys: string[];
    /** Existing empty/placeholder secrets filled with generated values. */
    filledKeys: string[];
    /** `created` = no `.dev.vars` existed; `filled` = topped up an existing one; `unchanged` = nothing to do. */
    status: "created" | "filled" | "unchanged";
}

/**
 * Generate any missing/empty dev secrets in the project's `.dev.vars`, in place.
 *
 * Complements {@link ensureDevVariables} (which scaffolds `.dev.vars` from
 * `.dev.vars.example`). A `lunora add`-scaffolded project writes secrets blank
 * straight into `.dev.vars` (no example) and never includes `LUNORA_ADMIN_TOKEN`
 * — so the worker boots with empty secrets and the Studio shows its login gate.
 * This fills those gaps at dev startup, so both `lunora dev` and the
 * `@lunora/vite` dev server give a working project with zero manual `openssl`.
 *
 * Never overwrites a real (non-placeholder) value. The write is atomic + owner-
 * only (temp + rename, `mode: 0o600`), matching the other `.dev.vars` writers.
 */
const fillDevSecrets = (deps: { cwd: string; info?: (message: string) => void; randomHex?: (bytes: number) => string }): FillDevSecretsResult => {
    const devVariablesPath = join(deps.cwd, DEV_VARS_FILE);
    const exists = existsSync(devVariablesPath);
    const existingContent = exists ? readFileSync(devVariablesPath, "utf8") : "";

    const plan = planDevSecretsFill({ existingContent, randomHex: deps.randomHex });

    if (plan.filledKeys.length === 0 && plan.addedKeys.length === 0) {
        return { addedKeys: [], filledKeys: [], status: "unchanged" };
    }

    atomicWrite(devVariablesPath, plan.content, { mode: 0o600 });

    const generated = [...plan.filledKeys, ...plan.addedKeys];

    deps.info?.(`Generated ${String(generated.length)} dev secret(s) in ${DEV_VARS_FILE}: ${generated.join(", ")}`);

    return { addedKeys: plan.addedKeys, filledKeys: plan.filledKeys, status: exists ? "filled" : "created" };
};

export type { AugmentPlan, DevSecretsFillPlan, EnsureDevVariablesDeps, EnsureDevVariablesResult, EnsureDevVariablesStatus, FillDevSecretsResult, ScaffoldPlan };
export {
    buildPackageSecretsBlock,
    ensureDevVariables,
    ensureDevVariablesExample as ensureDevVarsExample,
    fillDevSecrets,
    generateSecretValue,
    isMintableSecretKey,
    isPlaceholderValue,
    planDevSecretsFill,
    planDevVariablesAugment,
    planDevVariablesScaffold,
    requiredSecrets,
    writeDevVariablesFileAtomically,
};
