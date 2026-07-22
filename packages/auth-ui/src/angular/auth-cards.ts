/**
 * The authentication cards, mirroring the React `auth-cards.tsx` 1:1: sign-in
 * (with social + forgot/sign-up links), sign-up, forgot-password, reset-password,
 * magic-link, email-OTP (two-step), and two-factor verify. Each is a thin
 * standalone component binding a core controller to the shared view primitives.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input } from "@angular/core";

import type { EmailOtpActions, EmailOtpState, ForgotPasswordField, FormActions, FormState, ResetPasswordField, TwoFactorField } from "../core";
import {
    createEmailOtpController,
    createForgotPasswordController,
    createMagicLinkController,
    createResetPasswordController,
    createSignInController,
    createSignUpController,
    createTwoFactorVerifyController,
    signInWithSocial,
} from "../core";
import { controllerSignal } from "./controller-signal";
import {
    AuthCardComponent,
    AuthDividerComponent,
    AuthFieldComponent,
    AuthLinkComponent,
    FormBannerComponent,
    SocialButtonsComponent,
    SubmitButtonComponent,
} from "./primitives";
import { injectAuthUI } from "./provider";

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
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
        <lunora-auth-card [title]="t.signIn" [footer]="true">
            <lunora-auth-social-buttons [providers]="social" (select)="signInSocial($event)" />
            @if (social.length > 0) {
                <lunora-auth-divider />
            }
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
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.signIn }}</lunora-auth-submit-button>
            </form>
            <lunora-auth-link lunoraAuthCardFooter [href]="signUpHref()">{{ t.noAccount }}</lunora-auth-link>
        </lunora-auth-card>
    `,
})
class SignInCardComponent {
    readonly forgotPasswordHref = input("/forgot-password");
    readonly signUpHref = input("/sign-up");

    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    protected readonly social = this.context.social;
    private readonly bridge = controllerSignal(createSignInController, { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;

    protected signInSocial(provider: string): void {
        void signInWithSocial(this.context, provider);
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, AuthLinkComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-sign-up-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.signUp" [footer]="true">
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
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.signUp }}</lunora-auth-submit-button>
            </form>
            <lunora-auth-link lunoraAuthCardFooter [href]="signInHref()">{{ t.haveAccount }}</lunora-auth-link>
        </lunora-auth-card>
    `,
})
class SignUpCardComponent {
    readonly signInHref = input("/sign-in");

    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createSignUpController, { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;
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

    private readonly context = injectAuthUI();
    private readonly destroyRef = inject(DestroyRef);
    protected readonly t = this.context.localization;
    protected state!: Signal<FormState<ForgotPasswordField>>;
    protected actions!: FormActions<ForgotPasswordField>;

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createForgotPasswordController(context, { resetPath: this.resetPath() }), {
            context: this.context,
            destroyRef: this.destroyRef,
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
    /** The reset token from the URL (`?token=...`). */
    readonly token = input<string>();

    private readonly context = injectAuthUI();
    private readonly destroyRef = inject(DestroyRef);
    protected readonly t = this.context.localization;
    protected state!: Signal<FormState<ResetPasswordField>>;
    protected actions!: FormActions<ResetPasswordField>;

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createResetPasswordController(context, { token: this.token() }), {
            context: this.context,
            destroyRef: this.destroyRef,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, AuthLinkComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-magic-link-card",
    standalone: true,
    template: `
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
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.magicLink }}</lunora-auth-submit-button>
            </form>
            <lunora-auth-link lunoraAuthCardFooter [href]="signInHref()">{{ t.backToSignIn }}</lunora-auth-link>
        </lunora-auth-card>
    `,
})
class MagicLinkCardComponent {
    readonly signInHref = input("/sign-in");

    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createMagicLinkController, { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-email-otp-card",
    standalone: true,
    template: `
        @if (state().step === "verify") {
            <lunora-auth-card [title]="t.emailOtp" [description]="t.emailOtpSent" [footer]="true">
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.verify()">
                    <lunora-auth-banner [error]="state().formError" />
                    <lunora-auth-field
                        [field]="state().code"
                        [label]="t.codeLabel"
                        name="code"
                        autoComplete="one-time-code"
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
    `,
})
class EmailOtpCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
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
        <lunora-auth-card [title]="t.twoFactor">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" />
                <lunora-auth-field
                    [field]="state().fields.code"
                    [label]="t.codeLabel"
                    name="code"
                    autoComplete="one-time-code"
                    (changed)="actions.setField('code', $event)"
                    (blurred)="actions.blur('code')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.twoFactor }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class TwoFactorCardComponent implements OnInit {
    readonly method = input<"otp" | "totp">();
    readonly trustDevice = input<boolean>();

    private readonly context = injectAuthUI();
    private readonly destroyRef = inject(DestroyRef);
    protected readonly t = this.context.localization;
    protected state!: Signal<FormState<TwoFactorField>>;
    protected actions!: FormActions<TwoFactorField>;

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createTwoFactorVerifyController(context, { method: this.method(), trustDevice: this.trustDevice() }), {
            context: this.context,
            destroyRef: this.destroyRef,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }
}

export {
    EmailOtpCardComponent,
    ForgotPasswordCardComponent,
    MagicLinkCardComponent,
    ResetPasswordCardComponent,
    SignInCardComponent,
    SignUpCardComponent,
    TwoFactorCardComponent,
};
