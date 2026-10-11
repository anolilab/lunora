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
import type { AuthCapabilities, AuthConfigInfo, AuthImpersonation, AuthPage, AuthSession, AuthUser } from "../types";
import type { AdminHost } from "./host";

export const listAuthUsers = async (
    host: AdminHost,
    options: {
        filterField?: string;
        filterValue?: string;
        limit?: number;
        offset?: number;
        search?: string;
        searchField?: string;
        sortBy?: string;
        sortDirection?: "asc" | "desc";
    } = {},
): Promise<AuthPage<AuthUser>> => {
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

export const createAuthUser = async (
    host: AdminHost,
    input: {
        data?: Record<string, unknown>;
        email: string;
        name: string;
        password?: string;
        role?: string | string[];
    },
): Promise<AuthUser> => (await host.adminFetch(AUTH_CREATE_USER_PATH, "POST", input)) as AuthUser;

export const setAuthUserRole = async (host: AdminHost, input: { role: string | string[]; userId: string }): Promise<AuthUser> =>
    (await host.adminFetch(AUTH_SET_ROLE_PATH, "POST", input)) as AuthUser;

export const banAuthUser = async (host: AdminHost, input: { expiresInSeconds?: number; reason?: string; userId: string }): Promise<AuthUser> =>
    (await host.adminFetch(AUTH_BAN_PATH, "POST", input)) as AuthUser;

export const unbanAuthUser = async (host: AdminHost, input: { userId: string }): Promise<AuthUser> =>
    (await host.adminFetch(AUTH_UNBAN_PATH, "POST", input)) as AuthUser;

export const setAuthUserPassword = async (host: AdminHost, input: { newPassword: string; userId: string }): Promise<void> => {
    await host.adminFetch(AUTH_SET_PASSWORD_PATH, "POST", input);
};

export const removeAuthUser = async (host: AdminHost, input: { userId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REMOVE_USER_PATH, "POST", input);
};

export const impersonateAuthUser = async (host: AdminHost, input: { userId: string }): Promise<AuthImpersonation> =>
    (await host.adminFetch(AUTH_IMPERSONATE_PATH, "POST", input)) as AuthImpersonation;

export const revokeAuthSession = async (host: AdminHost, input: { sessionId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REVOKE_SESSION_PATH, "POST", input);
};

export const revokeAuthUserSessions = async (host: AdminHost, input: { userId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REVOKE_SESSIONS_PATH, "POST", input);
};

export const getAuthCapabilities = async (host: AdminHost): Promise<AuthCapabilities> =>
    (await host.adminFetch(AUTH_CAPABILITIES_PATH, "GET")) as AuthCapabilities;

export const updateAuthUser = async (host: AdminHost, input: { data: Record<string, unknown>; userId: string }): Promise<AuthUser> =>
    (await host.adminFetch(AUTH_UPDATE_USER_PATH, "POST", input)) as AuthUser;

export const listAuthAccounts = async (host: AdminHost, input: { userId: string }): Promise<Record<string, unknown>[]> =>
    (await host.adminFetch(withQuery(AUTH_ACCOUNTS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];

export const unlinkAuthAccount = async (host: AdminHost, input: { accountId: string; userId: string }): Promise<void> => {
    await host.adminFetch(AUTH_UNLINK_ACCOUNT_PATH, "POST", input);
};

export const listAuthPasskeys = async (host: AdminHost, input: { userId: string }): Promise<Record<string, unknown>[]> =>
    (await host.adminFetch(withQuery(AUTH_PASSKEYS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];

export const deleteAuthPasskey = async (host: AdminHost, input: { passkeyId: string }): Promise<void> => {
    await host.adminFetch(AUTH_DELETE_PASSKEY_PATH, "POST", input);
};

export const disableAuthTwoFactor = async (host: AdminHost, input: { userId: string }): Promise<void> => {
    await host.adminFetch(AUTH_DISABLE_2FA_PATH, "POST", input);
};

export const listAuthOrganizations = async (host: AdminHost, options: { limit?: number; offset?: number } = {}): Promise<AuthPage<Record<string, unknown>>> =>
    (await host.adminFetch(withQuery(AUTH_ORGS_PATH, { limit: options.limit, offset: options.offset }), "GET")) as AuthPage<Record<string, unknown>>;

export const listAuthOrgMembers = async (
    host: AdminHost,
    input: { limit?: number; offset?: number; organizationId: string },
): Promise<AuthPage<Record<string, unknown>>> => {
    const path = withQuery(AUTH_ORG_MEMBERS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const listAuthOrgInvitations = async (
    host: AdminHost,
    input: { limit?: number; offset?: number; organizationId: string },
): Promise<AuthPage<Record<string, unknown>>> => {
    const path = withQuery(AUTH_ORG_INVITATIONS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const listAuthSignUpInvitations = async (
    host: AdminHost,
    options: { limit?: number; offset?: number } = {},
): Promise<AuthPage<Record<string, unknown>>> => {
    const path = withQuery(AUTH_SIGN_UP_INVITATIONS_PATH, { limit: options.limit, offset: options.offset });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const createAuthSignUpInvitation = async (
    host: AdminHost,
    input: { email: string; expiresInSeconds?: number; invitedBy?: string },
): Promise<Record<string, unknown>> => (await host.adminFetch(AUTH_CREATE_SIGN_UP_INVITATION_PATH, "POST", input)) as Record<string, unknown>;

export const revokeAuthSignUpInvitation = async (host: AdminHost, input: { email: string }): Promise<void> => {
    await host.adminFetch(AUTH_REVOKE_SIGN_UP_INVITATION_PATH, "POST", input);
};

export const removeAuthOrgMember = async (host: AdminHost, input: { memberId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REMOVE_MEMBER_PATH, "POST", input);
};

export const cancelAuthOrgInvitation = async (host: AdminHost, input: { invitationId: string }): Promise<void> => {
    await host.adminFetch(AUTH_CANCEL_INVITATION_PATH, "POST", input);
};

export const getAuthConfig = async (host: AdminHost): Promise<AuthConfigInfo> => (await host.adminFetch(AUTH_CONFIG_PATH, "GET")) as AuthConfigInfo;

export const createAuthOrganization = async (
    host: AdminHost,
    input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name: string;
        ownerId?: string;
        slug?: string;
    },
): Promise<Record<string, unknown>> => (await host.adminFetch(AUTH_CREATE_ORG_PATH, "POST", input)) as Record<string, unknown>;

export const updateAuthOrganization = async (
    host: AdminHost,
    input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name?: string;
        organizationId: string;
        slug?: string;
    },
): Promise<Record<string, unknown>> => (await host.adminFetch(AUTH_UPDATE_ORG_PATH, "POST", input)) as Record<string, unknown>;

export const deleteAuthOrganization = async (host: AdminHost, input: { organizationId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REMOVE_ORG_PATH, "POST", input);
};

export const addAuthOrgMember = async (host: AdminHost, input: { organizationId: string; role?: string; userId: string }): Promise<Record<string, unknown>> =>
    (await host.adminFetch(AUTH_ADD_MEMBER_PATH, "POST", input)) as Record<string, unknown>;

export const inviteAuthOrgMember = async (
    host: AdminHost,
    input: { email: string; inviterId?: string; organizationId: string; role?: string },
): Promise<Record<string, unknown>> => (await host.adminFetch(AUTH_INVITE_MEMBER_PATH, "POST", input)) as Record<string, unknown>;

export const setAuthOrgMemberRole = async (host: AdminHost, input: { memberId: string; role: string | string[] }): Promise<Record<string, unknown>> =>
    (await host.adminFetch(AUTH_MEMBER_ROLE_PATH, "POST", input)) as Record<string, unknown>;

export const listAuthOrgTeams = async (
    host: AdminHost,
    input: { limit?: number; offset?: number; organizationId: string },
): Promise<AuthPage<Record<string, unknown>>> => {
    const path = withQuery(AUTH_ORG_TEAMS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const createAuthOrgTeam = async (host: AdminHost, input: { name: string; organizationId: string }): Promise<Record<string, unknown>> =>
    (await host.adminFetch(AUTH_CREATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;

export const updateAuthOrgTeam = async (host: AdminHost, input: { name: string; teamId: string }): Promise<Record<string, unknown>> =>
    (await host.adminFetch(AUTH_UPDATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;

export const removeAuthOrgTeam = async (host: AdminHost, input: { teamId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REMOVE_TEAM_PATH, "POST", input);
};

export const listAuthOrgTeamMembers = async (
    host: AdminHost,
    input: { limit?: number; offset?: number; teamId: string },
): Promise<AuthPage<Record<string, unknown>>> => {
    const path = withQuery(AUTH_ORG_TEAM_MEMBERS_PATH, { limit: input.limit, offset: input.offset, teamId: input.teamId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const addAuthOrgTeamMember = async (host: AdminHost, input: { teamId: string; userId: string }): Promise<Record<string, unknown>> =>
    (await host.adminFetch(AUTH_ADD_TEAM_MEMBER_PATH, "POST", input)) as Record<string, unknown>;

export const removeAuthOrgTeamMember = async (host: AdminHost, input: { teamMemberId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REMOVE_TEAM_MEMBER_PATH, "POST", input);
};

export const listAuthOrgRoles = async (
    host: AdminHost,
    input: { limit?: number; offset?: number; organizationId: string },
): Promise<AuthPage<Record<string, unknown>>> => {
    const path = withQuery(AUTH_ORG_ROLES_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

    return (await host.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
};

export const createAuthOrgRole = async (
    host: AdminHost,
    input: { organizationId: string; permission: Record<string, string[]>; role: string },
): Promise<Record<string, unknown>> => (await host.adminFetch(AUTH_CREATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;

export const updateAuthOrgRole = async (host: AdminHost, input: { permission: Record<string, string[]>; roleId: string }): Promise<Record<string, unknown>> =>
    (await host.adminFetch(AUTH_UPDATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;

export const deleteAuthOrgRole = async (host: AdminHost, input: { roleId: string }): Promise<void> => {
    await host.adminFetch(AUTH_REMOVE_ROLE_PATH, "POST", input);
};

export const listAuthSessions = async (host: AdminHost, options: { limit?: number; offset?: number; userId?: string } = {}): Promise<AuthPage<AuthSession>> => {
    host.assertOpen();

    const path = withQuery(AUTH_SESSIONS_PATH, { limit: options.limit, offset: options.offset, userId: options.userId });

    return (await host.adminFetch(path, "GET")) as AuthPage<AuthSession>;
};
