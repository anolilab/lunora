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

/** A resolved session payload (loosely typed — the UI only reads a couple of fields). */
interface SessionData {
    token?: string;
    user?: { email?: string; id?: string; name?: string };
}

/**
 * The minimal better-auth client surface the core-auth controllers call. Written
 * by hand (rather than importing better-auth's inferred client type, which is
 * `any`-wide and non-portable) so `@lunora/auth-ui` type-checks cleanly. Later
 * phases extend this with the `organization` / `apiKey` / `passkey` namespaces.
 */
interface AuthClient {
    emailOtp: {
        sendVerificationOtp: (input: {
            email: string;
            type: "email-verification" | "forget-password" | "sign-in";
        }) => Promise<AuthResponse<{ success?: boolean }>>;
    };
    forgetPassword: (input: { email: string; redirectTo?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    resetPassword: (input: { newPassword: string; token?: string }) => Promise<AuthResponse<{ status?: boolean }>>;
    signIn: {
        email: (input: { callbackURL?: string; email: string; password: string; rememberMe?: boolean }) => Promise<AuthResponse<SessionData>>;
        emailOtp: (input: { email: string; otp: string }) => Promise<AuthResponse<SessionData>>;
        magicLink: (input: { callbackURL?: string; email: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        social: (input: { callbackURL?: string; provider: string }) => Promise<AuthResponse<{ redirect?: boolean; url?: string }>>;
    };
    signUp: {
        email: (input: { callbackURL?: string; email: string; name: string; password: string }) => Promise<AuthResponse<SessionData>>;
    };
    twoFactor: {
        disable: (input: { password: string }) => Promise<AuthResponse<{ status?: boolean }>>;
        enable: (input: { password: string }) => Promise<AuthResponse<{ backupCodes: string[]; totpURI: string }>>;
        verifyOtp: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
        verifyTotp: (input: { code: string; trustDevice?: boolean }) => Promise<AuthResponse<SessionData>>;
    };
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

export type { AuthClient, AuthFetchError, AuthResponse, Controller, FieldState, FlowStatus, FormActions, FormController, FormState, SessionData };
