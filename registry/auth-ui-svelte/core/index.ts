/**
 * Framework-agnostic core barrel. Every framework port (React, Vue, Svelte,
 * Solid, Angular) imports its controllers, config, and types from here — the
 * only place flow logic lives.
 */
export type { ChangeEmailField } from "./change-email";
export { createChangeEmailController } from "./change-email";
export type { ChangePasswordField } from "./change-password";
export { createChangePasswordController } from "./change-password";
export type { AuthUIConfig, ControllerContext, NavAdapter, PluginFlags, RedirectConfig } from "./config";
export { DEFAULT_BASE_PATH, resolveContext } from "./config";
export type { FieldSpec, FormControllerOptions, FormSubmitResult } from "./create-form-controller";
export { createFormController } from "./create-form-controller";
export type { ResourceHandle, ResourceOptions, ResourceState } from "./create-resource-controller";
export { createResourceController } from "./create-resource-controller";
export { defaultNav } from "./default-nav";
export type { DeleteAccountField } from "./delete-account";
export { createDeleteAccountController } from "./delete-account";
export type { EmailOtpActions, EmailOtpController, EmailOtpState } from "./email-otp";
export { createEmailOtpController } from "./email-otp";
export type { FlowName } from "./flow-gate";
export { derivePluginFlags, isFlowEnabled, registerAuthClientPlugins, resetFlowWarnings } from "./flow-gate";
export type { ForgotPasswordField, ForgotPasswordOptions } from "./forgot-password";
export { createForgotPasswordController } from "./forgot-password";
export { passkeyLabel, ROLE_OPTIONS, sessionLabel, slugify } from "./labels";
export type { Localization } from "./localization";
export { DEFAULT_LOCALIZATION, resolveLocalization } from "./localization";
export type { MagicLinkField } from "./magic-link";
export { createMagicLinkController } from "./magic-link";
export { assertOk, AuthActionError, mapAuthError } from "./map-error";
export type { MembersActions, MembersController, MembersState } from "./members";
export { createMembersController } from "./members";
export type { OrganizationsActions, OrganizationsController } from "./organization-list";
export { createOrganizationsController } from "./organization-list";
export type { OrganizationSettingsField, OrganizationSettingsOptions } from "./organization-settings";
export { createOrganizationSettingsController } from "./organization-settings";
export type { PasskeysActions, PasskeysController } from "./passkeys";
export { createPasskeysController } from "./passkeys";
export type { ProfileField, ProfileOptions } from "./profile";
export { createProfileController } from "./profile";
export type { ResetPasswordField, ResetPasswordOptions } from "./reset-password";
export { createResetPasswordController } from "./reset-password";
export { signOut } from "./session-actions";
export type { SessionsActions, SessionsController } from "./sessions";
export { createSessionsController } from "./sessions";
export type { SignInField } from "./sign-in";
export { createSignInController } from "./sign-in";
export type { SignUpField } from "./sign-up";
export { createSignUpController } from "./sign-up";
export { signInWithSocial } from "./social";
export type { Store } from "./store";
export { createStore } from "./store";
export type { ThemeTokens } from "./theme";
export { DEFAULT_THEME_TOKENS, resolveThemeVariables } from "./theme";
export type { TwoFactorSetupActions, TwoFactorSetupController, TwoFactorSetupState } from "./two-factor-setup";
export { createTwoFactorSetupController } from "./two-factor-setup";
export type { TwoFactorField, TwoFactorVerifyOptions } from "./two-factor-verify";
export { createTwoFactorVerifyController } from "./two-factor-verify";
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
} from "./types";
export { email, MIN_PASSWORD_LENGTH, password, required } from "./validators";
