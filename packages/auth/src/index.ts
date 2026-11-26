export type { LunoraD1AdapterOptions } from "./adapter";
export { lunoraAuthAdapter, lunoraD1Adapter, lunoraDoAdapter } from "./adapter";
export type {
    AuthAccount,
    AuthAdmin,
    AuthAdminSession,
    AuthAdminUser,
    AuthApiKey,
    AuthCapabilities,
    AuthConfigInfo,
    AuthInvitation,
    AuthMember,
    AuthOrganization,
    AuthOrgRole,
    AuthPage,
    AuthPasskey,
    AuthSignUpInvitation,
    AuthTeam,
    AuthTeamMember,
    AuthTimestamp,
    AuthUserFieldSpec,
    CreateAuthAdminOptions,
    ImpersonationResult,
    ListUsersOptions,
} from "./admin";
export { createAuthAdmin, LunoraAuthAdminError } from "./admin";
export type {
    AppendAuthAuditEntry,
    AppendAuthAuditOptions,
    AuthAuditEntry,
    AuthAuditEvent,
    AuthAuditOutcome,
    AuthAuditReader,
    AuthAuditWriter,
    ReadAuthAuditOptions,
} from "./audit";
export { appendAuthAuditEntry, AUTH_AUDIT_TABLE, createAuthAuditReader, createAuthAuditWriter, ensureAuthAuditTable, readAuthAuditLog } from "./audit";
export type { AuthAuditHookConfig } from "./audit-hooks";
export { authAuditBeforeHook, authAuditHook, buildAuditEntry, eventForPath, withAuthAudit } from "./audit-hooks";
export type { AuthDataSchema, PrepareAuthDataOptions } from "./auth-data";
export { prepareAuthData } from "./auth-data";
export type { AuthDoOptions, AuthDoState } from "./auth-do";
export {
    READ_AUDIT_PATH as AUTH_DO_AUDIT_PATH,
    INTERNAL_SECRET_HEADER as AUTH_DO_SECRET_HEADER,
    RESOLVE_SESSION_PATH as AUTH_DO_SESSION_PATH,
    LunoraAuthDO,
} from "./auth-do";
export type { AuthBackfillStatus, CanonicalEmailBackfillStatus } from "./backfill-status";
export { authBackfillStatus } from "./backfill-status";
export type { CanonicalEmailColumn, DuplicateRow } from "./canonical-email";
export { authCanonicalEmailColumn, canonicalEmail } from "./canonical-email";
export type { CookieCache } from "./cookie-cache";
export { effectiveCookieCache } from "./cookie-cache";
export type { LunoraAuth, LunoraAuthOptions } from "./create-auth";
export { createAuth, resolveAuthOptions } from "./create-auth";
export type { AuthDataPortLike, AuthImportResult, AuthReplaceResult } from "./data-port";
export { authCredentialColumns, authCredentialTableNames, authTableNames, createSqlAuthDataPort } from "./data-port";
export type { AuthDateConversion } from "./dates";
export { convertAuthDatesOnce, convertAuthDatesToEpochMs } from "./dates";
export { authDiscoveryPaths, authDiscoveryPathsFor, handleAuthDiscoveryRequest } from "./discovery";
export { authDoColumnAdditions, authDoSchemaStatements } from "./do-schema";
export type { AuthJurisdiction, AuthNamespaceLike, DoAuthWiring, DoAuthWiringOptions } from "./do-wiring";
export { createDoAuthWiring } from "./do-wiring";
export type { EmailGateHookConfig } from "./email-gate";
export { emailGateDatabaseHooks, withEmailGate } from "./email-gate";
export type { EmailClass, EmailClassification, EmailGateConfig, EmailGateMiddlewareOptions } from "./email-guard";
export { assertEmailAllowed, classifyEmail, emailGateMiddleware, loadEmailDomainLists } from "./email-guard";
export { default as isDevEnvironment } from "./environment";
export { DEFAULT_AUTH_BASE_PATH, handleAuthRequest } from "./handler";
export type { InviteOnlyOptions, IssuedSignUpInvitation, SignUpInvitation } from "./invite-only";
export { createSignUpInvitation, listSignUpInvitations, pruneSignUpInvitations, revokeSignUpInvitation } from "./invite-only";
export type { AuthJurisdictionMove, AuthMoveResult, AuthMoveTableReport } from "./jurisdiction-move";
export { legacyIssuerCleanupStatements } from "./legacy-issuer";
export type { LunoraAuthApiContext, WithAuthPluginsMiddleware, WithAuthPluginsOptions } from "./middleware";
export { LunoraAuthHeadersError, withAuthPlugins } from "./middleware";
export { default as authTables } from "./schema";
export type { SessionPolicy } from "./session";
export { sessionPresets, validateSessionPolicy } from "./session";
export type { SessionIdentity } from "./session-identity";
export { resolveSessionIdentity } from "./session-identity";
export type { SqlExecutor } from "./sql-store";
export { createSqlAuthStore, d1Executor } from "./sql-store";
export type { AuthQuery, AuthRow, AuthStore, AuthWhereClause } from "./store";
export { createMemoryAuthStore, matchesWhere } from "./store";
export type { FetchLike, TurnstileVerifyResult, VerifyTurnstileOptions } from "./turnstile";
export { TURNSTILE_VERIFY_ENDPOINT, verifyTurnstile } from "./turnstile";
export type { VerifyTurnstileMiddlewareOptions } from "./turnstile-middleware";
export { verifyTurnstileMiddleware } from "./turnstile-middleware";
