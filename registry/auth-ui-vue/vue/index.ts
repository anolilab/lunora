// Re-export the framework-agnostic core so advanced users can reach controllers,
// config, and types from the same entry point.
export * from "../core";

/**
 * Vue port barrel. In a consumer project this is copied to
 * `lunora/auth-ui/vue/index.ts` alongside `lunora/auth-ui/core/*`, so the
 * relative `../core` imports resolve unchanged — no import rewriting on copy.
 *
 * Usage after `lunora add auth-ui`:
 *
 * ```ts
 * // main.ts
 * import { createApp } from "vue";
 * import { createAuthUI } from "./lunora/auth-ui/vue";
 * import { authClient } from "./lunora/auth-ui/client";
 * import "./lunora/auth-ui/styles.css";
 *
 * createApp(App).use(createAuthUI({ authClient })).mount("#app");
 * ```
 *
 * ```vue
 * <script setup lang="ts">
 * import { SignInCard } from "./lunora/auth-ui/vue";
 * </script>
 * ```
 */

// Provider + composables.
export { default as AuthUIProvider } from "./AuthUIProvider.vue";
export type { AuthUIProviderProps, AuthUIVueContext } from "./provider";
export { AUTH_UI_INJECTION_KEY, createAuthUI, provideAuthUI, useAuthUI, useAuthUIContextRef, useAuthUILink } from "./provider";
export { useController } from "./use-controller";

// Primitives.
export { default as AuthCard } from "./AuthCard.vue";
export { default as AuthDivider } from "./AuthDivider.vue";
export { default as AuthLink } from "./AuthLink.vue";
export { default as ErrorToaster } from "./ErrorToaster.vue";
export { default as Field } from "./Field.vue";
export { default as FormBanner } from "./FormBanner.vue";
export { default as Skeleton } from "./Skeleton.vue";
export { default as SocialButtons } from "./SocialButtons.vue";
export { default as SubmitButton } from "./SubmitButton.vue";

// Auth cards.
export { default as AnonymousButton } from "./AnonymousButton.vue";
export { default as AuthView } from "./AuthView.vue";
export { default as Captcha } from "./Captcha.vue";
export { default as EmailOtpCard } from "./EmailOtpCard.vue";
export { default as ForgotPasswordCard } from "./ForgotPasswordCard.vue";
export { default as MagicLinkCard } from "./MagicLinkCard.vue";
export { default as OneTap } from "./OneTap.vue";
export { default as PhoneSignInCard } from "./PhoneSignInCard.vue";
export { default as ResetPasswordCard } from "./ResetPasswordCard.vue";
export { default as SignInCard } from "./SignInCard.vue";
export { default as SignUpCard } from "./SignUpCard.vue";
export { default as TwoFactorCard } from "./TwoFactorCard.vue";
export { default as UsernameSignInCard } from "./UsernameSignInCard.vue";

// Session chrome.
export { default as UserAvatar } from "./UserAvatar.vue";
export { default as UserButton } from "./UserButton.vue";
export { default as UserView } from "./UserView.vue";

// Settings + security cards.
export { default as AppearanceCard } from "./AppearanceCard.vue";
export { default as AvatarCard } from "./AvatarCard.vue";
export { default as ChangeEmailCard } from "./ChangeEmailCard.vue";
export { default as ChangePasswordCard } from "./ChangePasswordCard.vue";
export { default as DeleteAccountCard } from "./DeleteAccountCard.vue";
export { default as LinkedAccountsCard } from "./LinkedAccountsCard.vue";
export { default as PasskeysCard } from "./PasskeysCard.vue";
export { default as ProfileCard } from "./ProfileCard.vue";
export { default as SessionsCard } from "./SessionsCard.vue";
export { default as SetUsernameCard } from "./SetUsernameCard.vue";
export { default as SignOutButton } from "./SignOutButton.vue";
export { default as TwoFactorSetupCard } from "./TwoFactorSetupCard.vue";

// Verification + invitation cards.
export { default as AcceptInvitationCard } from "./AcceptInvitationCard.vue";
export { default as ResendVerificationCard } from "./ResendVerificationCard.vue";
export { default as UserInvitationsCard } from "./UserInvitationsCard.vue";
export { default as VerifyEmailCard } from "./VerifyEmailCard.vue";

// Plugin cards.
export { default as AdminUsersCard } from "./AdminUsersCard.vue";
export { default as BackupCodesCard } from "./BackupCodesCard.vue";
export { default as DeviceAuthorizationCard } from "./DeviceAuthorizationCard.vue";
export { default as MultiSessionCard } from "./MultiSessionCard.vue";
export { default as TeamsCard } from "./TeamsCard.vue";

// Organization cards.
export { default as MembersCard } from "./MembersCard.vue";
export { default as OrganizationLogoCard } from "./OrganizationLogoCard.vue";
export { default as OrganizationSettingsCard } from "./OrganizationSettingsCard.vue";
export { default as OrganizationsCard } from "./OrganizationsCard.vue";
