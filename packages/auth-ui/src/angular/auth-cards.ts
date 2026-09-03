/**
 * The authentication cards, mirroring the React `auth-cards.tsx` 1:1: sign-in
 * (with social + forgot/sign-up links), sign-up, forgot-password, reset-password,
 * magic-link, email-OTP (two-step), and two-factor verify. Each is a thin
 * standalone component binding a core controller to the shared view primitives.
 */
import type { OnInit, Signal, WritableSignal } from "@angular/core";
import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, Injector, input, signal } from "@angular/core";

import { signInAnonymously } from "../core/anonymous";
import type { BackupCodeSignInField } from "../core/backup-codes";
import { createBackupCodeSignInController } from "../core/backup-codes";
import { queryParameter } from "../core/browser-location";
import type { EmailOtpActions, EmailOtpState } from "../core/email-otp";
import { createEmailOtpController } from "../core/email-otp";
import { isFlowEnabled } from "../core/flow-gate";
import type { ForgotPasswordField } from "../core/forgot-password";
import { createForgotPasswordController } from "../core/forgot-password";
import { LAST_METHOD_EMAIL, LAST_METHOD_MAGIC_LINK, readLastLoginMethod } from "../core/last-login-method";
import { createMagicLinkController } from "../core/magic-link";
import type { ResetPasswordField } from "../core/reset-password";
import { createResetPasswordController } from "../core/reset-password";
import type { ResetPasswordOtpField } from "../core/reset-password-otp";
import { createResetPasswordOtpController } from "../core/reset-password-otp";
import { createSignInController } from "../core/sign-in";
import { createSignUpController } from "../core/sign-up";
import { signInWithSocial } from "../core/social";
import type { TwoFactorField } from "../core/two-factor-verify";
import { createTwoFactorVerifyController } from "../core/two-factor-verify";
import type { FormActions, FormState } from "../core/types";
import { controllerSignal } from "./controller-signal";
import {
    AuthCardComponent,
    AuthDividerComponent,
    AuthFieldComponent,
    AuthLinkComponent,
    FormBannerComponent,
    PasswordStrengthComponent,
    SocialButtonsComponent,
    SubmitButtonComponent,
} from "./primitives";
import { injectAuthUIContext } from "./provider";

/**
 * A signal holding the last-used login method, filled in after the first render.
 *
 * Read after the first render, not during it: the server has no cookie, so a
 * render-time read produces markup the server could not have produced (see
 * `lastLoginMethodStore` in core). `afterNextRender` never runs on the server,
 * which is exactly the guarantee needed — and calling this from a field
 * initialiser keeps it inside the component's injection context.
 */
const lastLoginMethodAfterRender = (): WritableSignal<string | undefined> => {
    const method = signal<string | undefined>(undefined);

    afterNextRender(() => {
        method.set(readLastLoginMethod());
    });

    return method;
};

