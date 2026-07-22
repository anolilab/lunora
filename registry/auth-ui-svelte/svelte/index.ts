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

// Provider + context helpers.
export type { AuthUILinkComponent, AuthUISvelteContext } from "./context";
export { setAuthUIContext, useAuthUI, useAuthUILink } from "./context";
export { default as AuthUIProvider } from "./AuthUIProvider.svelte";

// The controller→Svelte-store seam.
export type { ControllerStore } from "./controller-store";
export { controllerStore } from "./controller-store";

// Primitives.
export { default as AuthCard } from "./AuthCard.svelte";
export { default as AuthDivider } from "./AuthDivider.svelte";
export { default as AuthLink } from "./AuthLink.svelte";
export { default as Field } from "./Field.svelte";
export { default as FormBanner } from "./FormBanner.svelte";
export { default as SocialButtons } from "./SocialButtons.svelte";
export { default as SubmitButton } from "./SubmitButton.svelte";

// Auth cards.
export { default as EmailOtpCard } from "./EmailOtpCard.svelte";
export { default as ForgotPasswordCard } from "./ForgotPasswordCard.svelte";
export { default as MagicLinkCard } from "./MagicLinkCard.svelte";
export { default as ResetPasswordCard } from "./ResetPasswordCard.svelte";
export { default as SignInCard } from "./SignInCard.svelte";
export { default as SignUpCard } from "./SignUpCard.svelte";
export { default as TwoFactorCard } from "./TwoFactorCard.svelte";

// Settings + security cards.
export { default as ChangeEmailCard } from "./ChangeEmailCard.svelte";
export { default as ChangePasswordCard } from "./ChangePasswordCard.svelte";
export { default as DeleteAccountCard } from "./DeleteAccountCard.svelte";
export { default as ProfileCard } from "./ProfileCard.svelte";
export { default as SessionsCard } from "./SessionsCard.svelte";
export { default as SignOutButton } from "./SignOutButton.svelte";
export { default as TwoFactorSetupCard } from "./TwoFactorSetupCard.svelte";

// Organization cards.
export { default as MembersCard } from "./MembersCard.svelte";
export { default as OrganizationsCard } from "./OrganizationsCard.svelte";
