/**
 * `lunora doctor`'s Cloudflare token check. A rejected `CLOUDFLARE_API_TOKEN`
 * otherwise surfaces at the first `lunora deploy`, after the build has run. The
 * token is checked at the user endpoint first, because most tokens are created
 * on a user profile, and only then at the account's own endpoint. It never fails
 * on a network problem, because that says nothing about the token.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";

import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import { nonEmpty, resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
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

/** The `result.status` of a verify answer, or `undefined` when the body does not carry one or its envelope says the call failed. */
const reportedStatus = (body: unknown): string | undefined => {
    if (typeof body !== "object" || body === null || !("result" in body) || ("success" in body && body.success === false)) {
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

/** One account endpoint's answer: a reported status or a 401/403 decides; anything else is inconclusive. */
const judgeAccount = async (accountId: string, token: string, fetchImpl: typeof globalThis.fetch): Promise<TokenVerdict> => {
    const account = await probeAccountToken(accountId, token, fetchImpl);

    if (account.reported !== undefined) {
        return account.reported === "active" ? { verdict: "active" } : { verdict: "rejected" };
    }

    if (account.status === 401 || account.status === 403) {
        return { verdict: "rejected" };
    }

    return { reason: `HTTP ${String(account.status)}`, verdict: "unchecked" };
};

/**
 * Decide what the two endpoints say. A status the token reports is the verdict:
 * `active` passes, anything else (disabled, expired) is rejected. Without a
 * reported status, only a refusal from both endpoints (401 or 403) is a
 * rejection, since a user-owned token answers at the user endpoint and an
 * account-owned one only at its account's. An inconclusive answer is unchecked.
 */
const judgeToken = async (token: string, accountIds: ReadonlyArray<string>, fetchImpl: typeof globalThis.fetch): Promise<TokenVerdict> => {
    const user = await probeUserToken(token, fetchImpl);

    if (user.reported !== undefined) {
        return user.reported === "active" ? { verdict: "active" } : { verdict: "rejected" };
    }

    // A 403 can mean the user endpoint does not let a token ask about itself, so it is not a verdict either.
    if (user.status !== 401 && user.status !== 403) {
        return { reason: `HTTP ${String(user.status)}`, verdict: "unchecked" };
    }

    if (accountIds.length === 0) {
        return { reason: "the user endpoint refused it, and no account id is set to check an account-owned token", verdict: "unchecked" };
    }

    // An account-owned token answers only at its own account, so a config that deploys to several accounts is
    // checked against each: one active answer passes, and only a refusal from every account is a rejection.
    let inconclusive: TokenVerdict | undefined;

    for (const accountId of accountIds) {
        // A probe that fails on the network is one inconclusive account, not the verdict: a later account may still
        // report the token active.
        // eslint-disable-next-line no-await-in-loop -- stops at the first account that reports the token active
        const verdict = await judgeAccount(accountId, token, fetchImpl).catch((error: unknown): TokenVerdict => {
            return {
                reason: error instanceof Error ? error.message : String(error),
                verdict: "unchecked",
            };
        });

        if (verdict.verdict === "active") {
            return verdict;
        }

        if (verdict.verdict === "unchecked") {
            inconclusive = verdict;
        }
    }

    return inconclusive ?? { verdict: "rejected" };
};

/** Every account the config deploys to, top level first, so an account-owned token is checked against its own account. */
const configuredAccountIds = (parsed: WranglerConfig | undefined): string[] => {
    const ids = [parsed?.account_id, ...Object.values(parsed?.env ?? {}).map((block) => (block as WranglerConfig | null | undefined)?.account_id)];

    // Trimmed like the credential resolver, so the probe URL names the account the config means.
    return [...new Set(ids.map((id) => nonEmpty(id)).filter((id): id is string => id !== undefined))];
};

const checkCloudflareToken = async (parsed: WranglerConfig | undefined, options: CloudflareTokenCheckOptions, findings: Finding[]): Promise<void> => {
    const environment = options.environment ?? process.env;
    const configured = configuredAccountIds(parsed);
    const { accountId, token } = resolveCloudflareCredentials(environment, configured[0]);
    // `CLOUDFLARE_ACCOUNT_ID` overrides every block's account, so it is the only one checked when set.
    const accountIds = nonEmpty(environment.CLOUDFLARE_ACCOUNT_ID) === undefined ? configured : [accountId].filter((id) => id !== undefined);

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
        verdict = await judgeToken(token, accountIds, fetchImpl);
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
export { checkCloudflareToken };
