const RPC_PATH = "/_lunora/rpc";

const RPC_BATCH_PATH = "/_lunora/rpc-batch";

const WS_PATH = "/_lunora/ws";

const SHARD_TRAFFIC_PATH = "/_lunora/admin/shard-traffic";

const SCHEDULED_PATH = "/_lunora/admin/scheduled";

const SCHEDULED_STATUS_PATH = "/_lunora/admin/scheduled/status";

const SCHEDULED_WS_PATH = "/_lunora/admin/scheduled/ws";

const SCHEDULED_CANCEL_PATH = "/_lunora/admin/scheduled/cancel";

const SCHEDULED_DEAD_PATH = "/_lunora/admin/scheduled/dead";

const SCHEDULED_DEAD_RETRY_PATH = "/_lunora/admin/scheduled/dead/retry";

const SCHEDULED_DEAD_CANCEL_PATH = "/_lunora/admin/scheduled/dead/cancel";

const WORKFLOWS_INSTANCES_PATH = "/_lunora/admin/workflows/instances";

const WORKFLOWS_INSTANCE_PATH = "/_lunora/admin/workflows/instance";

const WORKFLOWS_STATUS_PATH = "/_lunora/admin/workflows/status";

const STORAGE_PATH = "/_lunora/admin/storage";

const STORAGE_URL_PATH = "/_lunora/admin/storage/url";

const STORAGE_BUCKETS_PATH = "/_lunora/admin/storage/buckets";

const FUNCTIONS_PATH = "/_lunora/admin/functions";

const CRON_JOBS_PATH = "/_lunora/admin/cron-jobs";

const CRON_JOBS_RUN_PATH = "/_lunora/admin/cron-jobs/run";

const ARCHITECTURE_PATH = "/_lunora/admin/architecture";

const OPENAPI_PATH = "/_lunora/admin/openapi";

const OPENRPC_PATH = "/_lunora/admin/openrpc";

const GLOBAL_TABLES_PATH = "/_lunora/admin/global/tables";

const GLOBAL_TABLE_PATH = "/_lunora/admin/global/table";

const GLOBAL_FACET_PATH = "/_lunora/admin/global/facet";

const VECTOR_INDEXES_PATH = "/_lunora/admin/vector/indexes";

const VECTOR_QUERY_PATH = "/_lunora/admin/vector/query";

const LOG_ARCHIVE_PATH = "/_lunora/admin/logs/archive";

const KV_NAMESPACES_PATH = "/_lunora/admin/kv/namespaces";

const KV_KEYS_PATH = "/_lunora/admin/kv/keys";

const KV_VALUE_PATH = "/_lunora/admin/kv/value";

const AUTH_USERS_PATH = "/_lunora/admin/auth/users";

const AUTH_SESSIONS_PATH = "/_lunora/admin/auth/sessions";

const AUTH_CREATE_USER_PATH = "/_lunora/admin/auth/users/create";

const AUTH_SET_ROLE_PATH = "/_lunora/admin/auth/users/role";

const AUTH_BAN_PATH = "/_lunora/admin/auth/users/ban";

const AUTH_UNBAN_PATH = "/_lunora/admin/auth/users/unban";

const AUTH_SET_PASSWORD_PATH = "/_lunora/admin/auth/users/password";

const AUTH_REMOVE_USER_PATH = "/_lunora/admin/auth/users/remove";

const AUTH_IMPERSONATE_PATH = "/_lunora/admin/auth/users/impersonate";

const AUTH_REVOKE_SESSION_PATH = "/_lunora/admin/auth/sessions/revoke";

const AUTH_REVOKE_SESSIONS_PATH = "/_lunora/admin/auth/sessions/revoke-all";

const AUTH_CAPABILITIES_PATH = "/_lunora/admin/auth/capabilities";

const AUTH_UPDATE_USER_PATH = "/_lunora/admin/auth/users/update";

const AUTH_ACCOUNTS_PATH = "/_lunora/admin/auth/accounts";

const AUTH_UNLINK_ACCOUNT_PATH = "/_lunora/admin/auth/accounts/unlink";

const AUTH_PASSKEYS_PATH = "/_lunora/admin/auth/passkeys";

const AUTH_DELETE_PASSKEY_PATH = "/_lunora/admin/auth/passkeys/delete";

const AUTH_DISABLE_2FA_PATH = "/_lunora/admin/auth/two-factor/disable";

const AUTH_ORGS_PATH = "/_lunora/admin/auth/organizations";

const AUTH_ORG_MEMBERS_PATH = "/_lunora/admin/auth/organizations/members";

const AUTH_ORG_INVITATIONS_PATH = "/_lunora/admin/auth/organizations/invitations";

