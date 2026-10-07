/**
 * The platform's own trust boundary — every route the DISPATCHER Worker calls.
 *
 * These four are the entire surface a tenant request touches indirectly: plan
 * and limit lookup, preview-password verification, custom-hostname resolution,
 * and cell registration. All are bearer-gated with `LUNORA_ADMIN_TOKEN` and none
 * is reachable by a tenant.
 *
 * The gate itself — {@link withAdminToken}, and its inverse
 * {@link refuseAdminToken} — lives here too, but is applied by the router to its
 * admin table rather than called by each handler: these handlers check nothing
 * themselves and are only safe behind that table.
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import type { TargetId } from "../../provision-contract";
import { isTargetId, TARGET_IDS, TARGETS } from "../../provision-contract";
import { constantTimeEqual } from "../../security/constant-time-equal";
import type { RouterEnv } from "./shared";
import { jsonError, otlpBearer, requireContext, strictBearer } from "./shared";

/** Whether `token` is the platform admin token. Fails closed: an unset token matches nothing. */
const isAdminToken = (token: string, environment: RouterEnv): boolean =>
    Boolean(environment.LUNORA_ADMIN_TOKEN) && constantTimeEqual(token, environment.LUNORA_ADMIN_TOKEN ?? "");

type Handler<Rest extends unknown[]> = (request: Request, environment: RouterEnv, ...rest: Rest) => Promise<Response>;

/**
 * The admin table's guard: run `handler` only for a request bearing
 * `LUNORA_ADMIN_TOKEN` (strict `Bearer` form), 401 otherwise.
 *
 * Applied once, by the router, to every route in its admin table — the handlers
 * themselves carry no check. The check used to be copied per handler, and one
 * copy was missing entirely (`handlePreviewAuthRoute` documented the gate and
 * never performed it, leaving an unauthenticated password oracle). A route is
 * now gated by which table it sits in, so a new one cannot forget.
 */
export const withAdminToken =
    <Rest extends unknown[]>(handler: Handler<Rest>): Handler<Rest> =>
    async (request, environment, ...rest) =>
        isAdminToken(strictBearer(request), environment) ? handler(request, environment, ...rest) : jsonError(401, "unauthorized");

/**
 * The inverse guard, applied by the router to every route OUTSIDE the admin
 * table: a request presenting the platform admin token (in either bearer form)
 * is refused with 403 before the handler runs. The admin token is the
 * dispatcher's credential and authorizes the admin table only; it must never
 * be weighed as a deploy key, session or anything else.
 */
export const refuseAdminToken =
    <Rest extends unknown[]>(handler: Handler<Rest>): Handler<Rest> =>
    async (request, environment, ...rest) =>
        isAdminToken(otlpBearer(request) ?? "", environment)
            ? jsonError(403, "the platform admin token does not authorize this route")
            : handler(request, environment, ...rest);

/**
 * `GET /v1/tenants/plan?script=&lt;id>` — resolve a tenant script's plan tier for
 * the dispatcher's per-plan runtime limits (§4). Bearer-gated with
 * `LUNORA_ADMIN_TOKEN` (the dispatcher is a trusted account-level Worker).
 */
export const handleTenantPlanRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const scriptName = new URL(request.url).searchParams.get("script");

    if (!scriptName) {
        return jsonError(400, "script is required");
    }

    const result = await context.runQuery<{ plan: string; protected?: boolean }>(api.deployments.planForScript, { scriptName });

    return Response.json(result);
};

/**
 * `POST /v1/tenants/recursion` — the dispatcher reports a request chain it
 * terminated past the recursion depth cap (plan 365 W5), so it lands in the
 * owning org's audit log. Admin-token gated like the rest of `/v1/tenants/*`.
 * The body names only the script; the org comes from the control plane's rows.
 */
export const handleTenantRecursionRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | { depth?: unknown; scriptName?: unknown };

    if (typeof body?.scriptName !== "string" || body.scriptName === "" || typeof body.depth !== "number") {
        return jsonError(400, "scriptName and depth are required");
    }

    const result = await context.runMutation<{ recorded: boolean }>(internal.edge.recordRecursionStop, { depth: body.depth, scriptName: body.scriptName });

    return Response.json(result);
};