/** "Continue as guest", when the `anonymous` plugin is on. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-anonymous-button",
    standalone: true,
    template: ` <button class="lunora-auth-button lunora-auth-button--secondary" type="button" (click)="signIn()">{{ t.anonymousSignIn }}</button> `,
})
class AnonymousButtonComponent {
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;

    protected signIn(): void {
        void signInAnonymously(this.context());
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        AnonymousButtonComponent,
        AuthCardComponent,
        AuthDividerComponent,
        AuthFieldComponent,
        AuthLinkComponent,
        FormBannerComponent,
        SocialButtonsComponent,
        SubmitButtonComponent,
    ],
    selector: "lunora-sign-in-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.signIn" [footer]="signUp()">
            <lunora-auth-social-buttons [providers]="social()" [lastUsed]="lastUsed()" (select)="signInSocial($event)" />
            @if (anonymous()) {
                <lunora-anonymous-button />
            }
            @if (social().length > 0 && credentials()) {
                <lunora-auth-divider />
            }
            <!--
              An OAuth-only deployment has no password form to show. Discovery
              reports that as emailAndPassword: false; without discovery it
              defaults to true, which is the pre-existing behaviour.
            -->
            @if (credentials()) {
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                    <lunora-auth-banner [error]="state().formError" />
                    <lunora-auth-field
                        [field]="state().fields.email"
                        [label]="t.emailLabel"
                        name="email"
                        type="email"
                        autoComplete="email"
                        (changed)="actions.setField('email', $event)"
                        (blurred)="actions.blur('email')"
                    />
                    <lunora-auth-field
                        [field]="state().fields.password"
                        [label]="t.passwordLabel"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        (changed)="actions.setField('password', $event)"
                        (blurred)="actions.blur('password')"
                    />
                    <lunora-auth-link [href]="forgotPasswordHref()">{{ t.forgotPasswordLink }}</lunora-auth-link>
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">
                        {{ t.signIn }}
                        <!--
                          better-auth records a password sign-in as "email", so without this the badge is invisible for the most common route there is.
                        -->
                        @if (lastUsedEmail()) {
                            <span class="lunora-auth-social__badge">{{ t.lastUsed }}</span>
                        }
                    </lunora-auth-submit-button>
                </form>
            }
            @if (signUp()) {
                <lunora-auth-link lunoraAuthCardFooter [href]="signUpHref()">{{ t.noAccount }}</lunora-auth-link>
            }
        </lunora-auth-card>
    `,
})
class SignInCardComponent {
    readonly forgotPasswordHref = input("/forgot-password");
    readonly signUpHref = input("/sign-up");

    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createSignInController, { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;

    private readonly lastLoginMethod = lastLoginMethodAfterRender();

    /*
     * All derived from the context, so the deployment's real shape — which
     * providers exist, whether there is a password form at all — arrives with the
     * discovery answer instead of being frozen at mount.
     */
    protected readonly anonymous = computed(() => this.context().plugins.anonymous);
    protected readonly credentials = computed(() => this.context().credentials);
    protected readonly lastUsed = computed(() => (this.context().plugins.lastLoginMethod ? this.lastLoginMethod() : undefined));
    protected readonly lastUsedEmail = computed(() => this.lastUsed() === LAST_METHOD_EMAIL);
    protected readonly signUp = computed(() => this.context().signUp);
    protected readonly social = computed(() => this.context().social);

    protected signInSocial(provider: string): void {
        void signInWithSocial(this.context(), provider);
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        AuthCardComponent,
        AuthDividerComponent,
        AuthFieldComponent,
        AuthLinkComponent,
        FormBannerComponent,
        PasswordStrengthComponent,
        SocialButtonsComponent,
        SubmitButtonComponent,
    ],
    selector: "lunora-sign-up-card",
    standalone: true,
    template: `
        <!--
          The server can close self-serve sign-up
          (emailAndPassword.disableSignUp). Mirrors the plugin-gated cards:
          mounted directly, this card renders nothing rather than a form that
          will fail on submit; AuthView's route falls back to the sign-in
          card instead of landing on a blank page.
        -->
        @if (enabled()) {
            <lunora-auth-card [title]="t.signUp" [footer]="true">
                <!--
                  Social buttons belong on sign-up too — OAuth is a sign-up path, not
                  just a sign-in one, and omitting them here sends new users through
                  a password form they never needed.
                -->
                <lunora-auth-social-buttons [providers]="social()" (select)="signInSocial($event)" />
                @if (social().length > 0) {
                    <lunora-auth-divider />
                }
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                    <lunora-auth-banner [error]="state().formError" />
                    <lunora-auth-field
                        [field]="state().fields.name"
                        [label]="t.nameLabel"
                        name="name"
                        autoComplete="name"
                        (changed)="actions.setField('name', $event)"
                        (blurred)="actions.blur('name')"
                    />
                    <lunora-auth-field
                        [field]="state().fields.email"
                        [label]="t.emailLabel"
                        name="email"
                        type="email"
                        autoComplete="email"
                        (changed)="actions.setField('email', $event)"
                        (blurred)="actions.blur('email')"
                    />
                    <lunora-auth-field
                        [field]="state().fields.password"
                        [label]="t.passwordLabel"
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        (changed)="actions.setField('password', $event)"
                        (blurred)="actions.blur('password')"
                    />
                    <lunora-auth-password-strength [value]="state().fields.password.value" />
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.signUp }}</lunora-auth-submit-button>
                </form>
                <lunora-auth-link lunoraAuthCardFooter [href]="signInHref()">{{ t.haveAccount }}</lunora-auth-link>
            </lunora-auth-card>
        }
    `,
})
class SignUpCardComponent {
    readonly signInHref = input("/sign-in");

    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createSignUpController, { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;

    /** Derived, so a discovery answer that closes self-serve sign-up takes effect. */
    protected readonly enabled = computed(() => this.context().signUp);
    /** Derived, so the provider list follows server discovery. */
    protected readonly social = computed(() => this.context().social);

    protected signInSocial(provider: string): void {
        void signInWithSocial(this.context(), provider);
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, AuthLinkComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-forgot-password-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.forgotPassword" [footer]="true">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                <lunora-auth-field
                    [field]="state().fields.email"
                    [label]="t.emailLabel"
                    name="email"
                    type="email"
                    autoComplete="email"
                    (changed)="actions.setField('email', $event)"
                    (blurred)="actions.blur('email')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.forgotPassword }}</lunora-auth-submit-button>
            </form>
            <lunora-auth-link lunoraAuthCardFooter [href]="signInHref()">{{ t.backToSignIn }}</lunora-auth-link>
        </lunora-auth-card>
    `,
})
class ForgotPasswordCardComponent implements OnInit {
    readonly resetPath = input<string>();
    readonly signInHref = input("/sign-in");

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly t = this.context().localization;
    protected state!: Signal<FormState<ForgotPasswordField>>;
    protected actions!: FormActions<ForgotPasswordField>;

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createForgotPasswordController(context, { resetPath: this.resetPath() }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-reset-password-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.resetPassword">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                <lunora-auth-field
                    [field]="state().fields.password"
                    [label]="t.passwordLabel"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    (changed)="actions.setField('password', $event)"
                    (blurred)="actions.blur('password')"
                />
                <lunora-auth-field
                    [field]="state().fields.confirmPassword"
                    [label]="t.confirmPasswordLabel"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    (changed)="actions.setField('confirmPassword', $event)"
                    (blurred)="actions.blur('confirmPassword')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.resetPassword }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class ResetPasswordCardComponent implements OnInit {
    /** Defaults to `?token=` from the URL. */
    readonly token = input<string>();

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly t = this.context().localization;
    protected state!: Signal<FormState<ResetPasswordField>>;
    protected actions!: FormActions<ResetPasswordField>;

    // Built in ngOnInit, not a field initializer: `token()` is unbound until
    // Angular has set the inputs, so the controller would consume the URL's
    // token even when the caller passed one of their own.
    ngOnInit(): void {
        const resolved = this.token() ?? queryParameter("token");
        const bridge = controllerSignal((context) => createResetPasswordController(context, { token: resolved }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }
}

/**
 * Redeems an emailed one-time code instead of a link — for apps that set
 * `forgotPassword: { method: "otp" }`. Unlike {@link ResetPasswordCardComponent},
 * the email address is a field rather than something carried from the previous
 * screen: a code can legitimately be redeemed from a fresh tab.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-reset-password-otp-card",
    standalone: true,
    template: `
        <!-- secret-scanner:allow -- i18n key, not a credential --><lunora-auth-card [title]="t.resetPassword" [description]="t.resetPasswordOtpDescription">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                <lunora-auth-field
                    [field]="state().fields.email"
                    [label]="t.emailLabel"
                    name="email"
                    type="email"
                    autoComplete="email"
                    (changed)="actions.setField('email', $event)"
                    (blurred)="actions.blur('email')"
                />
                <lunora-auth-field
                    [field]="state().fields.otp"
                    [label]="t.codeLabel"
                    name="otp"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    (changed)="actions.setField('otp', $event)"
                    (blurred)="actions.blur('otp')"
                />
                <lunora-auth-field
                    [field]="state().fields.password"
                    [label]="t.passwordLabel"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    (changed)="actions.setField('password', $event)"
                    (blurred)="actions.blur('password')"
                />
                <lunora-auth-field
                    [field]="state().fields.confirmPassword"
                    [label]="t.confirmPasswordLabel"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    (changed)="actions.setField('confirmPassword', $event)"
                    (blurred)="actions.blur('confirmPassword')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.resetPassword }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class ResetPasswordOtpCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createResetPasswordOtpController, { context: this.context });
    protected readonly state: Signal<FormState<ResetPasswordOtpField>> = this.bridge.state;
    protected readonly actions: FormActions<ResetPasswordOtpField> = this.bridge.actions;
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, AuthLinkComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-magic-link-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.magicLink" [footer]="true">
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                    <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                    <lunora-auth-field
                        [field]="state().fields.email"
                        [label]="t.emailLabel"
                        name="email"
                        type="email"
                        autoComplete="email"
                        (changed)="actions.setField('email', $event)"
                        (blurred)="actions.blur('email')"
                    />
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">
                        {{ t.magicLink }}
                        @if (lastUsedMagicLink()) {
                            <span class="lunora-auth-social__badge">{{ t.lastUsed }}</span>
                        }
                    </lunora-auth-submit-button>
                </form>
                <lunora-auth-link lunoraAuthCardFooter [href]="signInHref()">{{ t.backToSignIn }}</lunora-auth-link>
            </lunora-auth-card>
        }
    `,
})
class MagicLinkCardComponent {
    readonly signInHref = input("/sign-in");

    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "magicLink", "MagicLinkCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createMagicLinkController, { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;

    // Computed rather than frozen at mount, like every other context-derived
    // member here: the deployment's real shape arrives with the discovery answer.
    private readonly lastLoginMethod = lastLoginMethodAfterRender();
    protected readonly lastUsedMagicLink = computed(
        () => (this.context().plugins.lastLoginMethod ? this.lastLoginMethod() : undefined) === LAST_METHOD_MAGIC_LINK,
    );
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-email-otp-card",
    standalone: true,
    template: `
        @if (enabled()) {
            @if (state().step === "verify") {
                <lunora-auth-card [title]="t.emailOtp" [description]="t.emailOtpSent" [footer]="true">
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.verify()">
                        <lunora-auth-banner [error]="state().formError" />
                        <lunora-auth-field
                            [field]="state().code"
                            [label]="t.codeLabel"
                            name="code"
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            (changed)="actions.setCode($event)"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.twoFactor }}</lunora-auth-submit-button>
                    </form>
                    <button lunoraAuthCardFooter class="lunora-auth-link" type="button" (click)="actions.back()">{{ t.sendNewCode }}</button>
                </lunora-auth-card>
            } @else {
                <lunora-auth-card [title]="t.emailOtp">
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.sendCode()">
                        <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                        <lunora-auth-field
                            [field]="state().email"
                            [label]="t.emailLabel"
                            name="email"
                            type="email"
                            autoComplete="email"
                            (changed)="actions.setEmail($event)"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.emailOtp }}</lunora-auth-submit-button>
                    </form>
                </lunora-auth-card>
            }
        }
    `,
})
class EmailOtpCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "emailOtp", "EmailOtpCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createEmailOtpController, { context: this.context });
    protected readonly state: Signal<EmailOtpState> = this.bridge.state;
    protected readonly actions: EmailOtpActions = this.bridge.actions;
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-two-factor-card",
    standalone: true,
    template: `
        @if (enabled()) {
            @if (useBackupCode()) {
                <lunora-auth-card [title]="t.twoFactor" [footer]="true">
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); backupActions.submit()">
                        <lunora-auth-banner [error]="backupState().formError" />
                        <lunora-auth-field
                            [field]="backupState().fields.code"
                            [label]="t.backupCodeLabel"
                            name="code"
                            autoComplete="one-time-code"
                            (changed)="backupActions.setField('code', $event)"
                            (blurred)="backupActions.blur('code')"
                        />
                        <lunora-auth-submit-button [pending]="backupState().status === 'submitting'">{{ t.twoFactor }}</lunora-auth-submit-button>
                    </form>
                    <button lunoraAuthCardFooter class="lunora-auth-link" type="button" (click)="useBackupCode.set(false)">
                        {{ t.twoFactorUseAuthenticator }}
                    </button>
                </lunora-auth-card>
            } @else {
                <lunora-auth-card [title]="t.twoFactor" [footer]="true">
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                        <lunora-auth-banner [error]="state().formError" />
                        <lunora-auth-field
                            [field]="state().fields.code"
                            [label]="t.codeLabel"
                            name="code"
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            (changed)="actions.setField('code', $event)"
                            (blurred)="actions.blur('code')"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.twoFactor }}</lunora-auth-submit-button>
                    </form>
                    <button lunoraAuthCardFooter class="lunora-auth-link" type="button" (click)="useBackupCode.set(true)">{{ t.backupCodeSignIn }}</button>
                </lunora-auth-card>
            }
        }
    `,
})
class TwoFactorCardComponent implements OnInit {
    readonly method = input<"otp" | "totp">();
    readonly trustDevice = input<boolean>();

    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "twoFactor", "TwoFactorCard"));
    private readonly injector = inject(Injector);
    protected readonly t = this.context().localization;
    protected state!: Signal<FormState<TwoFactorField>>;
    protected actions!: FormActions<TwoFactorField>;
    protected backupState!: Signal<FormState<BackupCodeSignInField>>;
    protected backupActions!: FormActions<BackupCodeSignInField>;

    /**
     * Both controllers stay live regardless of which form is showing — a
     * session-mutating submit must not depend on the toggle's current position.
     */
    protected readonly useBackupCode = signal(false);

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createTwoFactorVerifyController(context, { method: this.method(), trustDevice: this.trustDevice() }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;

        const backupBridge = controllerSignal((context) => createBackupCodeSignInController(context, { trustDevice: this.trustDevice() }), {
            context: this.context,
            injector: this.injector,
        });

        this.backupState = backupBridge.state;
        this.backupActions = backupBridge.actions;
    }
}

export {
    AnonymousButtonComponent,
    EmailOtpCardComponent,
    ForgotPasswordCardComponent,
    MagicLinkCardComponent,
    ResetPasswordCardComponent,
    ResetPasswordOtpCardComponent,
    SignInCardComponent,
    SignUpCardComponent,
    TwoFactorCardComponent,
};
