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
export type { ForgotPasswordCardProps, MagicLinkCardProps, ResetPasswordCardProps, SignInCardProps, SignUpCardProps, TwoFactorCardProps } from "./auth-cards";
export { EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, SignInCard, SignUpCard, TwoFactorCard } from "./auth-cards";
export { MembersCard, OrganizationsCard } from "./organization";
export type { AuthCardProps, FieldProps } from "./primitives";
export { AuthCard, AuthDivider, AuthLink, Field, FormBanner, SocialButtons, SubmitButton } from "./primitives";
export type { AuthUILink, AuthUIProviderProps } from "./provider";
export { AuthUIProvider, useAuthUI, useAuthUILink } from "./provider";
export type { ProfileCardProps, SignOutButtonProps } from "./settings-cards";
export { ChangeEmailCard, ChangePasswordCard, DeleteAccountCard, ProfileCard, SessionsCard, SignOutButton } from "./settings-cards";
export { TwoFactorSetupCard } from "./two-factor-setup-card";
export { createController } from "./use-controller";
