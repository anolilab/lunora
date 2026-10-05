/**
 * `POST /v1/cloudflare-accounts` — connect an organization's own Cloudflare
 * account for the `cloudflare-workers` target, or rotate the token of one it
 * connected (`session`; the internal `cloudflareAccounts.connect` mutation
 * asserts owner/admin under the caller's session).
 *
 * The token is checked against the account BEFORE anything is stored
 * (`inspectAccount`): it must be active, reach this account with Workers
 * Scripts, and the account must have a `workers.dev` subdomain. Only then is it
 * sealed with `SECRET_ENCRYPTION_KEY` — the plaintext never reaches the
 * database, a log line or a response.
 */
import { internal } from "../../../lunora/_generated/api.js";
import { CloudflareTokenError } from "../../cloudflare/fetch";
import { encryptSecret } from "../../secrets/crypto";
import { inspectAccount, isCloudflareAccountId } from "../../targets/cloudflare-workers/api";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/** The request body, untrusted. */
interface ConnectBody {
    accountId?: unknown;
    /** Set to rotate the token of an existing connection. */
    id?: unknown;
    label?: unknown;
    organizationId?: unknown;
    token?: unknown;
}

/** Longest token accepted — Cloudflare's are 40 characters; anything near this is not one. */
const MAX_TOKEN_LENGTH = 512;

const MAX_LABEL_LENGTH = 128;

/** The body's fields, typed, or `undefined` when one is missing or malformed. */
const parseBody = (raw: unknown): undefined | { accountId: unknown; id?: string; label: string; organizationId: string; token: string } => {
    const body = (raw ?? {}) as ConnectBody;
    const { id, label, organizationId, token } = body;
    const validToken = typeof token === "string" && token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
    const validLabel = label === undefined || (typeof label === "string" && label.length <= MAX_LABEL_LENGTH);

    if (typeof organizationId !== "string" || !validToken || !validLabel || (id !== undefined && typeof id !== "string")) {
        return undefined;
    }

    return { accountId: body.accountId, ...(typeof id === "string" ? { id } : {}), label: typeof label === "string" ? label : "", organizationId, token };
};

export const handleCloudflareAccountConnectRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    if (!environment.SECRET_ENCRYPTION_KEY) {
        return jsonError(500, "SECRET_ENCRYPTION_KEY not configured");
    }

    const body = parseBody(await request.json().catch(() => null));

    if (body === undefined) {
        return jsonError(400, "organizationId, accountId and token are required");
    }

    const { accountId } = body;

    if (!isCloudflareAccountId(accountId)) {
        return jsonError(400, "accountId must be the 32-character hex account id from the Cloudflare dashboard");
    }
    let inspection: Awaited<ReturnType<typeof inspectAccount>>;

    try {
        inspection = await inspectAccount({ accountId, apiToken: body.token });
    } catch (error) {
        // A refused token is the caller's to fix; anything else is Cloudflare being unreachable.
        return error instanceof CloudflareTokenError
            ? jsonError(400, `the token was not accepted: ${error.message}`)
            : jsonError(502, "could not reach Cloudflare to check the token; try again");
    }

    let sealed: { ciphertext: string; iv: string };

    try {
        sealed = await encryptSecret(environment.SECRET_ENCRYPTION_KEY, body.token);
    } catch (error) {
        return jsonError(500, error instanceof Error ? error.message : "token encryption failed");
    }

    try {
        const id = await context.runMutation<string>(internal.cloudflare_accounts.connect, {
            accountId,
            ...(inspection.displayName === null ? {} : { displayName: inspection.displayName }),
            ciphertext: sealed.ciphertext,
            ...(body.id === undefined ? {} : { id: body.id }),
            iv: sealed.iv,
            label: body.label,
            organizationId: body.organizationId,
            permissions: inspection.permissions,
            ...(inspection.token.expiresAt === undefined ? {} : { tokenExpiresAt: inspection.token.expiresAt }),
            workersSubdomain: inspection.workersSubdomain,
        });

        return Response.json({ id, permissions: inspection.permissions, workersSubdomain: inspection.workersSubdomain });
    } catch (error) {
        return rejected(error, "connect Cloudflare account failed");
    }
};
