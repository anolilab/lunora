/**
 * The temp wrangler configs `lunora dev` writes, and the one rule that decides
 * when they drop the `ai` binding.
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
import { readdirSync, rmSync, writeFileSync } from "node:fs";

import join from "../path";

/** Which kind of temp config a file is, in its name. */
type DevConfigKind = "dev" | "service";

/**
 * Matches the names {@link devConfigBasename} produces. The sweep uses it to find
 * files a dead session left behind, and `.gitignore` covers the same pattern.
 */
const STALE_DEV_CONFIG: RegExp = /^\.wrangler\.lunora-(?:dev|service)\.(\d+)\.\d+\.jsonc$/;

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
 * Write a temp config into `directory` and return where it is and how to remove it.
 * The directory is swept of dead sessions' files first.
 */
const writeDevConfig = (directory: string, kind: DevConfigKind, contents: string): { cleanup: () => void; configPath: string } => {
    sweepStaleDevConfigs(directory);

    const configPath = join(directory, devConfigBasename(kind));

    writeFileSync(configPath, contents, "utf8");

    return { cleanup: createCleanup(configPath), configPath };
};

/**
 * The binding name to withhold from a logged-out dev session, or `undefined` to keep
 * it. The credential probe runs only when an `ai` binding is declared at all.
 */
const withheldWorkersAi = (ai: { binding?: string } | null | undefined, hasCredentials: () => boolean): string | undefined => {
    if (ai === undefined || ai === null || hasCredentials()) {
        return undefined;
    }

    return typeof ai.binding === "string" ? ai.binding : "AI";
};

/** The one dev warning for a withheld Workers AI binding, shared by `lunora dev` and `@lunora/vite`. */
const describeWithheldWorkersAi = (binding: string): string =>
    `Workers AI is off in this dev session (${binding} binding left out): no Cloudflare login found, and Workers AI only runs remotely. ` +
    "`@cf/…` models will throw; AI SDK models and `LUNORA_AI_PROXY_URL` slugs still work. Run `wrangler login` or set CLOUDFLARE_API_TOKEN to turn it on.";

export type { DevConfigKind };
export { createCleanup, describeWithheldWorkersAi, devConfigBasename, noopCleanup, STALE_DEV_CONFIG, sweepStaleDevConfigs, withheldWorkersAi, writeDevConfig };
