// Re-export the framework-agnostic core so advanced users can reach controllers,
// config, and types from the same entry point.
export * from "../core";

/**
 * Svelte port barrel. In a consumer project this is copied to
 * `lunora/auth-ui/svelte/index.ts` alongside `lunora/auth-ui/core/*`, so the
 * relative `../core` imports resolve unchanged — no import rewriting on copy.
 *
 * Usage after `lunora add auth-ui`:
 *
 * ```svelte
 * <script lang="ts">
 *     import { AuthUIProvider, SignInCard } from "./lunora/auth-ui/svelte";
 *     import { authClient } from "./lunora/auth-ui/client";
 *     import "./lunora/auth-ui/styles.css";
 * </script>
 *
 * <AuthUIProvider {authClient}>
 *     <SignInCard />
 * </AuthUIProvider>
 * ```
 */

// Verification + invitation screens.
export { default as AcceptInvitationCard } from "./AcceptInvitationCard.svelte";
// Plugin cards.
export { default as AdminUsersCard } from "./AdminUsersCard.svelte";
// Auth cards.
export { default as AnonymousButton } from "./AnonymousButton.svelte";

// Account + settings cards.
export { default as AppearanceCard } from "./AppearanceCard.svelte";
// Primitives.
export { default as AuthCard } from "./AuthCard.svelte";
export { default as AuthDivider } from "./AuthDivider.svelte";
export { default as AuthLink } from "./AuthLink.svelte";
export { default as AuthorizedAppsCard } from "./AuthorizedAppsCard.svelte";
export { default as AuthUIProvider } from "./AuthUIProvider.svelte";
export { default as AuthView } from "./AuthView.svelte";
export { default as AvatarCard } from "./AvatarCard.svelte";
export { default as BackupCodesCard } from "./BackupCodesCard.svelte";
// Extras mounted beside the cards rather than inside them.
export { default as Captcha } from "./Captcha.svelte";
export { default as ChangeEmailCard } from "./ChangeEmailCard.svelte";
export { default as ChangePasswordCard } from "./ChangePasswordCard.svelte";
export { default as ConsentCard } from "./ConsentCard.svelte";
// Provider + context helpers.
export type { AuthUILinkComponent, AuthUISvelteContext } from "./context";
export { setAuthUIContext, useAuthUI, useAuthUILink } from "./context";

// The controller→Svelte-store seam.
export type { ControllerStore } from "./controller-store";
export { controllerStore } from "./controller-store";
export { default as DeleteAccountCard } from "./DeleteAccountCard.svelte";
export { default as DeviceAuthorizationCard } from "./DeviceAuthorizationCard.svelte";
export { default as EmailOtpCard } from "./EmailOtpCard.svelte";
export { default as ErrorToaster } from "./ErrorToaster.svelte";
export { default as Field } from "./Field.svelte";
export { default as ForgotPasswordCard } from "./ForgotPasswordCard.svelte";
export { default as FormBanner } from "./FormBanner.svelte";
export { default as LinkedAccountsCard } from "./LinkedAccountsCard.svelte";
export { default as MagicLinkCard } from "./MagicLinkCard.svelte";

// Organization cards.
export { default as MembersCard } from "./MembersCard.svelte";
export { default as MultiSessionCard } from "./MultiSessionCard.svelte";
export { default as OneTap } from "./OneTap.svelte";
export { default as OrganizationLogoCard } from "./OrganizationLogoCard.svelte";
export { default as OrganizationsCard } from "./OrganizationsCard.svelte";
export { default as OrganizationSettingsCard } from "./OrganizationSettingsCard.svelte";
export { default as PasskeysCard } from "./PasskeysCard.svelte";
export { default as PasswordStrength } from "./PasswordStrength.svelte";
export { default as PhoneSignInCard } from "./PhoneSignInCard.svelte";
export { default as ProfileCard } from "./ProfileCard.svelte";
export { default as ResendVerificationCard } from "./ResendVerificationCard.svelte";
export { default as ResetPasswordCard } from "./ResetPasswordCard.svelte";
export { default as ResetPasswordOtpCard } from "./ResetPasswordOtpCard.svelte";
export { default as SessionsCard } from "./SessionsCard.svelte";
export { default as SetUsernameCard } from "./SetUsernameCard.svelte";
export { default as SignInCard } from "./SignInCard.svelte";
export { default as SignOutButton } from "./SignOutButton.svelte";
export { default as SignUpCard } from "./SignUpCard.svelte";
export { default as Skeleton } from "./Skeleton.svelte";
export { default as SocialButtons } from "./SocialButtons.svelte";
export { default as SubmitButton } from "./SubmitButton.svelte";
export { default as TeamsCard } from "./TeamsCard.svelte";
export { default as TwoFactorCard } from "./TwoFactorCard.svelte";
export { default as TwoFactorSetupCard } from "./TwoFactorSetupCard.svelte";
// The signed-in user's chrome.
export { default as UserAvatar } from "./UserAvatar.svelte";
export { default as UserButton } from "./UserButton.svelte";
export { default as UserInvitationsCard } from "./UserInvitationsCard.svelte";
export { default as UsernameAvailability } from "./UsernameAvailability.svelte";
export { default as UsernameSignInCard } from "./UsernameSignInCard.svelte";
export { default as UserView } from "./UserView.svelte";
export { default as VerifyEmailCard } from "./VerifyEmailCard.svelte";
