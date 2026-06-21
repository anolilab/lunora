/**
 * Resolve the live-worker target (URL + admin token) a command should hit.
 *
 * Commands that talk to a deployed worker (`run`, `logs`, `deploy --migrate`,
 * `insights`, `export`, …) historically required `--url`/`--token` on every
 * invocation. This centralizes the precedence so they can fall back to the
 * `.lunora/project.json` link written by `lunora link`.
 *
 * workerUrl precedence: the `--url` flag, then the link's `workerUrl`, then the
 * caller's own default (usually localhost). adminToken precedence: the `--token`
 * flag, then the `LUNORA_ADMIN_TOKEN` env.
 *
 * The admin token is intentionally NOT read from the link file — links carry
 * only public identifiers, never secrets.
 */
import { readLinkedProject } from "@lunora/config";

interface ResolveWorkerUrlInputs {
    cwd: string;
    /** Explicit `--url` flag value, when the caller passed one. */
    url?: string;
}

/**
 * Resolve the worker URL: the explicit `--url` flag wins, else the linked
 * project's `workerUrl`, else `undefined` (the caller supplies its own default,
 * typically `http://localhost:8787`).
 */
const resolveWorkerUrl = ({ cwd, url }: ResolveWorkerUrlInputs): string | undefined => {
    if (url !== undefined && url !== "") {
        return url;
    }

    return readLinkedProject(cwd)?.workerUrl;
};

interface ResolveProductionWorkerUrlInputs {
    cwd: string;
    /** Whether the caller passed `--prod`. */
    prod?: boolean;
    /** Explicit `--url` flag value, when the caller passed one. */
    url?: string;
}

/**
 * Resolve the worker URL for a bulk/destructive command gated by `--prod`. The
 * explicit `--url` flag always wins; otherwise the linked project's `workerUrl`
 * is used ONLY when `--prod` is set. Without `--prod` (and without `--url`) this
 * returns `undefined` so the caller keeps defaulting to localhost — a prod link
 * never silently becomes the target of an unguarded write/export.
 */
const resolveProductionWorkerUrl = ({ cwd, prod, url }: ResolveProductionWorkerUrlInputs): string | undefined => {
    if (url !== undefined && url !== "") {
        return url;
    }

    return prod ? readLinkedProject(cwd)?.workerUrl : undefined;
};

/**
 * Resolve the admin bearer token: the explicit `--token` flag wins, else the
 * `LUNORA_ADMIN_TOKEN` env (preferred — it never lands in the process table).
 * Returns `undefined` when neither is set.
 */
const resolveAdminToken = (token: string | undefined): string | undefined => {
    if (token !== undefined && token !== "") {
        return token;
    }

    const fromEnv = process.env.LUNORA_ADMIN_TOKEN;

    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
};

export type { ResolveProductionWorkerUrlInputs, ResolveWorkerUrlInputs };
export { resolveAdminToken, resolveProductionWorkerUrl, resolveWorkerUrl };
