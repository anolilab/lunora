/**
 * Account & security settings cards, mirroring the React `settings-cards.tsx`
 * 1:1: profile, change-email, change-password, delete-account, active-sessions,
 * and the sign-out button. Each binds a core controller to the shared primitives.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input } from "@angular/core";

import type { AuthSession, ChangeEmailField, ChangePasswordField, DeleteAccountField, FormActions, FormState, ProfileField, SessionsActions } from "../core";
import type { ResourceState } from "../core";
import {
    createChangeEmailController,
    createChangePasswordController,
    createDeleteAccountController,
    createProfileController,
    createSessionsController,
    signOut,
} from "../core";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUI } from "./provider";

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-profile-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.profile">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                <lunora-auth-field
                    [field]="state().fields.name"
                    [label]="t.nameLabel"
                    name="name"
                    autoComplete="name"
                    (changed)="actions.setField('name', $event)"
                    (blurred)="actions.blur('name')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.saveChanges }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class ProfileCardComponent implements OnInit {
    readonly defaultImage = input<string>();
    readonly defaultName = input<string>();

    private readonly context = injectAuthUI();
    private readonly destroyRef = inject(DestroyRef);
    protected readonly t = this.context.localization;
    protected state!: Signal<FormState<ProfileField>>;
    protected actions!: FormActions<ProfileField>;

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createProfileController(context, { initialImage: this.defaultImage(), initialName: this.defaultName() }), {
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
    selector: "lunora-change-email-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.changeEmail">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                <lunora-auth-field
                    [field]="state().fields.newEmail"
                    [label]="t.newEmailLabel"
                    name="newEmail"
                    type="email"
                    autoComplete="email"
                    (changed)="actions.setField('newEmail', $event)"
                    (blurred)="actions.blur('newEmail')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.changeEmail }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class ChangeEmailCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createChangeEmailController, { context: this.context });
    protected readonly state: Signal<FormState<ChangeEmailField>> = this.bridge.state;
    protected readonly actions: FormActions<ChangeEmailField> = this.bridge.actions;
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-change-password-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.changePassword">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                <lunora-auth-field
                    [field]="state().fields.currentPassword"
                    [label]="t.currentPasswordLabel"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    (changed)="actions.setField('currentPassword', $event)"
                    (blurred)="actions.blur('currentPassword')"
                />
                <lunora-auth-field
                    [field]="state().fields.newPassword"
                    [label]="t.newPasswordLabel"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    (changed)="actions.setField('newPassword', $event)"
                    (blurred)="actions.blur('newPassword')"
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
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.changePassword }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class ChangePasswordCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createChangePasswordController, { context: this.context });
    protected readonly state: Signal<FormState<ChangePasswordField>> = this.bridge.state;
    protected readonly actions: FormActions<ChangePasswordField> = this.bridge.actions;
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-delete-account-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.deleteAccount" [description]="t.deleteAccountWarning">
            <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                <lunora-auth-banner [error]="state().formError" />
                <lunora-auth-field
                    [field]="state().fields.password"
                    [label]="t.passwordLabel"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    (changed)="actions.setField('password', $event)"
                    (blurred)="actions.blur('password')"
                />
                <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.deleteAccount }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class DeleteAccountCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createDeleteAccountController, { context: this.context });
    protected readonly state: Signal<FormState<DeleteAccountField>> = this.bridge.state;
    protected readonly actions: FormActions<DeleteAccountField> = this.bridge.actions;
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent],
    selector: "lunora-sessions-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.sessions">
            <lunora-auth-banner [error]="state().error" />
            @if (state().loading) {
                <p class="lunora-auth-card__description">…</p>
            } @else if (state().items.length === 0) {
                <p class="lunora-auth-card__description">{{ t.sessionsEmpty }}</p>
            } @else {
                <ul class="lunora-auth-list">
                    @for (session of state().items; track session.id ?? session.token ?? sessionLabel(session)) {
                        <li class="lunora-auth-list__item">
                            <span class="lunora-auth-list__label">{{ sessionLabel(session) }}</span>
                            @if (session.token !== undefined) {
                                <button class="lunora-auth-link" type="button" [disabled]="state().busy" (click)="actions.revoke(session.token!)">
                                    {{ t.revoke }}
                                </button>
                            }
                        </li>
                    }
                </ul>
            }
            <button class="lunora-auth-button lunora-auth-button--secondary" type="button" [disabled]="state().busy" (click)="actions.revokeOthers()">
                {{ t.revokeOthers }}
            </button>
        </lunora-auth-card>
    `,
})
class SessionsCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createSessionsController, { context: this.context });
    protected readonly state: Signal<ResourceState<AuthSession>> = this.bridge.state;
    protected readonly actions: SessionsActions = this.bridge.actions;

    protected sessionLabel(session: AuthSession): string {
        const agent = session.userAgent?.trim();

        return agent === undefined || agent === "" ? (session.ipAddress ?? "Unknown device") : agent;
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-sign-out-button",
    standalone: true,
    template: `
        <button class="lunora-auth-button lunora-auth-button--secondary" type="button" (click)="signOut()">
            {{ label() ?? t.signOut }}
        </button>
    `,
})
class SignOutButtonComponent {
    readonly label = input<string>();

    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;

    protected signOut(): void {
        void signOut(this.context);
    }
}

export {
    ChangeEmailCardComponent,
    ChangePasswordCardComponent,
    DeleteAccountCardComponent,
    ProfileCardComponent,
    SessionsCardComponent,
    SignOutButtonComponent,
};
