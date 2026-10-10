export const RPC_PATH = "/_lunora/rpc";

export const RPC_BATCH_PATH = "/_lunora/rpc-batch";

export const WS_PATH = "/_lunora/ws";

export const SHARD_TRAFFIC_PATH = "/_lunora/admin/shard-traffic";

export const SCHEDULED_PATH = "/_lunora/admin/scheduled";

export const SCHEDULED_STATUS_PATH = "/_lunora/admin/scheduled/status";

export const SCHEDULED_WS_PATH = "/_lunora/admin/scheduled/ws";

export const SCHEDULED_CANCEL_PATH = "/_lunora/admin/scheduled/cancel";

export const SCHEDULED_DEAD_PATH = "/_lunora/admin/scheduled/dead";

export const SCHEDULED_DEAD_RETRY_PATH = "/_lunora/admin/scheduled/dead/retry";

export const SCHEDULED_DEAD_CANCEL_PATH = "/_lunora/admin/scheduled/dead/cancel";

export const WORKFLOWS_INSTANCES_PATH = "/_lunora/admin/workflows/instances";

export const WORKFLOWS_INSTANCE_PATH = "/_lunora/admin/workflows/instance";

export const WORKFLOWS_STATUS_PATH = "/_lunora/admin/workflows/status";

export const STORAGE_PATH = "/_lunora/admin/storage";

export const STORAGE_URL_PATH = "/_lunora/admin/storage/url";

export const STORAGE_BUCKETS_PATH = "/_lunora/admin/storage/buckets";

export const FUNCTIONS_PATH = "/_lunora/admin/functions";

export const CRON_JOBS_PATH = "/_lunora/admin/cron-jobs";

export const CRON_JOBS_RUN_PATH = "/_lunora/admin/cron-jobs/run";

export const ARCHITECTURE_PATH = "/_lunora/admin/architecture";

export const OPENAPI_PATH = "/_lunora/admin/openapi";

export const OPENRPC_PATH = "/_lunora/admin/openrpc";

export const GLOBAL_TABLES_PATH = "/_lunora/admin/global/tables";

export const GLOBAL_TABLE_PATH = "/_lunora/admin/global/table";

export const GLOBAL_FACET_PATH = "/_lunora/admin/global/facet";

export const VECTOR_INDEXES_PATH = "/_lunora/admin/vector/indexes";

export const VECTOR_QUERY_PATH = "/_lunora/admin/vector/query";

export const LOG_ARCHIVE_PATH = "/_lunora/admin/logs/archive";

export const KV_NAMESPACES_PATH = "/_lunora/admin/kv/namespaces";

export const KV_KEYS_PATH = "/_lunora/admin/kv/keys";

export const KV_VALUE_PATH = "/_lunora/admin/kv/value";

export const AUTH_USERS_PATH = "/_lunora/admin/auth/users";

export const AUTH_SESSIONS_PATH = "/_lunora/admin/auth/sessions";

export const AUTH_CREATE_USER_PATH = "/_lunora/admin/auth/users/create";

export const AUTH_SET_ROLE_PATH = "/_lunora/admin/auth/users/role";

export const AUTH_BAN_PATH = "/_lunora/admin/auth/users/ban";

export const AUTH_UNBAN_PATH = "/_lunora/admin/auth/users/unban";

export const AUTH_SET_PASSWORD_PATH = "/_lunora/admin/auth/users/password";

export const AUTH_REMOVE_USER_PATH = "/_lunora/admin/auth/users/remove";

export const AUTH_IMPERSONATE_PATH = "/_lunora/admin/auth/users/impersonate";

export const AUTH_REVOKE_SESSION_PATH = "/_lunora/admin/auth/sessions/revoke";

export const AUTH_REVOKE_SESSIONS_PATH = "/_lunora/admin/auth/sessions/revoke-all";

export const AUTH_CAPABILITIES_PATH = "/_lunora/admin/auth/capabilities";

export const AUTH_UPDATE_USER_PATH = "/_lunora/admin/auth/users/update";

export const AUTH_ACCOUNTS_PATH = "/_lunora/admin/auth/accounts";

export const AUTH_UNLINK_ACCOUNT_PATH = "/_lunora/admin/auth/accounts/unlink";

export const AUTH_PASSKEYS_PATH = "/_lunora/admin/auth/passkeys";

export const AUTH_DELETE_PASSKEY_PATH = "/_lunora/admin/auth/passkeys/delete";

export const AUTH_DISABLE_2FA_PATH = "/_lunora/admin/auth/two-factor/disable";

export const AUTH_ORGS_PATH = "/_lunora/admin/auth/organizations";

export const AUTH_ORG_MEMBERS_PATH = "/_lunora/admin/auth/organizations/members";

export const AUTH_ORG_INVITATIONS_PATH = "/_lunora/admin/auth/organizations/invitations";

export const AUTH_REMOVE_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/remove";

export const AUTH_CANCEL_INVITATION_PATH = "/_lunora/admin/auth/organizations/invitations/cancel";

export const AUTH_CONFIG_PATH = "/_lunora/admin/auth/config";

export const AUTH_SIGN_UP_INVITATIONS_PATH = "/_lunora/admin/auth/sign-up-invitations";

export const AUTH_CREATE_SIGN_UP_INVITATION_PATH = "/_lunora/admin/auth/sign-up-invitations/create";

export const AUTH_REVOKE_SIGN_UP_INVITATION_PATH = "/_lunora/admin/auth/sign-up-invitations/revoke";

export const AUTH_CREATE_ORG_PATH = "/_lunora/admin/auth/organizations/create";

export const AUTH_UPDATE_ORG_PATH = "/_lunora/admin/auth/organizations/update";

export const AUTH_REMOVE_ORG_PATH = "/_lunora/admin/auth/organizations/remove";

export const AUTH_ADD_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/add";

export const AUTH_INVITE_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/invite";

export const AUTH_MEMBER_ROLE_PATH = "/_lunora/admin/auth/organizations/members/role";

export const AUTH_ORG_TEAMS_PATH = "/_lunora/admin/auth/organizations/teams";

export const AUTH_CREATE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/create";

export const AUTH_UPDATE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/update";

export const AUTH_REMOVE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/remove";

export const AUTH_ORG_TEAM_MEMBERS_PATH = "/_lunora/admin/auth/organizations/teams/members";

export const AUTH_ADD_TEAM_MEMBER_PATH = "/_lunora/admin/auth/organizations/teams/members/add";

export const AUTH_REMOVE_TEAM_MEMBER_PATH = "/_lunora/admin/auth/organizations/teams/members/remove";

export const AUTH_ORG_ROLES_PATH = "/_lunora/admin/auth/organizations/roles";

export const AUTH_CREATE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/create";

export const AUTH_UPDATE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/update";

export const AUTH_REMOVE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/remove";

/**
 * Default better-auth session endpoint. The worker mounts better-auth at
 * `/api/auth` (see `@lunora/auth`'s `DEFAULT_AUTH_BASE_PATH`); `get-session`
 * is the better-auth route that returns the current `{ user, session }` (or
 * `null` when signed out). Override the base via `LunoraClientOptions.authBasePath`.
 */
export const DEFAULT_AUTH_BASE_PATH = "/api/auth";

export const GET_SESSION_PATH = "/get-session";