/** The `POST /v1/tenants/preview-auth` body — which preview, and the password being tried. */
interface PreviewAuthBody {
    password?: string;
    scriptName?: string;
}

/**
 * `POST /v1/tenants/preview-auth` — verify a submitted preview password.
 *
 * The dispatcher owns the cookie; the control plane owns the secret. This route
 * is the seam between them: it answers yes or no and nothing else, so the salted
 * hash never reaches the data plane and a compromised dispatcher isolate has
 * nothing it could attack offline.
 *
 * Admin-token gated like the rest of `/v1/tenants/*` — the caller is the
 * platform's own dispatcher, never an end user. An end user's password reaches
 * this only as the body of a request the dispatcher makes on their behalf.
 */
export const handlePreviewAuthRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const body = (await request.json().catch(() => null)) as null | PreviewAuthBody;

    if (!body?.scriptName || !body.password) {
        return jsonError(400, "scriptName and password are required");
    }

    const result = await context.runQuery<{ ok: boolean }>(internal.projects.verifyPreviewPassword, {
        password: body.password,
        scriptName: body.scriptName,
    });

    return Response.json(result);
};

/**
 * `GET /v1/tenants/custom-domain?host=&lt;hostname>` — resolve a verified custom
 * hostname to a redirect or the owning project's active script, for the
 * dispatcher (GAPS.md B1). Bearer-gated with `LUNORA_ADMIN_TOKEN`.
 */
export const handleTenantCustomDomainRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const host = new URL(request.url).searchParams.get("host");

    if (!host) {
        return jsonError(400, "host is required");
    }

    const result = await context.runQuery<null | { redirectStatusCode?: number; redirectTo?: string; scriptName?: string }>(api.domains.routeForHostname, {
        hostname: host,
    });

    return Response.json(result ?? {});
};

/** The targets whose capacity a cell is (`placedOn: "cell"`) — the only ones a cell may be registered for. */
const CELL_TARGETS: ReadonlyArray<TargetId> = TARGET_IDS.filter((id) => TARGETS[id].placedOn === "cell");

/** A cell's `config`: string values only, as the column stores them. */
const isCellConfig = (value: unknown): value is Record<string, string> =>
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");

/**
 * `POST /v1/cells` — register a fleet cell (platform-operator action, §2.5).
 * Bearer-gated with `LUNORA_ADMIN_TOKEN` (the platform trust boundary): cell
 * bring-up IaC holds the token. The delegated mutation is `internal`, so this
 * route is the only path in — a tenant can't inject cells over public RPC.
 *
 * `target` (default `cloudflare-wfp`) must be a target whose projects are
 * placed in a cell; `config` holds that target's own settings (MULTIPLATFORM.md
 * §5.2). There is no `credentialsRef`: the cell's credentials are its control
 * plane's Worker secrets, and the only per-tenant credential — a connected
 * Cloudflare account's token — belongs to the organization, not to a cell.
 */
export const handleCellRegisterRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    let body: { cloudflareAccountId?: unknown; config?: unknown; dispatchNamespacePrefix?: unknown; jurisdiction?: unknown; name?: unknown; target?: unknown };

    try {
        body = await request.json();
    } catch {
        return jsonError(400, "invalid JSON body");
    }

    const { cloudflareAccountId, config, dispatchNamespacePrefix, jurisdiction, name, target } = body;

    if (typeof cloudflareAccountId !== "string" || typeof dispatchNamespacePrefix !== "string" || typeof name !== "string") {
        return jsonError(400, "cloudflareAccountId, dispatchNamespacePrefix, and name are required");
    }

    if (jurisdiction !== undefined && typeof jurisdiction !== "string") {
        return jsonError(400, "jurisdiction must be a string when provided");
    }

    if (target !== undefined && !(isTargetId(target) && CELL_TARGETS.includes(target))) {
        return jsonError(400, `target must be one of the targets placed in a cell: ${CELL_TARGETS.join(", ")}`);
    }

    if (config !== undefined && !isCellConfig(config)) {
        return jsonError(400, "config must be an object of string values when provided");
    }

    const cellId = await context.runMutation<string>(internal.cells.register, {
        cloudflareAccountId,
        ...(config === undefined ? {} : { config }),
        dispatchNamespacePrefix,
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
        name,
        ...(target === undefined ? {} : { target }),
    });

    return Response.json({ cellId }, { status: 201 });
};
