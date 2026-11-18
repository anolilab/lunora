import { LunoraError } from "@lunora/server";
import { describe, expect, it, vi } from "vitest";

import { handleGitHubInstallRoute } from "../src/deploy/routes/github-setup";

vi.mock(import("../src/auth"), () => {
    return {
        // Only the session read the route makes; the rest of better-auth's surface is unused here.
        currentAuth: (() => {
            return { api: { getSession: () => Promise.resolve({ user: { id: "usr_gone" } }) } };
        }) as never,
    };
});

/**
 * The install route asks `members.list` whether the session's user is an owner or
 * admin. That query refuses a non-member with FORBIDDEN rather than answering a
 * list without them, so someone removed from the organization must get the
 * flow's 403, not the refusal escaping as a server error.
 */
describe(handleGitHubInstallRoute, () => {
    it("answers 403 to a user who is no longer a member", async () => {
        expect.assertions(1);

        const context = {
            runQuery: () => Promise.reject(new LunoraError("FORBIDDEN", "not a member of this organization")),
        };
        const response = await handleGitHubInstallRoute(new Request("https://cloud.test/v1/github/install?organizationId=org_1"), {
            __lunoraCtx: context,
            GITHUB_APP_SLUG: "lunora",
            GITHUB_SETUP_STATE_SECRET: "secret",
        } as never);

        expect(response.status).toBe(403);
    });
});
