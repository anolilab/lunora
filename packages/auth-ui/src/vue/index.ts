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
export { AUTH_UI_INJECTION_KEY, createAuthUI, provideAuthUI, useAuthUI, useAuthUILink } from "./provider";
export { useController } from "./use-controller";

// Primitives.
export { default as AuthCard } from "./AuthCard.vue";
export { default as AuthDivider } from "./AuthDivider.vue";
export { default as AuthLink } from "./AuthLink.vue";
export { default as Field } from "./Field.vue";
export { default as FormBanner } from "./FormBanner.vue";
export { default as SocialButtons } from "./SocialButtons.vue";
export { default as SubmitButton } from "./SubmitButton.vue";

// Auth cards.
export { default as EmailOtpCard } from "./EmailOtpCard.vue";
export { default as ForgotPasswordCard } from "./ForgotPasswordCard.vue";
export { default as MagicLinkCard } from "./MagicLinkCard.vue";
export { default as ResetPasswordCard } from "./ResetPasswordCard.vue";
export { default as SignInCard } from "./SignInCard.vue";
export { default as SignUpCard } from "./SignUpCard.vue";
export { default as TwoFactorCard } from "./TwoFactorCard.vue";

// Settings + security cards.
export { default as ChangeEmailCard } from "./ChangeEmailCard.vue";
export { default as ChangePasswordCard } from "./ChangePasswordCard.vue";
export { default as DeleteAccountCard } from "./DeleteAccountCard.vue";
export { default as ProfileCard } from "./ProfileCard.vue";
export { default as SessionsCard } from "./SessionsCard.vue";
export { default as SignOutButton } from "./SignOutButton.vue";
export { default as TwoFactorSetupCard } from "./TwoFactorSetupCard.vue";

// Organization cards.
export { default as MembersCard } from "./MembersCard.vue";
export { default as OrganizationsCard } from "./OrganizationsCard.vue";
