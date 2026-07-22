/**
 * Framework-agnostic core barrel. Every framework port (React, Vue, Svelte,
 * Solid, Angular) imports its controllers, config, and types from here — the
 * only place flow logic lives.
 */
export type { AuthUIConfig, ControllerContext, NavAdapter, PluginFlags, RedirectConfig } from "./config";
export { DEFAULT_BASE_PATH, resolveContext } from "./config";
export type { FieldSpec, FormControllerOptions, FormSubmitResult } from "./create-form-controller";
export { createFormController } from "./create-form-controller";
export { defaultNav } from "./default-nav";
export type { EmailOtpActions, EmailOtpController, EmailOtpState } from "./email-otp";
export { createEmailOtpController } from "./email-otp";
export type { ForgotPasswordField, ForgotPasswordOptions } from "./forgot-password";
export { createForgotPasswordController } from "./forgot-password";
export type { Localization } from "./localization";
export { DEFAULT_LOCALIZATION, resolveLocalization } from "./localization";
export type { MagicLinkField } from "./magic-link";
export { createMagicLinkController } from "./magic-link";
export { assertOk, AuthActionError, mapAuthError } from "./map-error";
export type { ResetPasswordField, ResetPasswordOptions } from "./reset-password";
export { createResetPasswordController } from "./reset-password";
export type { SignInField } from "./sign-in";
export { createSignInController } from "./sign-in";
export type { SignUpField } from "./sign-up";
export { createSignUpController } from "./sign-up";
export { signInWithSocial } from "./social";
export type { Store } from "./store";
export { createStore } from "./store";
export type { TwoFactorField, TwoFactorVerifyOptions } from "./two-factor-verify";
export { createTwoFactorVerifyController } from "./two-factor-verify";
export type {
    AuthClient,
    AuthFetchError,
    AuthResponse,
    Controller,
    FieldState,
    FlowStatus,
    FormActions,
    FormController,
    FormState,
    SessionData,
} from "./types";
export { email, MIN_PASSWORD_LENGTH, password, required } from "./validators";
