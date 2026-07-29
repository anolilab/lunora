/**
 * Email-verification and invitation cards, mirroring the React
 * `verify-invite-cards.tsx` 1:1: the page a verification link lands on, the
 * "send me another" form beside it, the screen an organization invitation link
 * lands on, and the signed-in user's invitation inbox.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, inject, Injector, input } from "@angular/core";

import { queryParameter } from "../core/browser-location";
import type { ResourceState } from "../core/create-resource-controller";
import type { AcceptInvitationActions, AcceptInvitationState, UserInvitationsActions } from "../core/invitations";
import { createAcceptInvitationController, createUserInvitationsController } from "../core/invitations";
import type { AuthInvitationDetail, FormActions, FormState } from "../core/types";
import type { ResendVerificationField, VerifyEmailActions, VerifyEmailState } from "../core/verify-email";
import { createResendVerificationController, createVerifyEmailController } from "../core/verify-email";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, SkeletonComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUIContext } from "./provider";

/**
 * The page the verification link lands on. It consumes the token on mount and
 * redirects, so the only states a user sees are "working" and "that link is no
 * longer good".
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent],
    selector: "lunora-verify-email-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.verifyEmail">
            <lunora-auth-banner [error]="state().error" />
            @if (state().status === "submitting" || state().status === "idle") {
                <p class="lunora-auth-note">{{ t.verifyEmailVerifying }}</p>
            }
            @if (state().status === "error") {
                <button class="lunora-auth-button lunora-auth-button--secondary" type="button" (click)="verify()">{{ t.verifyEmailResend }}</button>
            }
        </lunora-auth-card>
    `,
})
class VerifyEmailCardComponent implements OnInit {
    /** Defaults to `?token=` from the URL. */
    readonly token = input<string>();

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly t = this.context().localization;
    protected state!: Signal<VerifyEmailState>;
    private actions!: VerifyEmailActions;

    // Built in ngOnInit, not a field initializer: `token()` is unbound until
    // Angular has set the inputs, so the controller would consume the URL's
    // token even when the caller passed one of their own.
    ngOnInit(): void {
        const resolved = this.token() ?? queryParameter("token");
        const bridge = controllerSignal((context) => createVerifyEmailController(context, { token: resolved }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }

    protected verify(): void {
        void this.actions.verify();
    }
}

/** "Send me another link" — the companion to {@link VerifyEmailCardComponent}. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-resend-verification-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.verifyEmail">
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
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.verifyEmailResend }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class ResendVerificationCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createResendVerificationController, { context: this.context });
    protected readonly state: Signal<FormState<ResendVerificationField>> = this.bridge.state;
    protected readonly actions: FormActions<ResendVerificationField> = this.bridge.actions;
}

/**
 * The screen an organization invitation link lands on.
 *
 * It renders the organization's name before asking for a decision — an "Accept"
 * button with nothing above it is not consent — and bounces through sign-in when
 * there is no session, returning to this same invitation afterwards.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent],
    selector: "lunora-accept-invitation-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.invitationTitle" [description]="state().invitation?.organizationName">
            <lunora-auth-banner [error]="state().error" />
            @if (state().loading) {
                <lunora-auth-skeleton [rows]="2" />
            } @else {
                <div class="lunora-auth-actions">
                    <button
                        class="lunora-auth-button"
                        type="button"
                        [disabled]="state().status === 'submitting' || state().invitation === undefined"
                        (click)="accept()"
                    >
                        {{ t.invitationAccept }}
                    </button>
                    <button
                        class="lunora-auth-button lunora-auth-button--secondary"
                        type="button"
                        [disabled]="state().status === 'submitting' || state().invitation === undefined"
                        (click)="reject()"
                    >
                        {{ t.invitationReject }}
                    </button>
                </div>
            }
        </lunora-auth-card>
    `,
})
class AcceptInvitationCardComponent implements OnInit {
    /** Defaults to `?invitationId=` from the URL. */
    readonly invitationId = input<string>();

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly t = this.context().localization;
    protected state!: Signal<AcceptInvitationState>;
    private actions!: AcceptInvitationActions;

    // Built in ngOnInit, not a field initializer: `invitationId()` is unbound
    // until Angular has set the inputs.
    ngOnInit(): void {
        const resolved = this.invitationId() ?? queryParameter("invitationId");
        const bridge = controllerSignal((context) => createAcceptInvitationController(context, { invitationId: resolved }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }

    protected accept(): void {
        void this.actions.accept();
    }

    protected reject(): void {
        void this.actions.reject();
    }
}

/** Every invitation waiting for the signed-in user, decidable in place. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent],
    selector: "lunora-user-invitations-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.invitations">
            <lunora-auth-banner [error]="state().error" />
            @if (state().loading) {
                <lunora-auth-skeleton [rows]="2" />
            } @else {
                <ul class="lunora-auth-list">
                    @for (invitation of state().items; track invitation.id) {
                        <li class="lunora-auth-list__item">
                            <span class="lunora-auth-list__label">{{ invitation.organizationName ?? invitation.email }}</span>
                            <span class="lunora-auth-list__actions">
                                <button class="lunora-auth-button" type="button" [disabled]="state().busy" (click)="accept(invitation.id ?? '')">
                                    {{ t.invitationAccept }}
                                </button>
                                <button
                                    class="lunora-auth-button lunora-auth-button--secondary"
                                    type="button"
                                    [disabled]="state().busy"
                                    (click)="reject(invitation.id ?? '')"
                                >
                                    {{ t.invitationReject }}
                                </button>
                            </span>
                        </li>
                    }
                    @if (state().items.length === 0) {
                        <li class="lunora-auth-list__empty">{{ t.invitationsEmpty }}</li>
                    }
                </ul>
            }
        </lunora-auth-card>
    `,
})
class UserInvitationsCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createUserInvitationsController, { context: this.context });
    protected readonly state: Signal<ResourceState<AuthInvitationDetail>> = this.bridge.state;
    private readonly actions: UserInvitationsActions = this.bridge.actions;

    protected accept(invitationId: string): void {
        void this.actions.accept(invitationId);
    }

    protected reject(invitationId: string): void {
        void this.actions.reject(invitationId);
    }
}

export { AcceptInvitationCardComponent, ResendVerificationCardComponent, UserInvitationsCardComponent, VerifyEmailCardComponent };
