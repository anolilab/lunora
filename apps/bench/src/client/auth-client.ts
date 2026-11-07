import { lunoraSessionSync } from "@lunora/auth/plugins/client";
import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * The browser's better-auth client: sign-up / sign-in, and the organization
 * plugin that sets the session's `activeOrganizationId` — the claim every
 * org-scoped function on the server reads. `lunoraSessionSync` re-authenticates
 * the Lunora socket when the session changes. `twoFactorClient` gives the sign-in
 * form the verification calls for a password sign-in that needs a second factor.
 */
export const authClient = createAuthClient({
    basePath: "/api/auth",
    plugins: [lunoraSessionSync(), organizationClient(), twoFactorClient()],
});
