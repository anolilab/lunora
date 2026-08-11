#!/usr/bin/env node
/**
 * `Stop` hook — turn the "run `lunora verify` before you call it done" rule into
 * a mechanism instead of an instruction.
 *
 * The skills already say to verify. Agents skip it, and the failure mode is
 * quiet: the turn ends, the user reads a confident summary, and the type error
 * surfaces on their next `lunora dev`. This hook re-runs the check at turn end
 * and, when it fails, blocks the stop with the compiler's own output so the
 * next turn starts from the real errors rather than from a re-description.
 *
 * `lunora verify` is the whole gate in one command: wrangler config validation,
 * a codegen dry-run (so `lunora/_generated/` staleness is caught, not inherited)
 * and `tsc --noEmit`.
 *
 * Four guards keep it from becoming a nag:
 *
 * 1. **Not a Lunora project** — a `lunora/` directory NEXT TO a wrangler config,
 *    the same pair `lunora mcp install` treats as the marker. The directory
 *    alone is not enough: this repo alone has a `packages/lunora`, a `lunora`
 *    under four of the SDKs and one under every template, and a developer with
 *    a `lunora` checkout beside their other projects would otherwise turn every
 *    unrelated repo into a Lunora one.
 * 2. **Nothing changed under `lunora/`** — the working tree is clean there, so
 *    whatever the turn did, it didn't touch the backend. Skipped without paying
 *    for a `tsc` run. Non-git projects verify unconditionally.
 * 3. **`stop_hook_active`** — Claude Code sets this once it is already
 *    continuing because of a stop hook, which is the documented way to avoid
 *    blocking forever. It also caps a hook at 8 consecutive blocks on its own,
 *    so there is no counter to keep here.
 * 4. **No project-local `lunora`** — an environment fact, not a type error.
 *
 * Contract: stdin is the hook event JSON, stdout is the hook result JSON.
 * Anything unexpected exits 0 with `{}` — a broken hook must never wedge a
 * session.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** How much of the verify output to hand back. Enough for a real error list, not the whole log. */
const MAX_REASON_CHARS = 2000;

/** Directories to walk up while looking for the project root. */
const MAX_WALK_UP = 8;

/** Candidate wrangler config filenames, mirroring `WRANGLER_FILES` in `@lunora/config`. */
const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json"];

/** A `lunora/` directory next to a wrangler config — the marker `lunora mcp install` uses. */
const isLunoraProject = (directory, exists) => exists(join(directory, "lunora")) && WRANGLER_FILES.some((name) => exists(join(directory, name)));

/**
 * Nearest ancestor of `startDirectory` (inclusive) that looks like a Lunora
 * project — the root `lunora verify` needs to run from. `undefined` when there
 * is none, which is the "not a Lunora project" exit.
 *
 * The walk stops at a `.git` directory. Without that boundary it escapes the
 * repository entirely and can select a sibling checkout's parent as "the
 * project root".
 */
const findProjectRoot = (startDirectory, exists = existsSync) => {
    let directory = startDirectory;

    for (let index = 0; index < MAX_WALK_UP; index += 1) {
        if (isLunoraProject(directory, exists)) {
            return directory;
        }

        const parent = dirname(directory);

        if (parent === directory || exists(join(directory, ".git"))) {
            return undefined;
        }

        directory = parent;
    }

    return undefined;
};

/**
 * Whether the turn plausibly touched the backend.
 *
 * `git status --porcelain -- lunora` empty means the backend is committed as-is,
 * so a `tsc` run would only re-prove what the pre-commit gate already proved.
 * A git failure (no repo, no git binary) returns `true`: verifying is the safe
 * answer when we cannot tell.
 */
const backendIsDirty = (root, run = spawnSync) => {
    const result = run("git", ["status", "--porcelain", "--", "lunora"], { cwd: root, encoding: "utf8" });

    if (result.error !== undefined || result.status !== 0) {
        return true;
    }

    return result.stdout.trim().length > 0;
};

/**
 * The project's own `lunora` binary, walking up for a hoisted `node_modules` in
 * a monorepo. `undefined` means `@lunora/cli` isn't a dependency here.
 *
 * Deliberately not `npx`: `npx -y @lunora/cli` resolves the `latest` dist-tag,
 * which for this package is an empty `0.0.0` placeholder with no `bin` at all,
 * and `npx --no-install lunora` still round-trips to the registry for a package
 * name that does not exist there. Both fail on every turn end.
 */
const findLunoraBin = (root, exists = existsSync) => {
    let directory = root;

    for (let index = 0; index < MAX_WALK_UP; index += 1) {
        for (const name of ["lunora", "lunora.cmd"]) {
            const binary = join(directory, "node_modules", ".bin", name);

            if (exists(binary)) {
                return binary;
            }
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }

    return undefined;
};

/**
 * `shell: true` for the Windows `.cmd` shim only. Node refuses to spawn a
 * `.cmd`/`.bat` without a shell (the CVE-2024-27980 hardening), so the Windows
 * branch of {@link findLunoraBin} would otherwise resolve a binary the hook can
 * never execute — a gate that silently never runs. `binary` is a path we built
 * ourselves from `node_modules/.bin`, not anything from the event payload.
 */
const runVerify = (binary, root) => spawnSync(binary, ["verify"], { cwd: root, encoding: "utf8", shell: binary.endsWith(".cmd"), timeout: 170_000 });

/**
 * Turn a verify result into a hook decision. Split out from the I/O so the
 * block and pass branches are testable without spawning anything.
 *
 * The reason takes the TAIL of the output: `lunora verify` streams wrangler and
 * codegen progress first and prints its `verify: errors:` summary last, so the
 * head is the noise and the tail is the answer.
 */
const decide = ({ output, status }) => {
    if (status === 0) {
        return { block: false };
    }

    return {
        block: true,
        reason:
            "`lunora verify` failed after that turn (wrangler config + codegen dry-run + `tsc --noEmit`). " +
            "Fix the errors below, re-run `lunora verify` until it is clean, then finish. " +
            "If an error pre-dates this turn and is out of scope, say so to the user rather than silently leaving it:\n\n" +
            output.trim().slice(-MAX_REASON_CHARS),
    };
};

const readStdin = async () => {
    const chunks = [];

    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
    let event = {};

    try {
        event = JSON.parse(await readStdin());
    } catch {
        return {};
    }

    // Plan mode writes nothing, and `stop_hook_active` means we already blocked
    // once and Claude Code is continuing because of it.
    if (event.permission_mode === "plan" || event.stop_hook_active === true) {
        return {};
    }

    const root = findProjectRoot(event.cwd ?? process.cwd());

    if (root === undefined || !backendIsDirty(root)) {
        return {};
    }

    const binary = findLunoraBin(root);

    if (binary === undefined) {
        return {};
    }

    const result = runVerify(binary, root);

    // A timed-out or un-spawnable verify proves nothing either way. Say so
    // instead of returning a bare `{}`, which reads as "checked, and it passed".
    if (result.error !== undefined) {
        return { systemMessage: `lunora verify could not run (${result.error.message}) — the backend was NOT type-checked this turn.` };
    }

    const decision = decide({ output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status });

    return decision.block ? { decision: "block", reason: decision.reason } : {};
};

// Only when executed directly — the test file imports the helpers above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.stdout.write(`${JSON.stringify(await main())}\n`);
    } catch {
        process.stdout.write("{}\n");
    }
}

export { backendIsDirty, decide, findLunoraBin, findProjectRoot };
