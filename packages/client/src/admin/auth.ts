import {
    AUTH_ACCOUNTS_PATH,
    AUTH_ADD_MEMBER_PATH,
    AUTH_ADD_TEAM_MEMBER_PATH,
    AUTH_BAN_PATH,
    AUTH_CANCEL_INVITATION_PATH,
    AUTH_CAPABILITIES_PATH,
    AUTH_CONFIG_PATH,
    AUTH_CREATE_ORG_PATH,
    AUTH_CREATE_ROLE_PATH,
    AUTH_CREATE_SIGN_UP_INVITATION_PATH,
    AUTH_CREATE_TEAM_PATH,
    AUTH_CREATE_USER_PATH,
    AUTH_DELETE_PASSKEY_PATH,
    AUTH_DISABLE_2FA_PATH,
    AUTH_IMPERSONATE_PATH,
    AUTH_INVITE_MEMBER_PATH,
    AUTH_MEMBER_ROLE_PATH,
    AUTH_ORG_INVITATIONS_PATH,
    AUTH_ORG_MEMBERS_PATH,
    AUTH_ORG_ROLES_PATH,
    AUTH_ORG_TEAM_MEMBERS_PATH,
    AUTH_ORG_TEAMS_PATH,
    AUTH_ORGS_PATH,
    AUTH_PASSKEYS_PATH,
    AUTH_REMOVE_MEMBER_PATH,
    AUTH_REMOVE_ORG_PATH,
    AUTH_REMOVE_ROLE_PATH,
    AUTH_REMOVE_TEAM_MEMBER_PATH,
    AUTH_REMOVE_TEAM_PATH,
    AUTH_REMOVE_USER_PATH,
    AUTH_REVOKE_SESSION_PATH,
    AUTH_REVOKE_SESSIONS_PATH,
    AUTH_REVOKE_SIGN_UP_INVITATION_PATH,
    AUTH_SESSIONS_PATH,
    AUTH_SET_PASSWORD_PATH,
    AUTH_SET_ROLE_PATH,
    AUTH_SIGN_UP_INVITATIONS_PATH,
    AUTH_UNBAN_PATH,
    AUTH_UNLINK_ACCOUNT_PATH,
    AUTH_UPDATE_ORG_PATH,
    AUTH_UPDATE_ROLE_PATH,
    AUTH_UPDATE_TEAM_PATH,
    AUTH_UPDATE_USER_PATH,
    AUTH_USERS_PATH,
} from "../client-paths";
import { withQuery } from "../client-urls";
import type { LunoraClient } from "../lunora-client";
import type { AuthCapabilities, AuthConfigInfo, AuthImpersonation, AuthPage, AuthSession, AuthUser } from "../types";
import type { AdminHost } from "./host";

export const listAuthUsers = async (host: AdminHost, options: Parameters<LunoraClient["listAuthUsers"]>[0] = {}): ReturnType<LunoraClient["listAuthUsers"]> => {
    host.assertOpen();

    const path = withQuery(AUTH_USERS_PATH, {
        filterField: options.filterField,
        filterValue: options.filterValue,
        limit: options.limit,
        offset: options.offset,
        search: options.search,
        searchField: options.searchField,
        sortBy: options.sortBy,
        sortDirection: options.sortDirection,
    });

    return (await host.adminFetch(path, "GET")) as AuthPage<AuthUser>;
};

export const createAuthUser = async (host: AdminHost, input: Parameters<LunoraClient["createAuthUser"]>[0]): ReturnType<LunoraClient["createAuthUser"]> =>
    (await host.adminFetch(AUTH_CREATE_USER_PATH, "POST", input)) as AuthUser;

export const setAuthUserRole = async (host: AdminHost, input: Parameters<LunoraClient["setAuthUserRole"]>[0]): ReturnType<LunoraClient["setAuthUserRole"]> =>
    (await host.adminFetch(AUTH_SET_ROLE_PATH, "POST", input)) as AuthUser;

export const banAuthUser = async (host: AdminHost, input: Parameters<LunoraClient["banAuthUser"]>[0]): ReturnType<LunoraClient["banAuthUser"]> =>
    (await host.adminFetch(AUTH_BAN_PATH, "POST", input)) as AuthUser;

