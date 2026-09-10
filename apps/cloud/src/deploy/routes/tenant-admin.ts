/**
 * The platform's own trust boundary — every route the DISPATCHER Worker calls.
 *
 * These five are the entire surface a tenant request touches indirectly: plan
 * and limit lookup, preview-password verification, alias and custom-hostname
 * resolution, and cell registration. All are bearer-gated with
 * `LUNORA_ADMIN_TOKEN` and none is reachable by a tenant — which is exactly why
 * they belong together rather than scattered through a file whose other routes
 * are session- or deploy-key-authorized.
 *
 * `requireAdminToken` lives here with them. It was extracted because the check
 * had been copied per route and one copy was missing entirely — a route that
 * documented the gate and never performed it, leaving an unauthenticated
 * password oracle. Keeping the gate in the same module as everything it gates is
 * what makes a sixth route's omission obvious.
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import { constantTimeEqual } from "../../security/constant-time-equal";
import type { RouterEnv } from "./shared";
import { jsonError, requireContext, strictBearer } from "./shared";

/**
 * Bearer-gate a platform-internal `/v1/tenants/*` route with `LUNORA_ADMIN_TOKEN`,
 * returning the 401 response when it fails and `undefined` when it passes.
 *
 * Extracted because the check was copied per route and one copy was missing:
 * `handlePreviewAuthRoute` documented the gate and never performed it. A shared
 * helper does not make forgetting impossible, but it removes the reason to
 * re-type it, which is what let the omission look like the others.
 *
 * Fails closed when the token is unset — an unconfigured control plane refuses
 * these routes rather than opening them.
 */
export const requireAdminToken = (request: Request, environment: RouterEnv): Response | undefined => {
    const token = strictBearer(request);

    if (!environment.LUNORA_ADMIN_TOKEN || !constantTimeEqual(token, environment.LUNORA_ADMIN_TOKEN)) {
        return jsonError(401, "unauthorized");
    }

    return undefined;
};

/**
 * `GET /v1/tenants/plan?script=&lt;id>` — resolve a tenant script's plan tier for
 * the dispatcher's per-plan runtime limits (§4). Bearer-gated with
 * `LUNORA_ADMIN_TOKEN` (the dispatcher is a trusted account-level Worker).
 */
export const handleTenantPlanRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

    const scriptName = new URL(request.url).searchParams.get("script");

    if (!scriptName) {
        return jsonError(400, "script is required");
    }

    const result = await context.runQuery<{ plan: string; protected?: boolean }>(api.deployments.planForScript, { scriptName });

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

    // The check this route's own docblock claimed and did not perform. Without it
    // this was an unauthenticated password oracle: anyone who could reach the
    // control plane could POST a script name and a guess and read back yes or no,
    // for any protected preview on the platform. Same form as every other
    // `/v1/tenants/*` route, and now shared with them so a fourth cannot forget.
    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

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
 * `GET /v1/tenants/route?alias=&lt;label>` — resolve a stable subdomain alias to
 * the project's active versioned script (the blue/green pointer, GAPS.md A1).
 * Bearer-gated with `LUNORA_ADMIN_TOKEN`, same trust model as the plan lookup.
 */
export const handleTenantRouteRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

    const alias = new URL(request.url).searchParams.get("alias");

    if (!alias) {
        return jsonError(400, "alias is required");
    }

    const result = await context.runQuery<null | { candidateScriptName?: string; percent?: number; scriptName: string }>(api.deployments.routeForAlias, {
        alias,
    });

    return Response.json(result ?? { scriptName: null });
};

/**
 * `GET /v1/tenants/custom-domain?host=&lt;hostname>` — resolve a verified custom
 * hostname to a redirect or the owning project's active script, for the
 * dispatcher (GAPS.md B1). Bearer-gated with `LUNORA_ADMIN_TOKEN`.
 */
export const handleTenantCustomDomainRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

    const host = new URL(request.url).searchParams.get("host");

    if (!host) {
        return jsonError(400, "host is required");
    }

    const result = await context.runQuery<null | { redirectStatusCode?: number; redirectTo?: string; scriptName?: string }>(api.domains.routeForHostname, {
        hostname: host,
    });

    return Response.json(result ?? {});
};

/**
 * `POST /v1/cells` — register a fleet cell (platform-operator action, §2.5).
 * Bearer-gated with `LUNORA_ADMIN_TOKEN` (the platform trust boundary): cell
 * bring-up IaC holds the token. The delegated mutation is `internal`, so this
 * route is the only path in — a tenant can't inject cells over public RPC.
 */
export const handleCellRegisterRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    // Through the shared helper, like its five siblings. `requireAdminToken` was
    // extracted precisely because the check had been copied per route and one copy
    // was missing entirely; this route was then written with a sixth inline copy,
    // which is the same omission waiting to recur.
    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

    let body: { cloudflareAccountId?: unknown; dispatchNamespacePrefix?: unknown; jurisdiction?: unknown; name?: unknown };

    try {
        body = await request.json();
    } catch {
        return jsonError(400, "invalid JSON body");
    }

    const { cloudflareAccountId, dispatchNamespacePrefix, jurisdiction, name } = body;

    if (typeof cloudflareAccountId !== "string" || typeof dispatchNamespacePrefix !== "string" || typeof name !== "string") {
        return jsonError(400, "cloudflareAccountId, dispatchNamespacePrefix, and name are required");
    }

    if (jurisdiction !== undefined && typeof jurisdiction !== "string") {
        return jsonError(400, "jurisdiction must be a string when provided");
    }

    const cellId = await context.runMutation<string>(internal.cells.register, {
        cloudflareAccountId,
        dispatchNamespacePrefix,
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
        name,
    });

    return Response.json({ cellId }, { status: 201 });
};
