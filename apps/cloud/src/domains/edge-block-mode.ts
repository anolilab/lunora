/**
 * How this cell blocks a suspended organization's traffic (plan 365 W8), off
 * the Worker env — one function, so the edge-block sweep and the studio's
 * Domains tab can never disagree about it.
 *
 * - `list` — the suspended-hostnames WAF list (Enterprise), with the account
 *   credentials to write it. Non-destructive: certificates stay as they are.
 * - `delete-hostnames` — opted in with `LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES=1`
 *   and the SaaS zone set: a suspended org's custom hostnames are deleted and
 *   recreated on recovery. Destructive to the customer's domains (a fresh
 *   certificate on recovery; a failed re-create or a lost CNAME leaves the
 *   domain broken), so never the default.
 * - `dispatcher` — neither: the dispatcher's 503 is the block.
 */
export type EdgeBlockMode = "delete-hostnames" | "dispatcher" | "list";

export interface EdgeBlockEnvironment {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES?: string;
    LUNORA_SAAS_ZONE_ID?: string;
    LUNORA_SUSPENDED_HOSTS_LIST_ID?: string;
}

export const edgeBlockModeOf = (environment: EdgeBlockEnvironment): EdgeBlockMode => {
    const credentials = Boolean(environment.CLOUDFLARE_ACCOUNT_ID && environment.CLOUDFLARE_API_TOKEN);

    if (credentials && environment.LUNORA_SUSPENDED_HOSTS_LIST_ID) {
        return "list";
    }

    return credentials && environment.LUNORA_SAAS_ZONE_ID && environment.LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES === "1" ? "delete-hostnames" : "dispatcher";
};
