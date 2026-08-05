/**
 * The `/_lunora/admin/workflows*` route cluster — the studio's window onto
 * Cloudflare **Workflows** execution state (plan 055 §3a). The Worker `Workflow`
 * binding can only `create`/`get` an instance and read its top-level status; the
 * instance **list** and per-**step** detail live only in Cloudflare's control
 * plane and are reachable over the account-scoped Workflows REST API. These
 * routes proxy that API behind the admin-token gate so the secret stays
 * server-side and the studio never holds a Cloudflare token.
 *
 * Mirrors `./scheduled-admin-routes`: every handler is closure-free of the
 * worker's internals — it reaches the admin gate and the REST client through the
 * injected {@link WorkflowsAdminRouteDeps}. The concrete client is built
 * **outside** this package (in the codegen-emitted worker entry) and injected via
 * `resolveWorkflowsClient`. `@lunora/workflow` is a **type-only devDependency**
 * here: its types are bundled into the build by packem and the devDep is stripped
 * on release, so the published `@lunora/runtime` carries no `@lunora/workflow`
 * runtime dependency (the same treatment `@lunora/do` already gets).
 *
 * Routes dispatch by exact pathname (the worker's internal table is a flat map,
 * not a param router), so the instance id / workflow name / filters arrive as
 * query (GET) or body (POST) params rather than path segments.
 */
import type { WorkflowInstanceStatus, WorkflowsRestClient } from "@lunora/workflow";

import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";

const WORKFLOWS_INSTANCES_PATH = "/_lunora/admin/workflows/instances";
const WORKFLOWS_INSTANCE_PATH = "/_lunora/admin/workflows/instance";
const WORKFLOWS_STATUS_PATH = "/_lunora/admin/workflows/status";

/**
 * The instance-status union as an exhaustive lookup, for validating the
 * untrusted `status` filter query param. The `satisfies` assertion makes this a
 * **compile error** if `@lunora/workflow`'s status union gains a member that
 * isn't listed here — so this local copy (the package is a type-only devDep, so
 * the value can't be imported) can never silently drift from the union.
 */
const INSTANCE_STATUSES = {
    complete: true,
    errored: true,
    paused: true,
    queued: true,
    running: true,
    terminated: true,
    unknown: true,
    waiting: true,
    waitingForPause: true,
} satisfies Record<WorkflowInstanceStatus, true>;

/** Coerce an untrusted `status` query value to the union, or `undefined` when absent/unrecognized. */
const toInstanceStatus = (value: null | string): undefined | WorkflowInstanceStatus =>
    value !== null && Object.hasOwn(INSTANCE_STATUSES, value) ? (value as WorkflowInstanceStatus) : undefined;

/** The worker internals the workflows routes reach through injection rather than closure. */
interface WorkflowsAdminRouteDeps {
    /** Admin-gate the request (throws `ADMIN_FORBIDDEN` when unauthorized). */
    assertAdmin: (request: Request) => void;

    /**
     * Build the Workflows REST client from the deployment `env`, or return
     * `undefined` when its `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` are
     * unset — the studio then shows a "configure credentials" empty state while
     * the workflows themselves keep running.
     */
    resolveWorkflowsClient: (env: unknown) => undefined | WorkflowsRestClient;
}

/** A positive integer query param, or `undefined` when absent/invalid. */
const positiveIntParameter = (url: URL, key: string): number | undefined => {
    const raw = url.searchParams.get(key);

    if (raw === null) {
        return undefined;
    }

    const value = Number(raw);

    return Number.isInteger(value) && value > 0 ? value : undefined;
};

/** Require a non-empty string `key` from the query string, else a 400. */
const requireQuery = (url: URL, key: string): string => {
    const value = url.searchParams.get(key);

    if (value === null || value === "") {
        throw new LunoraError(`Workflows admin endpoint requires a \`${key}\` query parameter`, { code: "BAD_REQUEST", status: 400 });
    }

    return value;
};