export const unbanAuthUser = async (host: AdminHost, input: Parameters<LunoraClient["unbanAuthUser"]>[0]): ReturnType<LunoraClient["unbanAuthUser"]> =>
    (await host.adminFetch(AUTH_UNBAN_PATH, "POST", input)) as AuthUser;

export const setAuthUserPassword = async (
    host: AdminHost,
    input: Parameters<LunoraClient["setAuthUserPassword"]>[0],
): ReturnType<LunoraClient["setAuthUserPassword"]> => {
    await host.adminFetch(AUTH_SET_PASSWORD_PATH, "POST", input);
};

export const removeAuthUser = async (host: AdminHost, input: Parameters<LunoraClient["removeAuthUser"]>[0]): ReturnType<LunoraClient["removeAuthUser"]> => {
    await host.adminFetch(AUTH_REMOVE_USER_PATH, "POST", input);
};

export const impersonateAuthUser = async (
    host: AdminHost,
    input: Parameters<LunoraClient["impersonateAuthUser"]>[0],
): ReturnType<LunoraClient["impersonateAuthUser"]> => (await host.adminFetch(AUTH_IMPERSONATE_PATH, "POST", input)) as AuthImpersonation;

export const revokeAuthSession = async (
    host: AdminHost,
    input: Parameters<LunoraClient["revokeAuthSession"]>[0],
): ReturnType<LunoraClient["revokeAuthSession"]> => {
    await host.adminFetch(AUTH_REVOKE_SESSION_PATH, "POST", input);
};

export const revokeAuthUserSessions = async (
    host: AdminHost,
    input: Parameters<LunoraClient["revokeAuthUserSessions"]>[0],
): ReturnType<LunoraClient["revokeAuthUserSessions"]> => {
    await host.adminFetch(AUTH_REVOKE_SESSIONS_PATH, "POST", input);
};

export const getAuthCapabilities = async (host: AdminHost): ReturnType<LunoraClient["getAuthCapabilities"]> =>
    (await host.adminFetch(AUTH_CAPABILITIES_PATH, "GET")) as AuthCapabilities;

export const updateAuthUser = async (host: AdminHost, input: Parameters<LunoraClient["updateAuthUser"]>[0]): ReturnType<LunoraClient["updateAuthUser"]> =>
    (await host.adminFetch(AUTH_UPDATE_USER_PATH, "POST", input)) as AuthUser;

