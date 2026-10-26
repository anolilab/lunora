/**
 * `lunora doctor`'s Cloudflare token check. A rejected `CLOUDFLARE_API_TOKEN`
 * otherwise surfaces at the first `lunora deploy`, after the build has run. The
 * token is checked at the user endpoint first, because most tokens are created
 * on a user profile, and only then at the account's own endpoint. It never fails
 * on a network problem, because that says nothing about the token.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";

import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import { resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
import type { Finding } from "./handler";

/** How long a verify call may take: the check is advice, and must never stall doctor. */
const REQUEST_TIMEOUT_MS = 5000;

/** Answers for a token created on a user profile, which is the usual kind. */
const USER_VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";

interface CloudflareTokenCheckOptions {
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof globalThis.fetch;
}

/** What one verify call said: its HTTP status, and whether the token reported itself `active`. */
interface VerifyProbe {
    active: boolean;
    status: number;
}

type TokenVerdict = { verdict: "active" } | { verdict: "rejected" } | { reason: string; verdict: "unchecked" };

/** Whether a verify answer's `result.status` is `active`. */
const isActive = (body: unknown): boolean => {
    if (typeof body !== "object" || body === null || !("result" in body)) {
        return false;
    }

    const { result } = body;

    return typeof result === "object" && result !== null && "status" in result && result.status === "active";
};

const probeUserToken = async (token: string, fetchImpl: typeof globalThis.fetch): Promise<VerifyProbe> => {
    const response = await fetchImpl(USER_VERIFY_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);

    return { active: response.ok && isActive(body), status: response.status };
};

const probeAccountToken = async (accountId: string, token: string, fetchImpl: typeof globalThis.fetch): Promise<VerifyProbe> => {
    const outcome = await cloudflareRestRequest({
        accountId,
        apiToken: token,
        fetch: fetchImpl,
        init: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        path: "/tokens/verify",
    });

    return outcome.ok ? { active: isActive(outcome.body), status: 200 } : { active: false, status: outcome.status };
};

/**
 * Decide what the two endpoints say. Only a 401 from both is a rejection: a
 * user-owned token answers at the user endpoint, and an account-owned one only
 * at its account's, so a 401 from one of them is not yet a verdict.
 */
const judgeToken = async (token: string, accountId: string | undefined, fetchImpl: typeof globalThis.fetch): Promise<TokenVerdict> => {
    const user = await probeUserToken(token, fetchImpl);

    if (user.active) {
        return { verdict: "active" };
    }

    if (user.status === 200) {
        return { verdict: "rejected" };
    }

    // A 403 can mean the user endpoint does not let a token ask about itself, so it is not a verdict either.
    if (user.status !== 401 && user.status !== 403) {
        return { reason: `HTTP ${String(user.status)}`, verdict: "unchecked" };
    }

    if (accountId === undefined) {
        return { reason: "the user endpoint refused it, and no account id is set to check an account-owned token", verdict: "unchecked" };
    }

    const account = await probeAccountToken(accountId, token, fetchImpl);

    if (account.active) {
        return { verdict: "active" };
    }

    if (account.status === 401) {
        return { verdict: "rejected" };
    }

    return { reason: `HTTP ${String(account.status)}`, verdict: "unchecked" };
};

const checkCloudflareToken = async (parsed: WranglerConfig | undefined, options: CloudflareTokenCheckOptions, findings: Finding[]): Promise<void> => {
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, parsed?.account_id);

    if (token === undefined) {
        findings.push({
            code: "cloudflare-token-unchecked",
            fix: "Set CLOUDFLARE_API_TOKEN to verify it.",
            level: "info",
            message: "the Cloudflare API token was not verified: CLOUDFLARE_API_TOKEN is not set.",
        });

        return;
    }

    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    let verdict: TokenVerdict;

    try {
        verdict = await judgeToken(token, accountId, fetchImpl);
    } catch (error) {
        verdict = { reason: error instanceof Error ? error.message : String(error), verdict: "unchecked" };
    }

    if (verdict.verdict === "active") {
        findings.push({ code: "cloudflare-token-ok", level: "pass", message: "the Cloudflare API token is active." });
    } else if (verdict.verdict === "rejected") {
        findings.push({
            code: "cloudflare-token-rejected",
            fix: "Create a token at https://dash.cloudflare.com/profile/api-tokens with the Workers Scripts Edit permission, then set CLOUDFLARE_API_TOKEN to it.",
            level: "fail",
            message: "the Cloudflare API token is not active, so deploys with it will fail.",
        });
    } else {
        findings.push({
            code: "cloudflare-token-unchecked",
            level: "info",
            message: `the Cloudflare API token could not be verified (${verdict.reason}).`,
        });
    }
};

export type { CloudflareTokenCheckOptions };
export default checkCloudflareToken;
