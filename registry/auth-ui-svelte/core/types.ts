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

/** An organization with its members + pending invitations (from `getFullOrganization`). */
interface AuthFullOrganization extends AuthOrganization {
    invitations?: AuthInvitation[];
    members?: AuthMember[];
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
 * The minimal better-auth client surface the core-auth controllers call. Written
 * by hand (rather than importing better-auth's inferred client type, which is
 * `any`-wide and non-portable) so `@lunora/auth-ui` type-checks cleanly. Later
 * phases extend this with the `organization` / `apiKey` / `passkey` namespaces.
 */
interface AuthClient {
    changeEmail: (input: { callbackURL?: string; newEmail: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    changePassword: (input: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean }) => Promise<AuthResponse<{ status?: boolean }>>;
    deleteUser: (input: { callbackURL?: string; password?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    emailOtp: {
        sendVerificationOtp: (input: {
            email: string;
            type: "email-verification" | "forget-password" | "sign-in";
        }) => Promise<AuthResponse<{ success?: boolean }>>;
    };
    forgetPassword: (input: { email: string; redirectTo?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    getSession: () => Promise<AuthResponse<SessionData>>;
    listSessions: () => Promise<AuthResponse<AuthSession[]>>;
    organization: {
        cancelInvitation: (input: { invitationId: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        create: (input: { name: string; slug: string }) => Promise<AuthResponse<AuthOrganization>>;
        delete: (input: { organizationId: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        getFullOrganization: (input?: { organizationId?: string }) => Promise<AuthResponse<AuthFullOrganization>>;
        inviteMember: (input: { email: string; organizationId?: string; role: string }) => Promise<AuthResponse<AuthInvitation>>;
        list: () => Promise<AuthResponse<AuthOrganization[]>>;
        removeMember: (input: { memberIdOrEmail: string; organizationId?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        setActive: (input: { organizationId: string }) => Promise<AuthResponse<AuthOrganization>>;
        update: (input: { data: { logo?: string; name?: string; slug?: string }; organizationId?: string }) => Promise<AuthResponse<AuthOrganization>>;
        updateMemberRole: (input: { memberId: string; organizationId?: string; role: string }) => Promise<AuthResponse<AuthMember>>;
    };
    /** The `@better-auth/passkey` plugin (a separate package from better-auth core). */
    passkey: {
        addPasskey: (input?: { authenticatorAttachment?: "cross-platform" | "platform"; name?: string }) => Promise<AuthResponse | undefined>;
        deletePasskey: (input: { id: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        listUserPasskeys: () => Promise<AuthResponse<AuthPasskey[]>>;
        updatePasskey: (input: { id: string; name: string }) => Promise<AuthResponse<AuthPasskey>>;
    };
    resetPassword: (input: { newPassword: string; token?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    revokeOtherSessions: () => Promise<AuthResponse<{ status?: boolean }>>;
    revokeSession: (input: { token: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    signIn: {
        email: (input: { callbackURL?: string; email: string; password: string; rememberMe?: boolean }) => Promise<AuthResponse<SessionData>>;
        emailOtp: (input: { email: string; otp: string }) => Promise<AuthResponse<SessionData>>;
        magicLink: (input: { callbackURL?: string; email: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        social: (input: { callbackURL?: string; provider: string }) => Promise<AuthResponse<{ redirect?: boolean; url?: string }>>;
    };
    signOut: () => Promise<AuthResponse<{ success?: boolean }>>;
    signUp: {
        email: (input: { callbackURL?: string; email: string; name: string; password: string }) => Promise<AuthResponse<SessionData>>;
    };
    twoFactor: {
        disable: (input: { password: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        enable: (input: { password: string }) => Promise<AuthResponse<{ backupCodes: string[]; totpURI: string }>>;
        verifyOtp: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
        verifyTotp: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
    };
    updateUser: (input: { image?: string; name?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
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
    status: FlowStatus;
    /** A human-readable success line (e.g. "Check your email"). */
    successMessage?: string;
}

/** Actions every form controller exposes to its view. */
interface FormActions<TField extends string> {
    blur: (field: TField) => void;
    reset: () => void;
    setField: (field: TField, value: string) => void;
    submit: () => Promise<void>;
}

/**
 * The external-store contract every controller implements. Frameworks wrap this:
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
    AuthClient,
    AuthFetchError,
    AuthFullOrganization,
    AuthInvitation,
    AuthMember,
    AuthOrganization,
    AuthPasskey,
    AuthResponse,
    AuthSession,
    AuthUser,
    Controller,
    FieldState,
    FlowStatus,
    FormActions,
    FormController,
    FormState,
    SessionData,
};
