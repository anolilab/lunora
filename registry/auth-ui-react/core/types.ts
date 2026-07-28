/**
 * Framework-agnostic core types for the Lunora auth UI.
 *
 * These types are shared verbatim across every framework port (React, Vue,
 * Svelte, Solid, Angular). Nothing here imports a UI framework — controllers are
 * plain state machines driven by an external-store `subscribe`/`getState`
 * contract that each framework adapts to its own reactivity primitive.
 */

/** The result shape of a better-auth client call (`{ data, error }`). */
interface AuthFetchError {
    code?: string;
    message?: string;
    status?: number;
    statusText?: string;
}

interface AuthResponse<T = unknown> {
    data: T | null;
    error: AuthFetchError | null;
}

/** The authenticated user (loosely typed — the UI reads a handful of fields). */
interface AuthUser {
    email?: string;
    emailVerified?: boolean;
    id?: string;
    image?: string;
    name?: string;
}

/** One active session row, as `listSessions` returns it. */
interface AuthSession {
    createdAt?: string;
    id?: string;
    ipAddress?: string;
    token?: string;
    userAgent?: string;
}

/** An organization the user belongs to. */
interface AuthOrganization {
    id?: string;
    logo?: string;
    name?: string;
    slug?: string;
}

/** A member of an organization. */
interface AuthMember {
    id?: string;
    role?: string;
    user?: { email?: string; name?: string };
    userId?: string;
}

/** A pending invitation to an organization. */
interface AuthInvitation {
    email?: string;
    id?: string;
    role?: string;
    status?: string;
}

/**
 * An invitation as the *invitee* sees it — `getInvitation` / `listUserInvitations`
 * join the organization name in, which a bare {@link AuthInvitation} lacks.
 */
interface AuthInvitationDetail extends AuthInvitation {
    expiresAt?: Date | string;
    inviterEmail?: string;
    organizationName?: string;
    organizationSlug?: string;
}

/** An organization with its members + pending invitations (from `getFullOrganization`). */
interface AuthFullOrganization extends AuthOrganization {
    invitations?: AuthInvitation[];
    members?: AuthMember[];
}

/** One linked OAuth/credential account, as `listAccounts` returns it. */
interface AuthAccount {
    accountId?: string;
    createdAt?: Date | string;
    id?: string;
    providerId?: string;
    scopes?: string[];
}

/** One signed-in account held by the multi-session plugin. */
interface AuthDeviceSession {
    session?: AuthSession;
    user?: AuthUser;
}

/** A user row from the admin plugin's `listUsers`. */
interface AuthAdminUser extends AuthUser {
    banExpires?: Date | string;
    banned?: boolean;
    banReason?: string;
    createdAt?: Date | string;
    role?: string;
}

/** A team inside an organization. */
interface AuthTeam {
    id?: string;
    name?: string;
    organizationId?: string;
}

/** The device-authorization record a user approves or denies by code. */
interface AuthDeviceRequest {
    clientId?: string;
    scope?: string;
    userCode?: string;
}

/** One registered passkey, as `listUserPasskeys` returns it. */
interface AuthPasskey {
    createdAt?: Date | string;
    deviceType?: string;
    id?: string;
    name?: string;
}

/** A resolved session payload (loosely typed — the UI only reads a couple of fields). */
interface SessionData {
    session?: AuthSession;

    token?: string;

    /**
     * Set by the two-factor plugin when the password was right but a second
     * factor is required. It arrives as a **success** payload with no session.
     */
    twoFactorRedirect?: boolean;
    user?: AuthUser;
}

/**
 * What a consumer actually passes to `&lt;AuthUIProvider>`.
 *
 * Deliberately almost-empty. A real better-auth client's type contains only the
 * plugins it was built with — a client without `adminClient()` has no
 * `.admin` — so requiring the full `AuthClient` surface made every app cast
 * (`authClient as never`), which is worse than no typing at all: that cast also
 * silences the mistakes worth catching.
 *
 * `getSession` is the one method every better-auth client has regardless of
 * configuration, so it is the only thing asserted here. `resolveContext`
 * narrows once, at the boundary; see the note there for why that is sound.
 */
interface AnyAuthClient {
    getSession: (...args: never[]) => unknown;
}

/**
 * The minimal better-auth client surface the core-auth controllers call. Written
 * by hand (rather than importing better-auth's inferred client type, which is
 * `any`-wide and non-portable) so `@lunora/auth-ui` type-checks cleanly. Later
 * phases extend this with the `organization` / `apiKey` / `passkey` namespaces.
 */
