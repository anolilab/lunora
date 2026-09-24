/**
 * The one-route auth view, mirroring the React `auth-view.tsx` 1:1, plus the two
 * alternate sign-in doors the `username` and `phoneNumber` plugins add.
 */
import type { Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

import type { PluginFlags, ViewPaths } from "../core/config";
import { isFlowEnabled } from "../core/flow-gate";
import type { PhoneSignInField } from "../core/phone-number";
import { createPhoneSignInController } from "../core/phone-number";
import type { FormActions, FormState } from "../core/types";
import type { UsernameSignInField } from "../core/username";
import { createUsernameSignInController } from "../core/username";
import {
    EmailOtpCardComponent,
    ForgotPasswordCardComponent,
    MagicLinkCardComponent,
    ResetPasswordCardComponent,
    ResetPasswordOtpCardComponent,
    SignInCardComponent,
    SignUpCardComponent,
    TwoFactorCardComponent,
} from "./auth-cards";
import { controllerSignal } from "./controller-signal";
import { DeviceAuthorizationCardComponent } from "./plugin-cards";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUIContext } from "./provider";
import { AcceptInvitationCardComponent, VerifyEmailCardComponent } from "./verify-invite-cards";

/** Sign in with a username instead of an email. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-username-sign-in-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.signIn">
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                    <lunora-auth-banner [error]="state().formError" />
                    <lunora-auth-field
                        [field]="state().fields.username"
                        [label]="t.usernameLabel"
                        name="username"
                        autoComplete="username"
                        (changed)="actions.setField('username', $event)"
                        (blurred)="actions.blur('username')"
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
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.signIn }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class UsernameSignInCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "username", "UsernameSignInCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createUsernameSignInController, { context: this.context });
    protected readonly state: Signal<FormState<UsernameSignInField>> = this.bridge.state;
    protected readonly actions: FormActions<UsernameSignInField> = this.bridge.actions;
}

/** Sign in with a phone number and password. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-phone-sign-in-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.signIn">
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                    <lunora-auth-banner [error]="state().formError" />
                    <lunora-auth-field
                        [field]="state().fields.phoneNumber"
                        [label]="t.phoneLabel"
                        name="phoneNumber"
                        autoComplete="tel"
                        (changed)="actions.setField('phoneNumber', $event)"
                        (blurred)="actions.blur('phoneNumber')"
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
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.signIn }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class PhoneSignInCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "phoneNumber", "PhoneSignInCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createPhoneSignInController, { context: this.context });
    protected readonly state: Signal<FormState<PhoneSignInField>> = this.bridge.state;
    protected readonly actions: FormActions<PhoneSignInField> = this.bridge.actions;
}

/**
 * One route for every auth screen: mount this at `/auth/:view` and pass the
 * segment, instead of wiring ten routes to ten cards.
 *
 * The segments are configurable through the provider's `viewPaths`, so the URLs
 * stay the app's decision — this only maps whichever segment arrives to the card
 * that owns it. An unrecognized segment falls back to sign-in rather than
 * rendering nothing, because a typo'd auth URL should still let someone in.
 *
 * **Tell the provider where you mounted it**: `viewPaths.base` ("/auth" for
 * the route above) is what the links between the screens, `redirects.signIn`,
 * `redirects.twoFactor` and the emailed reset link are all derived from. It
 * defaults to "" — screens on root-level routes — so leaving it unset on a
 * nested mount sends a user with two-factor enabled to a route that isn't there.
 *
 * Plugin-gated views are checked here rather than left to the card's own gate. A
 * card that returns nothing leaves a blank page, which on a *route* is a dead
 * end; falling back to sign-in keeps the user moving. The cards keep their own
 * gate for when they are mounted directly.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        AcceptInvitationCardComponent,
        DeviceAuthorizationCardComponent,
        EmailOtpCardComponent,
        ForgotPasswordCardComponent,
        MagicLinkCardComponent,
        ResetPasswordCardComponent,
        ResetPasswordOtpCardComponent,
        SignInCardComponent,
        SignUpCardComponent,
        TwoFactorCardComponent,
        VerifyEmailCardComponent,
    ],
    selector: "lunora-auth-view",
    standalone: true,
    template: `
        @switch (view()) {
            @case (viewPaths().acceptInvitation) {
                <lunora-accept-invitation-card />
            }
            @case (viewPaths().deviceAuthorization) {
                @if (plugins().deviceAuthorization) {
                    <lunora-device-authorization-card />
                } @else {
                    <lunora-sign-in-card />
                }
            }
            @case (viewPaths().emailOtp) {
                @if (plugins().emailOtp) {
                    <lunora-email-otp-card />
                } @else {
                    <lunora-sign-in-card />
                }
            }
            @case (viewPaths().forgotPassword) {
                <lunora-forgot-password-card />
            }
            @case (viewPaths().magicLink) {
                @if (plugins().magicLink) {
                    <lunora-magic-link-card />
                } @else {
                    <lunora-sign-in-card />
                }
            }
            @case (viewPaths().resetPassword) {
                @if (forgotPasswordMethod() === "otp") {
                    <lunora-reset-password-otp-card />
                } @else {
                    <lunora-reset-password-card />
                }
            }
            @case (viewPaths().signUp) {
                @if (signUp()) {
                    <lunora-sign-up-card />
                } @else {
                    <lunora-sign-in-card />
                }
            }
            @case (viewPaths().twoFactor) {
                @if (plugins().twoFactor) {
                    <lunora-two-factor-card />
                } @else {
                    <lunora-sign-in-card />
                }
            }
            @case (viewPaths().verifyEmail) {
                <lunora-verify-email-card />
            }
            @default {
                <lunora-sign-in-card />
            }
        }
    `,
})
class AuthViewComponent {
    /** The URL segment, e.g. `"sign-up"`. Falls back to the sign-in card. */
    readonly view = input<string>();

    private readonly context = injectAuthUIContext();

    /** Derived, so a discovery answer that turns a plugin off redirects to sign-in. */
    protected readonly plugins: Signal<Required<PluginFlags>> = computed(() => this.context().plugins);
    protected readonly forgotPasswordMethod: Signal<"link" | "otp"> = computed(() => this.context().forgotPasswordMethod);
    /** Derived, so a discovery answer that closes self-serve sign-up redirects to sign-in. */
    protected readonly signUp: Signal<boolean> = computed(() => this.context().signUp);
    protected readonly viewPaths: Signal<Required<ViewPaths>> = computed(() => this.context().viewPaths);
}

export { AuthViewComponent, PhoneSignInCardComponent, UsernameSignInCardComponent };
