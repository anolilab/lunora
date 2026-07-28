// Re-export the framework-agnostic core so advanced users can reach controllers,
// config, and types from the same entry point.
export * from "../core";

/**
 * Solid port barrel. In a consumer project this is copied to
 * `lunora/auth-ui/solid/index.ts` alongside `lunora/auth-ui/core/*`, so the
 * relative `../core` imports resolve unchanged — no import rewriting on copy.
 *
 * Usage after `lunora add auth-ui`:
 *
 * ```tsx
 * import { AuthUIProvider, SignInCard } from "./lunora/auth-ui/solid";
 * import { authClient } from "./lunora/auth-ui/client";
 * import "./lunora/auth-ui/styles.css";
 * ```
 */
export { AppearanceCard, AvatarCard, LinkedAccountsCard, SetUsernameCard } from "./account-cards";
export type { ForgotPasswordCardProps, MagicLinkCardProps, ResetPasswordCardProps, SignInCardProps, SignUpCardProps, TwoFactorCardProps } from "./auth-cards";
export { AnonymousButton, EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, SignInCard, SignUpCard, TwoFactorCard } from "./auth-cards";
export type { AuthViewProps } from "./auth-view";
export { AuthView, PhoneSignInCard, UsernameSignInCard } from "./auth-view";
export type { CaptchaProps, OrganizationLogoCardProps } from "./extras";
export { Captcha, ErrorToaster, OneTap, OrganizationLogoCard } from "./extras";
export type { ConsentCardProps } from "./oauth-provider";
export { AuthorizedAppsCard, ConsentCard } from "./oauth-provider";
export type { OrganizationSettingsCardProps } from "./organization";
export { MembersCard, OrganizationSettingsCard, OrganizationsCard } from "./organization";
export type { DeviceAuthorizationCardProps } from "./plugin-cards";
export { AdminUsersCard, BackupCodesCard, DeviceAuthorizationCard, MultiSessionCard, TeamsCard } from "./plugin-cards";
export type { AuthCardProps, FieldProps } from "./primitives";
export {
    AuthCard,
    AuthDivider,
    AuthLink,
    Field,
    FormBanner,
    PasswordStrength,
    Skeleton,
    SocialButtons,
    SubmitButton,
    themeStyle,
    UsernameAvailability,
} from "./primitives";
export type { AuthUILink, AuthUIProviderProps } from "./provider";
export { AuthUIProvider, useAuthUI, useAuthUILink } from "./provider";
export type { ProfileCardProps, SignOutButtonProps } from "./settings-cards";
export { ChangeEmailCard, ChangePasswordCard, DeleteAccountCard, PasskeysCard, ProfileCard, SessionsCard, SignOutButton } from "./settings-cards";
export { TwoFactorSetupCard } from "./two-factor-setup-card";
export { createController } from "./use-controller";
export type { UserAvatarProps, UserButtonProps, UserViewProps } from "./user-button";
export { UserAvatar, UserButton, UserView } from "./user-button";
export type { AcceptInvitationCardProps, VerifyEmailCardProps } from "./verify-invite-cards";
export { AcceptInvitationCard, ResendVerificationCard, UserInvitationsCard, VerifyEmailCard } from "./verify-invite-cards";
