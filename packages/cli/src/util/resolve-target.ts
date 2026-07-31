/**
 * Resolve the live-worker target URL a command should hit.
 *
 * Commands that talk to a deployed worker (`run`, `logs`, `deploy --migrate`,
 * `insights`, `export`, …) historically required `--url` on every invocation.
 * This centralizes the precedence so they can fall back to the
 * `.lunora/project.json` link written by `lunora link`.
 *
 * workerUrl precedence: the `--url` flag, then the link's `workerUrl`, then the
 * caller's own default (usually localhost).
 *
 * The admin token is intentionally NOT read from the link file — links carry
 * only public identifiers, never secrets.
 */
import { readLinkedProject } from "@lunora/config";

interface ResolveWorkerUrlInputs {
    cwd: string;
    /** The `--env &lt;name>` the caller is targeting, when scoped. `undefined` means top-level (no `--env`). */
    env?: string;
    /** Explicit `--url` flag value, when the caller passed one. */
    url?: string;
}

/**
 * Resolve the worker URL: the explicit `--url` flag wins, else the linked
 * project's `workerUrl` — but ONLY when the link was recorded for the SAME
 * environment the caller is targeting now. `lunora link` writes `env` for the
 * environment it was run against (`undefined` for the top-level config); a link
 * scoped to `production` must never stand in for a `--env staging` command (or
 * vice versa) — that would run e.g. a data migration meant for staging against
 * the production worker's URL. When the environments don't match, this returns
 * `undefined` so the caller keeps its own default (typically
 * `http://localhost:8787`, or — for `--migrate` — a hard refusal demanding
 * `--migrate-url`).
 */
const resolveWorkerUrl = ({ cwd, env, url }: ResolveWorkerUrlInputs): string | undefined => {
    if (url !== undefined && url !== "") {
        return url;
    }

    const link = readLinkedProject(cwd);

    if (link === undefined || link.env !== env) {
        return undefined;
    }

    return link.workerUrl;
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
 * is used ONLY when `--prod` is set AND the link was recorded for production
 * (`env` unset, or explicitly `"production"`). Without `--prod` (and without
 * `--url`) this returns `undefined` so the caller keeps defaulting to
 * localhost — a prod link never silently becomes the target of an unguarded
 * write/export.
 *
 * Same bug class as {@link resolveWorkerUrl}'s environment guard: a link
 * scoped to a non-production environment (`lunora link --env staging`) is not
 * a production link, so `--prod` must not silently borrow its URL.
 */
const resolveProductionWorkerUrl = ({ cwd, prod, url }: ResolveProductionWorkerUrlInputs): string | undefined => {
    if (url !== undefined && url !== "") {
        return url;
    }

    if (!prod) {
        return undefined;
    }

    const link = readLinkedProject(cwd);

    if (link === undefined || (link.env !== undefined && link.env !== "production")) {
        return undefined;
    }

    return link.workerUrl;
};

export type { ResolveProductionWorkerUrlInputs, ResolveWorkerUrlInputs };
export { resolveProductionWorkerUrl, resolveWorkerUrl };