interface AuthClient {
    /** The `admin` plugin. */
    admin: {
        banUser: (input: { banExpiresIn?: number; banReason?: string; userId: string }) => Promise<AuthResponse<{ user?: AuthAdminUser }>>;
        impersonateUser: (input: { userId: string }) => Promise<AuthResponse<SessionData>>;
        listUsers: (input?: {
            query?: { limit?: number; offset?: number; searchField?: string; searchOperator?: string; searchValue?: string };
        }) => Promise<AuthResponse<{ total?: number; users?: AuthAdminUser[] } | AuthAdminUser[]>>;
        removeUser: (input: { userId: string }) => Promise<AuthResponse<{ success?: boolean }>>;
        setRole: (input: { role: string; userId: string }) => Promise<AuthResponse<{ user?: AuthAdminUser }>>;
        stopImpersonating: () => Promise<AuthResponse<SessionData>>;
        unbanUser: (input: { userId: string }) => Promise<AuthResponse<{ user?: AuthAdminUser }>>;
    };
    changeEmail: (input: { callbackURL?: string; newEmail: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    changePassword: (input: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean }) => Promise<AuthResponse<{ status?: boolean }>>;
    deleteUser: (input: { callbackURL?: string; password?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    /** The `device-authorization` plugin (the browser half — approve/deny a device code). */
    device: {
        approve: (input: { userCode: string }) => Promise<AuthResponse<{ success?: boolean }>>;
        deny: (input: { userCode: string }) => Promise<AuthResponse<{ success?: boolean }>>;
    };
    emailOtp: {
        sendVerificationOtp: (input: {
            email: string;
            type: "email-verification" | "forget-password" | "sign-in";
        }) => Promise<AuthResponse<{ success?: boolean }>>;
    };
    forgetPassword: (input: { email: string; redirectTo?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    getSession: () => Promise<AuthResponse<SessionData>>;
    /** Core account linking (`/list-accounts`, `/link-social`, `/unlink-account`). */
    linkSocial: (input: { callbackURL?: string; provider: string }) => Promise<AuthResponse<{ redirect?: boolean; url?: string }>>;
    listAccounts: () => Promise<AuthResponse<AuthAccount[]>>;
    listSessions: () => Promise<AuthResponse<AuthSession[]>>;
    /** The `multi-session` plugin. */
    multiSession: {
        listDeviceSessions: () => Promise<AuthResponse<AuthDeviceSession[]>>;
        revoke: (input: { sessionToken: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        setActive: (input: { sessionToken: string }) => Promise<AuthResponse<SessionData>>;
    };
    oneTap: (input?: { callbackURL?: string }) => Promise<AuthResponse<SessionData>>;
    organization: {
        acceptInvitation: (input: { invitationId: string }) => Promise<AuthResponse<{ invitation?: AuthInvitation; member?: AuthMember }>>;
        cancelInvitation: (input: { invitationId: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        create: (input: { name: string; slug: string }) => Promise<AuthResponse<AuthOrganization>>;
        createTeam: (input: { name: string; organizationId?: string }) => Promise<AuthResponse<AuthTeam>>;
        delete: (input: { organizationId: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        getFullOrganization: (input?: { organizationId?: string }) => Promise<AuthResponse<AuthFullOrganization>>;
        getInvitation: (input: { query: { id: string } }) => Promise<AuthResponse<AuthInvitationDetail>>;
        inviteMember: (input: { email: string; organizationId?: string; role: string; teamId?: string }) => Promise<AuthResponse<AuthInvitation>>;
        leave: (input: { organizationId: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        list: () => Promise<AuthResponse<AuthOrganization[]>>;
        listTeams: (input?: { query?: { organizationId?: string } }) => Promise<AuthResponse<AuthTeam[]>>;
        listUserInvitations: () => Promise<AuthResponse<AuthInvitationDetail[]>>;
        rejectInvitation: (input: { invitationId: string }) => Promise<AuthResponse<{ invitation?: AuthInvitation }>>;
        removeMember: (input: { memberIdOrEmail: string; organizationId?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        removeTeam: (input: { organizationId?: string; teamId: string }) => Promise<AuthResponse<{ message?: string }>>;
        setActive: (input: { organizationId: string }) => Promise<AuthResponse<AuthOrganization>>;
        update: (input: { data: { logo?: string; name?: string; slug?: string }; organizationId?: string }) => Promise<AuthResponse<AuthOrganization>>;
        updateMemberRole: (input: { memberId: string; organizationId?: string; role: string }) => Promise<AuthResponse<AuthMember>>;
        updateTeam: (input: { data: { name?: string }; teamId: string }) => Promise<AuthResponse<AuthTeam>>;
    };
    /** The `@better-auth/passkey` plugin (a separate package from better-auth core). */
    passkey: {
        addPasskey: (input?: { authenticatorAttachment?: "cross-platform" | "platform"; name?: string }) => Promise<AuthResponse | undefined>;
        deletePasskey: (input: { id: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        listUserPasskeys: () => Promise<AuthResponse<AuthPasskey[]>>;
        updatePasskey: (input: { id: string; name: string }) => Promise<AuthResponse<AuthPasskey>>;
    };
    /** The `phone-number` plugin. */
    phoneNumber: {
        requestPasswordReset: (input: { phoneNumber: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        resetPassword: (input: { newPassword: string; otp: string; phoneNumber: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        sendOtp: (input: { phoneNumber: string }) => Promise<AuthResponse<{ code?: string; message?: string }>>;
        verify: (input: { code: string; disableSession?: boolean; phoneNumber: string; updatePhoneNumber?: boolean }) => Promise<AuthResponse<SessionData>>;
    };
    resetPassword: (input: { newPassword: string; token?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    revokeOtherSessions: () => Promise<AuthResponse<{ status?: boolean }>>;
    revokeSession: (input: { token: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    sendVerificationEmail: (input: { callbackURL?: string; email: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    signIn: {
        anonymous: () => Promise<AuthResponse<SessionData>>;
        email: (input: { callbackURL?: string; email: string; password: string; rememberMe?: boolean }) => Promise<AuthResponse<SessionData>>;
        emailOtp: (input: { email: string; otp: string }) => Promise<AuthResponse<SessionData>>;
        magicLink: (input: { callbackURL?: string; email: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        phoneNumber: (input: { password: string; phoneNumber: string; rememberMe?: boolean }) => Promise<AuthResponse<SessionData>>;
        social: (input: { callbackURL?: string; provider: string }) => Promise<AuthResponse<{ redirect?: boolean; url?: string }>>;
        username: (input: { password: string; rememberMe?: boolean; username: string }) => Promise<AuthResponse<SessionData>>;
    };
    signOut: () => Promise<AuthResponse<{ success?: boolean }>>;
    signUp: {
        email: (input: { callbackURL?: string; email: string; name: string; password: string; username?: string }) => Promise<AuthResponse<SessionData>>;
    };
    twoFactor: {
        disable: (input: { password: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        enable: (input: { password: string }) => Promise<AuthResponse<{ backupCodes: string[]; totpURI: string }>>;
        generateBackupCodes: (input: { password: string }) => Promise<AuthResponse<{ backupCodes?: string[]; status?: boolean }>>;
        verifyBackupCode: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
        verifyOtp: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
        verifyTotp: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
    };
    unlinkAccount: (input: { accountId?: string; providerId: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    updateUser: (input: { image?: string; name?: string; username?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    verifyEmail: (input: { query: { token: string } }) => Promise<AuthResponse<{ status?: boolean; user?: AuthUser }>>;
}

/** The lifecycle status of a flow. */
type FlowStatus = "error" | "idle" | "submitting" | "success";

/** Per-field state exposed to the view layer. */
interface FieldState {
    error?: string;
    touched: boolean;
    value: string;
}

/** The full observable state of a form-style controller. */
interface FormState<TField extends string> {
    fields: Record<TField, FieldState>;
    /** A top-level error not tied to a single field (mapped via `mapAuthError`). */
    formError?: string;
    /** A `prefill` is in flight. Always false for flows that start empty. */
    loading: boolean;
    status: FlowStatus;
    /** A human-readable success line (e.g. "Check your email"). */
    successMessage?: string;
}

/** Actions every form controller exposes to its view. */
interface FormActions<TField extends string> {
    blur: (field: TField) => void;
    /** Re-run the flow's `prefill`; a no-op for flows that start empty. */
    load: () => Promise<void>;
    reset: () => void;
    setField: (field: TField, value: string) => void;
    submit: () => Promise<void>;
}

/**
 * The external-store contract every controller implements.
 *
 * `destroy()` means **release subscribers** — it must not push a blanked state
 * at views that are about to unmount. Frameworks wrap this:
 * React `useSyncExternalStore(subscribe, getState)`, Vue `shallowRef` +
 * `onScopeDispose`, Svelte `readable`, Solid `createStore`, Angular `signal`.
 */
interface Controller<TState, TActions> {
    actions: TActions;
    destroy: () => void;
    getState: () => TState;
    subscribe: (onChange: () => void) => () => void;
}

type FormController<TField extends string> = Controller<FormState<TField>, FormActions<TField>>;

export type {
    AnyAuthClient,
    AuthAccount,
    AuthAdminUser,
    AuthClient,
    AuthDeviceRequest,
    AuthDeviceSession,
    AuthFetchError,
    AuthFullOrganization,
    AuthInvitation,
    AuthInvitationDetail,
    AuthMember,
    AuthOrganization,
    AuthPasskey,
    AuthResponse,
    AuthSession,
    AuthTeam,
    AuthUser,
    Controller,
    FieldState,
    FlowStatus,
    FormActions,
    FormController,
    FormState,
    SessionData,
};
