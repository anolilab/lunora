/**
 * `lunora doctor`'s Cloudflare token check. A rejected `CLOUDFLARE_API_TOKEN`
 * otherwise surfaces at the first `lunora deploy`, after the build has run. The
 * check asks the account whether the token is active. It never fails on a
 * network problem, because that says nothing about the token.
 */
import type { WranglerConfig } from "@lunora/config/cloudflare";

import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import { resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
import type { Finding } from "./handler";

/** How long the verify call may take: the check is advice, and must never stall doctor. */
const REQUEST_TIMEOUT_MS = 5000;

interface CloudflareTokenCheckOptions {
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof globalThis.fetch;
}

/** Whether the account's `tokens/verify` answer says the token can act. */
const isActive = (body: Record<string, unknown>): boolean => {
    const { result } = body;

    return typeof result === "object" && result !== null && "status" in result && result.status === "active";
};

/**
 * Verify the token against the account it would deploy to. A token the API
 * rejects (401, or an answer that is not `active`) fails; a token it cannot
 * verify, and a run with no token or account, is informational.
 */
const checkCloudflareToken = async (parsed: WranglerConfig | undefined, options: CloudflareTokenCheckOptions, findings: Finding[]): Promise<void> => {
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, parsed?.account_id);

    if (token === undefined || accountId === undefined) {
        findings.push({
            code: "cloudflare-token-unchecked",
            fix: "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or `account_id` in wrangler.jsonc) to verify the token.",
            level: "info",
            message: "the Cloudflare API token was not verified: CLOUDFLARE_API_TOKEN and an account id are not both set.",
        });

        return;
    }

    let outcome: Awaited<ReturnType<typeof cloudflareRestRequest>>;

    try {
        outcome = await cloudflareRestRequest({
            accountId,
            apiToken: token,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            init: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            path: "/tokens/verify",
        });
    } catch (error) {
        findings.push({
            code: "cloudflare-token-unchecked",
            level: "info",
            message: `the Cloudflare API token could not be verified (${error instanceof Error ? error.message : String(error)}).`,
        });

        return;
    }

    if (outcome.ok && isActive(outcome.body)) {
        findings.push({ code: "cloudflare-token-ok", level: "pass", message: "the Cloudflare API token is active for this account." });

        return;
    }

    if (outcome.ok || outcome.status === 401) {
        findings.push({
            code: "cloudflare-token-rejected",
            fix: "Create a token at https://dash.cloudflare.com/profile/api-tokens with the Workers Scripts Edit permission, then set CLOUDFLARE_API_TOKEN to it.",
            level: "fail",
            message: "the Cloudflare API token is not active for this account, so deploys with it will fail.",
        });

        return;
    }

    // A 403 can mean the token may not ask about itself, so it is not a verdict.
    findings.push({
        code: "cloudflare-token-unchecked",
        level: "info",
        message: `the Cloudflare API token could not be verified (HTTP ${String(outcome.status)}).`,
    });
};

export type { CloudflareTokenCheckOptions };
export default checkCloudflareToken;
