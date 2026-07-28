// Re-export the framework-agnostic core so advanced users can reach controllers,
// config, and types from the same entry point.
export * from "../core";

/**
 * Angular port barrel. In a consumer project this is copied to
 * `lunora/auth-ui/angular/index.ts` alongside `lunora/auth-ui/core/*`, so the
 * relative `../core` imports resolve unchanged — no import rewriting on copy.
 *
 * Usage after `lunora add auth-ui` (standalone + signals; Angular >= 17.3):
 *
 * ```ts
 * // app.config.ts
 * import { provideAuthUI } from "./lunora/auth-ui/angular";
 * import { authClient } from "./lunora/auth-ui/client";
 *
 * export const appConfig: ApplicationConfig = {
 *     providers: [provideAuthUI({ authClient })],
 * };
 * ```
 *
 * ```ts
 * // a route component
 * import { SignInCardComponent } from "./lunora/auth-ui/angular";
 *
 * @Component({ imports: [SignInCardComponent], template: `<lunora-sign-in-card />` })
 * export class SignInPage {}
 * ```
 */
export { AppearanceCardComponent, AvatarCardComponent, LinkedAccountsCardComponent, SetUsernameCardComponent } from "./account-cards";
export {
    AnonymousButtonComponent,
    EmailOtpCardComponent,
    ForgotPasswordCardComponent,
    MagicLinkCardComponent,
    ResetPasswordCardComponent,
    SignInCardComponent,
    SignUpCardComponent,
    TwoFactorCardComponent,
} from "./auth-cards";
export { AuthViewComponent, PhoneSignInCardComponent, UsernameSignInCardComponent } from "./auth-view";
export type { ControllerSignalOptions, ControllerSignalResult } from "./controller-signal";
export { controllerSignal } from "./controller-signal";
export { CaptchaComponent, ErrorToasterComponent, OneTapComponent, OrganizationLogoCardComponent } from "./extras";
export { MembersCardComponent, OrganizationSettingsCardComponent, OrganizationsCardComponent } from "./organization";
export {
    AdminUsersCardComponent,
    BackupCodesCardComponent,
    DeviceAuthorizationCardComponent,
    MultiSessionCardComponent,
    TeamsCardComponent,
} from "./plugin-cards";
export {
    AuthCardComponent,
    AuthDividerComponent,
    AuthFieldComponent,
    AuthLinkComponent,
    FormBannerComponent,
    SkeletonComponent,
    SocialButtonsComponent,
    SubmitButtonComponent,
} from "./primitives";
export type { AuthUIAngularConfig, AuthUIAngularContext } from "./provider";
export { AUTH_UI_CONTEXT, injectAuthUI, injectAuthUIContext, injectAuthUILink, provideAuthUI } from "./provider";
export {
    ChangeEmailCardComponent,
    ChangePasswordCardComponent,
    DeleteAccountCardComponent,
    PasskeysCardComponent,
    ProfileCardComponent,
    SessionsCardComponent,
    SignOutButtonComponent,
} from "./settings-cards";
export { TwoFactorSetupCardComponent } from "./two-factor-setup-card";
export { UserAvatarComponent, UserButtonComponent, UserViewComponent } from "./user-button";
export { AcceptInvitationCardComponent, ResendVerificationCardComponent, UserInvitationsCardComponent, VerifyEmailCardComponent } from "./verify-invite-cards";