const AUTH_REMOVE_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/remove";

const AUTH_CANCEL_INVITATION_PATH = "/_lunora/admin/auth/organizations/invitations/cancel";

const AUTH_CONFIG_PATH = "/_lunora/admin/auth/config";

const AUTH_SIGN_UP_INVITATIONS_PATH = "/_lunora/admin/auth/sign-up-invitations";

const AUTH_CREATE_SIGN_UP_INVITATION_PATH = "/_lunora/admin/auth/sign-up-invitations/create";

const AUTH_REVOKE_SIGN_UP_INVITATION_PATH = "/_lunora/admin/auth/sign-up-invitations/revoke";

const AUTH_CREATE_ORG_PATH = "/_lunora/admin/auth/organizations/create";

const AUTH_UPDATE_ORG_PATH = "/_lunora/admin/auth/organizations/update";

const AUTH_REMOVE_ORG_PATH = "/_lunora/admin/auth/organizations/remove";

const AUTH_ADD_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/add";

const AUTH_INVITE_MEMBER_PATH = "/_lunora/admin/auth/organizations/members/invite";

const AUTH_MEMBER_ROLE_PATH = "/_lunora/admin/auth/organizations/members/role";

const AUTH_ORG_TEAMS_PATH = "/_lunora/admin/auth/organizations/teams";

const AUTH_CREATE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/create";

const AUTH_UPDATE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/update";

const AUTH_REMOVE_TEAM_PATH = "/_lunora/admin/auth/organizations/teams/remove";

const AUTH_ORG_TEAM_MEMBERS_PATH = "/_lunora/admin/auth/organizations/teams/members";

const AUTH_ADD_TEAM_MEMBER_PATH = "/_lunora/admin/auth/organizations/teams/members/add";

const AUTH_REMOVE_TEAM_MEMBER_PATH = "/_lunora/admin/auth/organizations/teams/members/remove";

const AUTH_ORG_ROLES_PATH = "/_lunora/admin/auth/organizations/roles";

const AUTH_CREATE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/create";

const AUTH_UPDATE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/update";

const AUTH_REMOVE_ROLE_PATH = "/_lunora/admin/auth/organizations/roles/remove";

/**
 * Default better-auth session endpoint. The worker mounts better-auth at
 * `/api/auth` (see `@lunora/auth`'s `DEFAULT_AUTH_BASE_PATH`); `get-session`
 * is the better-auth route that returns the current `{ user, session }` (or
 * `null` when signed out). Override the base via `LunoraClientOptions.authBasePath`.
 */
const DEFAULT_AUTH_BASE_PATH = "/api/auth";

const GET_SESSION_PATH = "/get-session";

/**
 * Keepalive frame sent on the heartbeat. MUST match the request payload the
 * server registers via `setWebSocketAutoResponse` (`@lunora/do`'s ShardDO
 * `WS_KEEPALIVE_PING`): the runtime answers it with `lunora-pong` WITHOUT
 * waking the Durable Object. The pong is a plain (non-JSON) string and is
 * silently dropped by `handleServerMessage`'s `JSON.parse` guard.
 */
const WS_KEEPALIVE_PING = "lunora-ping";

export {
    ARCHITECTURE_PATH,
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
    CRON_JOBS_PATH,
    CRON_JOBS_RUN_PATH,
    DEFAULT_AUTH_BASE_PATH,
    FUNCTIONS_PATH,
    GET_SESSION_PATH,
    GLOBAL_FACET_PATH,
    GLOBAL_TABLE_PATH,
    GLOBAL_TABLES_PATH,
    KV_KEYS_PATH,
    KV_NAMESPACES_PATH,
    KV_VALUE_PATH,
    LOG_ARCHIVE_PATH,
    OPENAPI_PATH,
    OPENRPC_PATH,
    RPC_BATCH_PATH,
    RPC_PATH,
    SCHEDULED_CANCEL_PATH,
    SCHEDULED_DEAD_CANCEL_PATH,
    SCHEDULED_DEAD_PATH,
    SCHEDULED_DEAD_RETRY_PATH,
    SCHEDULED_PATH,
    SCHEDULED_STATUS_PATH,
    SCHEDULED_WS_PATH,
    SHARD_TRAFFIC_PATH,
    STORAGE_BUCKETS_PATH,
    STORAGE_PATH,
    STORAGE_URL_PATH,
    VECTOR_INDEXES_PATH,
    VECTOR_QUERY_PATH,
    WORKFLOWS_INSTANCE_PATH,
    WORKFLOWS_INSTANCES_PATH,
    WORKFLOWS_STATUS_PATH,
    WS_KEEPALIVE_PING,
    WS_PATH,
};
