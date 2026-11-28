/**
 * The temp wrangler configs `lunora dev` writes, and the one rule that decides
 * when they drop the `ai` and `artifacts` bindings.
 *
 * Importing `@lunora/ai` makes the binding reconcile write `"ai"` into
 * `wrangler.jsonc`. Workers AI has no local emulation, so `wrangler dev` and the
 * Cloudflare Vite plugin open a remote proxy session for it at boot. Without a
 * Cloudflare login that session fails and takes the dev server down, even for an
 * app whose models come from `LUNORA_AI_PROXY_URL` or an AI SDK provider. So a
 * logged-out session runs without the binding, and `ctx.ai` throws a directed
 * error only when something asks for a Workers AI model.
 *
 * The CLI path has to write a file beside `wrangler.jsonc`, because wrangler reads
 * its config from disk and resolves relative `main`/`assets` paths against the
 * config's own directory. The Vite path edits the config in memory instead.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import ensureGitignoreEntries from "../ensure-gitignore";
import isWithinDirectory from "../is-within-directory";
import join from "../path";

/** Which kind of temp config a file is, in its name. */
type DevConfigKind = "dev" | "service";

/**
 * Matches the names {@link devConfigBasename} produces. The sweep uses it to find
 * files a dead session left behind; {@link DEV_CONFIG_IGNORE} is the same set as a
 * `.gitignore` line.
 */
const STALE_DEV_CONFIG: RegExp = /^\.wrangler\.lunora-(?:dev|service)\.(\d+)\.\d+\.jsonc$/;

/** The `.gitignore` line covering every temp config. No slash, so it matches at any depth below the file. */
const DEV_CONFIG_IGNORE = ".wrangler.lunora-*.jsonc";

let generation = 0;

/**
 * A temp config name unique within the process. A pid alone is not enough: Vite's
 * `restartServer` resolves the new config before it closes the old server, so two
 * generations can coexist in one process.
 */
const devConfigBasename = (kind: DevConfigKind): string => {
    generation += 1;

    return `.wrangler.lunora-${kind}.${String(process.pid)}.${String(generation)}.jsonc`;
};

/** Whether a process id is still running. `EPERM` means it exists but belongs to someone else. */
const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

/**
 * Remove temp configs left behind by dev sessions that died without running their
 * cleanup (a SIGKILL or crash). Only files whose owning pid is gone are removed,
 * so a second live `lunora dev` in the same directory keeps its own file.
 */
const sweepStaleDevConfigs = (directory: string): void => {
    let names: string[];

    try {
        names = readdirSync(directory);
    } catch {
        return;
    }

    for (const name of names) {
        const match = STALE_DEV_CONFIG.exec(name);

        if (match === null || Number(match[1]) === process.pid || isProcessAlive(Number(match[1]))) {
            continue;
        }

        try {
            rmSync(join(directory, name), { force: true });
        } catch {
            // Another session may have removed it first, or it is not ours to delete.
        }
    }
};

/** A disposer that does nothing, for the fall-through cases where no file was written. */
const noopCleanup = (): void => {};

/**
 * An idempotent disposer that removes one temp config. Guards against a double call
 * (the flag) and a missing path (`force` + try/catch), so the dev command can wire
 * it onto several exit paths without a shutdown ever throwing.
 */
const createCleanup = (path: string): (() => void) => {
    let done = false;

    return () => {
        if (done) {
            return;
        }

        done = true;

        try {
            rmSync(path, { force: true });
        } catch {
            // Already gone, or a permission problem we can't act on during shutdown.
        }
    };
};

/**
 * Make git ignore a temp config before it exists. A service folder is often a
 * subdirectory the project's `.gitignore` was never written for, and a file there
 * shows up as an untracked change for the whole session.
 *
 * Git answers, not a text match on one `.gitignore`: a parent's pattern, a global
 * excludes file or `.git/info/exclude` already covering the path must not make
 * this append a line to a tracked file. The line goes into the project's
 * `.gitignore` when the folder is inside the project (the pattern has no slash,
 * so it reaches subfolders), else into the folder's own. Outside a repository
 * (`check-ignore` exits 128) or without git, nothing is written.
 */
