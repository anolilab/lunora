/**
 * Agent-queryable billing (plan 365 W6, D10): the usage / spend / cost reads,
 * deploy-key authenticated so the MCP surface can opt them in as tools
 * (`usage.summary`, `usage.cloudflare-costs`). No new data — the same ledger
 * and estimator the console reads, and the same Billable Usage read as the
 * Cloudflare costs tab.
 *
 * Both need an organization-wide, deploy-capable key (`authorizeBillingKey`):
 * the bearer, never a body field, is the credential, and every row is read for
 * the key's own organization.
 */
import { internal } from "../../../lunora/_generated/api.js";
import { readAccountCosts } from "../../cloudflare-accounts/costs";
import type { CloudflareAccountRow } from "../../cloudflare-accounts/store";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext, strictBearer } from "./shared";

/** Product lines a cost read returns at most, and the longest product label kept — both from Cloudflare's answer. */
const MAX_COST_PRODUCTS = 100;
const MAX_LABEL = 128;

const readBody = async (request: Request): Promise<null | Record<string, unknown>> => {
    const body: unknown = await request.json().catch(() => null);

    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
};

/**
 * `POST /v1/usage/summary` — one period's usage per meter, estimated spend,
 * cap and warn thresholds, level, and the current period's projection.
 * Body: `{ organizationId, periodStart? }` (`periodStart` a UTC month start).
 */
export const handleUsageSummaryRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const key = strictBearer(request);

    if (!key) {
        return jsonError(401, "missing bearer deploy key");
    }

    const body = await readBody(request);

    if (typeof body?.["organizationId"] !== "string" || (body["periodStart"] !== undefined && typeof body["periodStart"] !== "number")) {
        return jsonError(400, "organizationId is required; periodStart, when given, is a number");
    }

    try {
        const summary = await requireContext(environment).runQuery(internal.usage.billingSummary, {
            deployKey: key,
            organizationId: body["organizationId"],
            ...(body["periodStart"] === undefined ? {} : { periodStart: body["periodStart"] }),
        });

        return Response.json(summary);
    } catch (error) {
        return rejected(error, "usage summary denied");
    }
};

/**
 * `POST /v1/usage/cloudflare-costs` — a connected Cloudflare account's real
 * spend for its most recent charge period (Billable Usage API, read with the
 * account's own token, unsealed here and never returned). Body:
 * `{ organizationId, id }` (`id`: the `cloudflareAccounts` row). Fails open to
 * a status, like the costs tab; the view is bounded before it is returned.
 */
export const handleCloudflareCostsRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const key = strictBearer(request);

    if (!key) {
        return jsonError(401, "missing bearer deploy key");
    }

    const body = await readBody(request);

    if (typeof body?.["organizationId"] !== "string" || typeof body["id"] !== "string") {
        return jsonError(400, "organizationId and id are required");
    }

    let row: Pick<CloudflareAccountRow, "accountId" | "ciphertext" | "iv" | "permissions">;

    try {
        row = await requireContext(environment).runQuery(internal.cloudflare_accounts.costTarget, {
            deployKey: key,
            id: body["id"],
            organizationId: body["organizationId"],
        });
    } catch (error) {
        return rejected(error, "cost read denied");
    }

    const costs = await readAccountCosts(row, environment.SECRET_ENCRYPTION_KEY === undefined ? {} : { encryptionKey: environment.SECRET_ENCRYPTION_KEY });

    return Response.json({
        status: costs.status,
        view:
            costs.view === null
                ? null
                : {
                      ...costs.view,
                      products: costs.view.products.slice(0, MAX_COST_PRODUCTS).map((line) => {
                          return {
                              ...line,
                              currency: line.currency.slice(0, 8),
                              product: line.product.slice(0, MAX_LABEL),
                              unit: line.unit?.slice(0, MAX_LABEL) ?? null,
                          };
                      }),
                  },
    });
};
