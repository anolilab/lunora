import { ADMIN_TOKENS_PATH } from "../client-paths";
import { withQuery } from "../client-urls";
import type { AdminTokenSummary, CreatedAdminToken } from "../types";
import type { AdminHost } from "./host";

export const listAdminTokens = async (host: AdminHost): Promise<AdminTokenSummary[]> => {
    host.assertOpen();

    const body = (await host.adminFetch(ADMIN_TOKENS_PATH, "GET")) as { tokens?: AdminTokenSummary[] };

    return body.tokens ?? [];
};

export const createAdminToken = async (host: AdminHost, options: { expiresAt?: number; name: string }): Promise<CreatedAdminToken> => {
    host.assertOpen();

    return (await host.adminFetch(ADMIN_TOKENS_PATH, "POST", options)) as CreatedAdminToken;
};

export const revokeAdminToken = async (host: AdminHost, name: string): Promise<void> => {
    host.assertOpen();

    await host.adminFetch(withQuery(ADMIN_TOKENS_PATH, { name }), "DELETE");
};