export const listAuthAccounts = async (host: AdminHost, input: Parameters<LunoraClient["listAuthAccounts"]>[0]): ReturnType<LunoraClient["listAuthAccounts"]> =>
    (await host.adminFetch(withQuery(AUTH_ACCOUNTS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];

export const unlinkAuthAccount = async (
    host: AdminHost,
    input: Parameters<LunoraClient["unlinkAuthAccount"]>[0],
): ReturnType<LunoraClient["unlinkAuthAccount"]> => {
    await host.adminFetch(AUTH_UNLINK_ACCOUNT_PATH, "POST", input);
};

export const listAuthPasskeys = async (host: AdminHost, input: Parameters<LunoraClient["listAuthPasskeys"]>[0]): ReturnType<LunoraClient["listAuthPasskeys"]> =>
    (await host.adminFetch(withQuery(AUTH_PASSKEYS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];

export const deleteAuthPasskey = async (
    host: AdminHost,
    input: Parameters<LunoraClient["deleteAuthPasskey"]>[0],
): ReturnType<LunoraClient["deleteAuthPasskey"]> => {
    await host.adminFetch(AUTH_DELETE_PASSKEY_PATH, "POST", input);
};

/* eslint-disable no-secrets/no-secrets -- the type-index key is a method name, not a credential */
export const disableAuthTwoFactor = async (
    host: AdminHost,
    input: Parameters<LunoraClient["disableAuthTwoFactor"]>[0],
): ReturnType<LunoraClient["disableAuthTwoFactor"]> => {
    await host.adminFetch(AUTH_DISABLE_2FA_PATH, "POST", input);
};
/* eslint-enable no-secrets/no-secrets */

export const listAuthOrganizations = async (
    host: AdminHost,
    options: Parameters<LunoraClient["listAuthOrganizations"]>[0] = {},
): ReturnType<LunoraClient["listAuthOrganizations"]> =>
    (await host.adminFetch(withQuery(AUTH_ORGS_PATH, { limit: options.limit, offset: options.offset }), "GET")) as AuthPage<Record<string, unknown>>;

export const listAuthOrgMembers = async (
    host: AdminHost,
    input: Parameters<LunoraClient["listAuthOrgMembers"]>[0],
): ReturnType<LunoraClient["listAuthOrgMembers"]> => {
    const path = withQuery(AUTH_ORG_MEMBERS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const listAuthOrgInvitations = async (
    host: AdminHost,
    input: Parameters<LunoraClient["listAuthOrgInvitations"]>[0],
): ReturnType<LunoraClient["listAuthOrgInvitations"]> => {
    const path = withQuery(AUTH_ORG_INVITATIONS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const listAuthSignUpInvitations = async (
    host: AdminHost,
    options: Parameters<LunoraClient["listAuthSignUpInvitations"]>[0] = {},
): ReturnType<LunoraClient["listAuthSignUpInvitations"]> => {
    const path = withQuery(AUTH_SIGN_UP_INVITATIONS_PATH, { limit: options.limit, offset: options.offset });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const createAuthSignUpInvitation = async (
    host: AdminHost,
    input: Parameters<LunoraClient["createAuthSignUpInvitation"]>[0],
): ReturnType<LunoraClient["createAuthSignUpInvitation"]> =>
    (await host.adminFetch(AUTH_CREATE_SIGN_UP_INVITATION_PATH, "POST", input)) as Record<string, unknown>;

export const revokeAuthSignUpInvitation = async (
    host: AdminHost,
    input: Parameters<LunoraClient["revokeAuthSignUpInvitation"]>[0],
): ReturnType<LunoraClient["revokeAuthSignUpInvitation"]> => {
    await host.adminFetch(AUTH_REVOKE_SIGN_UP_INVITATION_PATH, "POST", input);
};

export const removeAuthOrgMember = async (
    host: AdminHost,
    input: Parameters<LunoraClient["removeAuthOrgMember"]>[0],
): ReturnType<LunoraClient["removeAuthOrgMember"]> => {
    await host.adminFetch(AUTH_REMOVE_MEMBER_PATH, "POST", input);
};

export const cancelAuthOrgInvitation = async (
    host: AdminHost,
    input: Parameters<LunoraClient["cancelAuthOrgInvitation"]>[0],
): ReturnType<LunoraClient["cancelAuthOrgInvitation"]> => {
    await host.adminFetch(AUTH_CANCEL_INVITATION_PATH, "POST", input);
};

export const getAuthConfig = async (host: AdminHost): ReturnType<LunoraClient["getAuthConfig"]> =>
    (await host.adminFetch(AUTH_CONFIG_PATH, "GET")) as AuthConfigInfo;

export const createAuthOrganization = async (
    host: AdminHost,
    input: Parameters<LunoraClient["createAuthOrganization"]>[0],
): ReturnType<LunoraClient["createAuthOrganization"]> => (await host.adminFetch(AUTH_CREATE_ORG_PATH, "POST", input)) as Record<string, unknown>;

export const updateAuthOrganization = async (
    host: AdminHost,
    input: Parameters<LunoraClient["updateAuthOrganization"]>[0],
): ReturnType<LunoraClient["updateAuthOrganization"]> => (await host.adminFetch(AUTH_UPDATE_ORG_PATH, "POST", input)) as Record<string, unknown>;

export const deleteAuthOrganization = async (
    host: AdminHost,
    input: Parameters<LunoraClient["deleteAuthOrganization"]>[0],
): ReturnType<LunoraClient["deleteAuthOrganization"]> => {
    await host.adminFetch(AUTH_REMOVE_ORG_PATH, "POST", input);
};

export const addAuthOrgMember = async (host: AdminHost, input: Parameters<LunoraClient["addAuthOrgMember"]>[0]): ReturnType<LunoraClient["addAuthOrgMember"]> =>
    (await host.adminFetch(AUTH_ADD_MEMBER_PATH, "POST", input)) as Record<string, unknown>;

export const inviteAuthOrgMember = async (
    host: AdminHost,
    input: Parameters<LunoraClient["inviteAuthOrgMember"]>[0],
): ReturnType<LunoraClient["inviteAuthOrgMember"]> => (await host.adminFetch(AUTH_INVITE_MEMBER_PATH, "POST", input)) as Record<string, unknown>;

export const setAuthOrgMemberRole = async (
    host: AdminHost,
    input: Parameters<LunoraClient["setAuthOrgMemberRole"]>[0],
): ReturnType<LunoraClient["setAuthOrgMemberRole"]> => (await host.adminFetch(AUTH_MEMBER_ROLE_PATH, "POST", input)) as Record<string, unknown>;

export const listAuthOrgTeams = async (
    host: AdminHost,
    input: Parameters<LunoraClient["listAuthOrgTeams"]>[0],
): ReturnType<LunoraClient["listAuthOrgTeams"]> => {
    const path = withQuery(AUTH_ORG_TEAMS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const createAuthOrgTeam = async (
    host: AdminHost,
    input: Parameters<LunoraClient["createAuthOrgTeam"]>[0],
): ReturnType<LunoraClient["createAuthOrgTeam"]> => (await host.adminFetch(AUTH_CREATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;

export const updateAuthOrgTeam = async (
    host: AdminHost,
    input: Parameters<LunoraClient["updateAuthOrgTeam"]>[0],
): ReturnType<LunoraClient["updateAuthOrgTeam"]> => (await host.adminFetch(AUTH_UPDATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;

export const removeAuthOrgTeam = async (
    host: AdminHost,
    input: Parameters<LunoraClient["removeAuthOrgTeam"]>[0],
): ReturnType<LunoraClient["removeAuthOrgTeam"]> => {
    await host.adminFetch(AUTH_REMOVE_TEAM_PATH, "POST", input);
};

export const listAuthOrgTeamMembers = async (
    host: AdminHost,
    input: Parameters<LunoraClient["listAuthOrgTeamMembers"]>[0],
): ReturnType<LunoraClient["listAuthOrgTeamMembers"]> => {
    const path = withQuery(AUTH_ORG_TEAM_MEMBERS_PATH, { limit: input.limit, offset: input.offset, teamId: input.teamId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const addAuthOrgTeamMember = async (
    host: AdminHost,
    input: Parameters<LunoraClient["addAuthOrgTeamMember"]>[0],
): ReturnType<LunoraClient["addAuthOrgTeamMember"]> => (await host.adminFetch(AUTH_ADD_TEAM_MEMBER_PATH, "POST", input)) as Record<string, unknown>;

export const removeAuthOrgTeamMember = async (
    host: AdminHost,
    input: Parameters<LunoraClient["removeAuthOrgTeamMember"]>[0],
): ReturnType<LunoraClient["removeAuthOrgTeamMember"]> => {
    await host.adminFetch(AUTH_REMOVE_TEAM_MEMBER_PATH, "POST", input);
};

export const listAuthOrgRoles = async (
    host: AdminHost,
    input: Parameters<LunoraClient["listAuthOrgRoles"]>[0],
): ReturnType<LunoraClient["listAuthOrgRoles"]> => {
    const path = withQuery(AUTH_ORG_ROLES_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const createAuthOrgRole = async (
    host: AdminHost,
    input: Parameters<LunoraClient["createAuthOrgRole"]>[0],
): ReturnType<LunoraClient["createAuthOrgRole"]> => (await host.adminFetch(AUTH_CREATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;

export const updateAuthOrgRole = async (
    host: AdminHost,
    input: Parameters<LunoraClient["updateAuthOrgRole"]>[0],
): ReturnType<LunoraClient["updateAuthOrgRole"]> => (await host.adminFetch(AUTH_UPDATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;

export const deleteAuthOrgRole = async (
    host: AdminHost,
    input: Parameters<LunoraClient["deleteAuthOrgRole"]>[0],
): ReturnType<LunoraClient["deleteAuthOrgRole"]> => {
    await host.adminFetch(AUTH_REMOVE_ROLE_PATH, "POST", input);
};

export const listAuthSessions = async (
    host: AdminHost,
    options: Parameters<LunoraClient["listAuthSessions"]>[0] = {},
): ReturnType<LunoraClient["listAuthSessions"]> => {
    host.assertOpen();

    const path = withQuery(AUTH_SESSIONS_PATH, { limit: options.limit, offset: options.offset, userId: options.userId });

    return (await host.adminFetch(path, "GET")) as AuthPage<AuthSession>;
};