/**
 * Throw the 501 used when no Cloudflare credentials are configured. Raised as a
 * {@link LunoraError} so it serializes through the worker's standard
 * `{ error: { code, message } }` envelope — the client surfaces `.code`. Used by
 * the detail/status endpoints only; those are reachable solely once instances
 * exist, so they never fire while unconfigured. The instances *list* — the one
 * endpoint the studio fetches on mount — instead answers a 200 `configured:
 * false` sentinel (see `handleInstances`) so the studio renders its "set
 * credentials" state without the browser logging a failed request.
 */
const throwNotConfigured = (): never => {
    throw new LunoraError("Workflow inspection is unconfigured. Set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in your .dev.vars to enable it.", {
        code: "WORKFLOWS_NOT_CONFIGURED",
        status: 501,
    });
};

/** Build the `/_lunora/admin/workflows*` route map merged into the worker's internal route table. */
const buildWorkflowsAdminRoutes = (
    deps: WorkflowsAdminRouteDeps,
): Record<string, (request: Request, env: unknown, url: URL) => Promise<Response> | Response> => {
    const { assertAdmin, resolveWorkflowsClient } = deps;

    const handleInstances = async (request: Request, env: unknown, url: URL): Promise<Response> => {
        assertMethod(request, "GET", "Workflows instances");

        assertAdmin(request);
        const client = resolveWorkflowsClient(env);

        // The instance list is the one workflows endpoint the studio fetches
        // automatically on mount, so an unconfigured worker would log a 501 to
        // the console on every visit. Mirror the OpenAPI/OpenRPC introspection
        // routes instead: return a 200 `configured: false` sentinel (an empty
        // page) so the studio renders its "set credentials" state without the
        // browser surfacing a failed request. The detail/status endpoints keep
        // throwing `WORKFLOWS_NOT_CONFIGURED` — they're only reachable once
        // instances exist, so they never fire while unconfigured.
        if (!client) {
            return Response.json({ configured: false, instances: [], page: 1, perPage: 0, totalCount: 0 });
        }

        const workflowName = requireQuery(url, "name");
        const status = toInstanceStatus(url.searchParams.get("status"));

        return Response.json(
            await client.listInstances({
                page: positiveIntParameter(url, "page"),
                perPage: positiveIntParameter(url, "perPage"),
                status,
                workflowName,
            }),
        );
    };

    const handleInstance = async (request: Request, env: unknown, url: URL): Promise<Response> => {
        assertMethod(request, "GET", "Workflows instance");

        assertAdmin(request);
        const client = resolveWorkflowsClient(env);

        if (!client) {
            return throwNotConfigured();
        }

        return Response.json(await client.getInstance({ instanceId: requireQuery(url, "id"), workflowName: requireQuery(url, "name") }));
    };

    const handleStatus = async (request: Request, env: unknown): Promise<Response> => {
        assertMethod(request, "POST", "Workflows status");

        assertAdmin(request);
        const client = resolveWorkflowsClient(env);

        if (!client) {
            return throwNotConfigured();
        }

        const body = (await request.json().catch(() => undefined)) as { action?: unknown; id?: unknown; name?: unknown } | undefined;

        if (typeof body?.name !== "string" || body.name === "" || typeof body.id !== "string" || body.id === "") {
            throw new LunoraError("Workflows status action requires string `name` and `id`", { code: "BAD_REQUEST", status: 400 });
        }

        const { action } = body;

        if (action !== "pause" && action !== "resume" && action !== "terminate") {
            throw new LunoraError("Workflows status action must be one of: pause, resume, terminate", { code: "BAD_REQUEST", status: 400 });
        }

        return Response.json(await client.setInstanceStatus({ action, instanceId: body.id, workflowName: body.name }));
    };

    return {
        [WORKFLOWS_INSTANCE_PATH]: handleInstance,
        [WORKFLOWS_INSTANCES_PATH]: handleInstances,
        [WORKFLOWS_STATUS_PATH]: handleStatus,
    };
};

export type { WorkflowsRestClient } from "@lunora/workflow";
export type { WorkflowsAdminRouteDeps };
export { buildWorkflowsAdminRoutes, WORKFLOWS_INSTANCE_PATH, WORKFLOWS_INSTANCES_PATH, WORKFLOWS_STATUS_PATH };