const ensureDevConfigIgnored = (configPath: string, projectRoot: string): void => {
    const directory = dirname(configPath);

    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell
        const { status } = spawnSync("git", ["check-ignore", "-q", "--no-index", configPath], { cwd: directory, stdio: "ignore", timeout: 5000 });

        if (status !== 1) {
            return;
        }

        ensureGitignoreEntries(directory === projectRoot || isWithinDirectory(directory, projectRoot) ? projectRoot : directory, [DEV_CONFIG_IGNORE]);
    } catch {
        // An unignored temp file is noise in `git status`, never a reason to fail dev startup.
    }
};

/**
 * Write a temp config into `directory` and return where it is and how to remove it.
 * The directory is swept of dead sessions' files first, and git is made to ignore
 * the file (see {@link ensureDevConfigIgnored}).
 * @param directory Where the copy goes; wrangler resolves its relative paths against it.
 * @param kind Which temp config this is, in its name.
 * @param contents The config text.
 * @param projectRoot The app's folder, whose `.gitignore` takes the ignore line when `directory` is inside it.
 */
const writeDevConfig = (directory: string, kind: DevConfigKind, contents: string, projectRoot: string): { cleanup: () => void; configPath: string } => {
    sweepStaleDevConfigs(directory);

    const configPath = join(directory, devConfigBasename(kind));

    ensureDevConfigIgnored(configPath, projectRoot);

    writeFileSync(configPath, contents, "utf8");

    return { cleanup: createCleanup(configPath), configPath };
};

/** A remote-only binding a logged-out dev session leaves out: which kind it is, and the name the app gave it. */
interface WithheldBinding {
    binding: string;
    kind: "ai" | "artifacts";
}

/** The slice of a worker config the rule reads. */
interface RemoteOnlyBindings {
    ai?: { binding?: string } | null;
    artifacts?: ReadonlyArray<{ binding?: string } | null | undefined> | null;
}

/**
 * The bindings to withhold from a logged-out dev session. Workers AI and Artifacts have no
 * local simulator, so each opens a remote proxy session at boot that fails without a login and
 * takes the dev server down. The credential probe runs only when one of them is declared.
 */
const withheldBindings = (config: RemoteOnlyBindings | undefined, hasCredentials: () => boolean): WithheldBinding[] => {
    const ai = config?.ai;
    // A parsed config is untrusted: anything but an array here is the validator's to report, not a crash.
    const declared: unknown = config?.artifacts;
    const artifacts = (Array.isArray(declared) ? (declared as NonNullable<RemoteOnlyBindings["artifacts"]>) : []).flatMap((entry) =>
        typeof entry?.binding === "string" ? [entry.binding] : [],
    );

    if ((ai === undefined || ai === null) && artifacts.length === 0) {
        return [];
    }

    if (hasCredentials()) {
        return [];
    }

    return [
        ...(ai === undefined || ai === null ? [] : [{ binding: typeof ai.binding === "string" ? ai.binding : "AI", kind: "ai" as const }]),
        ...artifacts.map((binding) => {
            return { binding, kind: "artifacts" as const };
        }),
    ];
};

/** The one dev warning for a withheld binding, shared by `lunora dev` and `@lunora/vite`. */
const describeWithheld = ({ binding, kind }: WithheldBinding): string =>
    kind === "ai"
        ? `Workers AI is off in this dev session (${binding} binding left out): no usable Cloudflare login found, and Workers AI only runs remotely. ` +
          "`@cf/…` models will throw; AI SDK models and `LUNORA_AI_PROXY_URL` slugs still work. Run `wrangler login` or set CLOUDFLARE_API_TOKEN to turn it on."
        : `Artifacts is off in this dev session (${binding} binding left out): no usable Cloudflare login found, and Artifacts only runs remotely. ` +
          "`ctx.artifacts` will throw. Run `wrangler login` or set CLOUDFLARE_API_TOKEN to turn it on.";

export type { DevConfigKind, WithheldBinding };
export {
    createCleanup,
    describeWithheld,
    DEV_CONFIG_IGNORE,
    devConfigBasename,
    noopCleanup,
    STALE_DEV_CONFIG,
    sweepStaleDevConfigs,
    withheldBindings,
    writeDevConfig,
};
