/** `value` trimmed when it is a non-blank string, else `undefined`. */
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

/** The environment variables the lookup reads; `process.env` satisfies it. */
interface CloudflareEnvironment {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
}

/** The Cloudflare API credentials a command found; either may be missing. */
interface CloudflareCredentials {
    accountId?: string;
    token?: string;
}

/**
 * `CLOUDFLARE_API_TOKEN`, and the account from `CLOUDFLARE_ACCOUNT_ID` or else
 * wrangler's `account_id` — the lookup every CLI command that calls the
 * Cloudflare REST API makes.
 */
const resolveCloudflareCredentials = (environment: CloudflareEnvironment, wranglerAccountId: unknown): CloudflareCredentials => {
    const accountId = nonEmpty(environment.CLOUDFLARE_ACCOUNT_ID) ?? nonEmpty(wranglerAccountId);
    const token = nonEmpty(environment.CLOUDFLARE_API_TOKEN);

    return { ...(accountId === undefined ? {} : { accountId }), ...(token === undefined ? {} : { token }) };
};

export type { CloudflareCredentials, CloudflareEnvironment };
export { nonEmpty, resolveCloudflareCredentials };
