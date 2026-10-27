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

/** What one verify call said: its HTTP status, and the `status` the token reported, if the body held one. */
interface VerifyProbe {
    reported: string | undefined;
    status: number;
}

type TokenVerdict = { verdict: "active" } | { verdict: "rejected" } | { reason: string; verdict: "unchecked" };

/** The `result.status` of a verify answer, or `undefined` when the body does not carry one. */
const reportedStatus = (body: unknown): string | undefined => {
    if (typeof body !== "object" || body === null || !("result" in body)) {
        return undefined;
    }

    const { result } = body;

    return typeof result === "object" && result !== null && "status" in result && typeof result.status === "string" ? result.status : undefined;
};

const probeUserToken = async (token: string, fetchImpl: typeof globalThis.fetch): Promise<VerifyProbe> => {
    const response = await fetchImpl(USER_VERIFY_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);

    return { reported: response.ok ? reportedStatus(body) : undefined, status: response.status };
};

const probeAccountToken = async (accountId: string, token: string, fetchImpl: typeof globalThis.fetch): Promise<VerifyProbe> => {
    const outcome = await cloudflareRestRequest({
        accountId,
        apiToken: token,
        fetch: fetchImpl,
        init: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        path: "/tokens/verify",
    });

    return outcome.ok ? { reported: reportedStatus(outcome.body), status: 200 } : { reported: undefined, status: outcome.status };
};

/**
 * Decide what the two endpoints say. A status the token reports is the verdict:
 * `active` passes, anything else (disabled, expired) is rejected. Without a
 * reported status, only a refusal from both endpoints (401 or 403) is a
 * rejection, since a user-owned token answers at the user endpoint and an
 * account-owned one only at its account's. An inconclusive answer is unchecked.
 */
const judgeToken = async (token: string, accountId: string | undefined, fetchImpl: typeof globalThis.fetch): Promise<TokenVerdict> => {
    const user = await probeUserToken(token, fetchImpl);

    if (user.reported !== undefined) {
        return user.reported === "active" ? { verdict: "active" } : { verdict: "rejected" };
    }

    // A 403 can mean the user endpoint does not let a token ask about itself, so it is not a verdict either.
    if (user.status !== 401 && user.status !== 403) {
        return { reason: `HTTP ${String(user.status)}`, verdict: "unchecked" };
    }

    if (accountId === undefined) {
        return { reason: "the user endpoint refused it, and no account id is set to check an account-owned token", verdict: "unchecked" };
    }

    const account = await probeAccountToken(accountId, token, fetchImpl);

    if (account.reported !== undefined) {
        return account.reported === "active" ? { verdict: "active" } : { verdict: "rejected" };
    }

    if (account.status === 401 || account.status === 403) {
        return { verdict: "rejected" };
    }

    return { reason: `HTTP ${String(account.status)}`, verdict: "unchecked" };
};

/** The account a token is checked against when no `CLOUDFLARE_ACCOUNT_ID` overrides it: the top level's, else the first environment block's. */
const configuredAccountId = (parsed: WranglerConfig | undefined): unknown =>
    parsed?.account_id ??
    Object.values(parsed?.env ?? {})
        .map((block) => (block as WranglerConfig | null | undefined)?.account_id)
        .find((id) => typeof id === "string" && id !== "");

const checkCloudflareToken = async (parsed: WranglerConfig | undefined, options: CloudflareTokenCheckOptions, findings: Finding[]): Promise<void> => {
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, configuredAccountId(parsed));

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
