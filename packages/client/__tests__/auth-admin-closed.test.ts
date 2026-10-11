import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";

describe("lunoraClient auth admin calls on a closed client", () => {
    it.each([
        "listAuthUsers",
        "createAuthUser",
        "setAuthUserRole",
        "banAuthUser",
        "unbanAuthUser",
        "setAuthUserPassword", // gitleaks:allow — a method name, not a credential
        "removeAuthUser",
        "impersonateAuthUser",
        "revokeAuthSession",
        "revokeAuthUserSessions",
        "getAuthCapabilities",
        "updateAuthUser",
        "listAuthAccounts",
        "unlinkAuthAccount",
        "listAuthPasskeys",
        "deleteAuthPasskey",
        // eslint-disable-next-line no-secrets/no-secrets -- the table is method names, not credentials
        "disableAuthTwoFactor",
        "listAuthOrganizations",
        "listAuthOrgMembers",
        "listAuthOrgInvitations",
        "listAuthSignUpInvitations",
        "createAuthSignUpInvitation",
        "revokeAuthSignUpInvitation",
        "removeAuthOrgMember",
        "cancelAuthOrgInvitation",
        "getAuthConfig",
        "createAuthOrganization",
        "updateAuthOrganization",
        "deleteAuthOrganization",
        "addAuthOrgMember",
        "inviteAuthOrgMember",
        "setAuthOrgMemberRole",
        "listAuthOrgTeams",
        "createAuthOrgTeam",
        "updateAuthOrgTeam",
        "removeAuthOrgTeam",
        "listAuthOrgTeamMembers",
        "addAuthOrgTeamMember",
        "removeAuthOrgTeamMember",
        "listAuthOrgRoles",
        "createAuthOrgRole",
        "updateAuthOrgRole",
        "deleteAuthOrgRole",
        "listAuthSessions",
    ] as const)("%s rejects once the client is closed, without reaching fetch", async (name) => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>();
        const client = new LunoraClient({
            fetch: fetchMock,
            url: "https://app.example",
            WebSocket: vi.fn<() => void>() as unknown as typeof WebSocket,
        });

        client.close();

        // eslint-disable-next-line vitest/unbound-method -- the cast only reads the name; the call below binds the client
        const method = client[name] as unknown as () => Promise<unknown>;

        await expect(method.call(client)).rejects.toThrow("LunoraClient is closed");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
