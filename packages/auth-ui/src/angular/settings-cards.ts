/**
 * Account & security settings cards, mirroring the React `settings-cards.tsx`
 * 1:1: profile, change-email, change-password, delete-account, active-sessions,
 * and the sign-out button. Each binds a core controller to the shared primitives.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, Injector, input, signal } from "@angular/core";

import type { ChangeEmailField } from "../core/change-email";
import { createChangeEmailController } from "../core/change-email";
import type { ChangePasswordField } from "../core/change-password";
import { createChangePasswordController } from "../core/change-password";
import type { ResourceState } from "../core/create-resource-controller";
import type { DeleteAccountField } from "../core/delete-account";
import { createDeleteAccountController } from "../core/delete-account";
import { isFlowEnabled } from "../core/flow-gate";
import { passkeyLabel, sessionLabel } from "../core/labels";
import { createPasskeysController } from "../core/passkeys";
import type { ProfileField } from "../core/profile";
import { createProfileController } from "../core/profile";
import { signOut } from "../core/session-actions";
import type { SessionsActions } from "../core/sessions";
import { createSessionsController } from "../core/sessions";
import type { AuthSession, FormActions, FormState } from "../core/types";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, serializeThemeVariables, SubmitButtonComponent } from "./primitives";
import { injectAuthUIContext } from "./provider";

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

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly t = this.context().localization;
    protected state!: Signal<FormState<ProfileField>>;
    protected actions!: FormActions<ProfileField>;

    ngOnInit(): void {
        const bridge = controllerSignal((context) => createProfileController(context, { initialImage: this.defaultImage(), initialName: this.defaultName() }), {
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
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
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
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
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
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
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
                    @for (session of state().items; track session.id ?? session.token ?? sessionLabel(session, t)) {
                        <li class="lunora-auth-list__item">
                            <span class="lunora-auth-list__label">{{ sessionLabel(session, t) }}</span>
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
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createSessionsController, { context: this.context });
    protected readonly state: Signal<ResourceState<AuthSession>> = this.bridge.state;
    protected readonly actions: SessionsActions = this.bridge.actions;

    /** Delegates to the shared helper — Angular templates can only call members. */
    protected sessionLabel = sessionLabel;
}

/**
 * Registered passkeys: list, add (WebAuthn ceremony), remove. The controller
 * also exposes `rename`; it is left out of the default card so all five ports
 * render the same thing — wire it up yourself if you want inline renaming.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-passkeys-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.passkeys">
                <lunora-auth-banner [error]="state().error" />
                @if (state().loading) {
                    <p class="lunora-auth-card__description">…</p>
                } @else if (state().items.length === 0) {
                    <p class="lunora-auth-card__description">{{ t.passkeysEmpty }}</p>
                } @else {
                    <ul class="lunora-auth-list">
                        @for (passkey of state().items; track passkey.id ?? passkeyLabel(passkey, t)) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{{ passkeyLabel(passkey, t) }}</span>
                                @if (passkey.id !== undefined) {
                                    <button class="lunora-auth-link" type="button" [disabled]="state().busy" (click)="remove(passkey.id!)">
                                        {{ t.remove }}
                                    </button>
                                }
                            </li>
                        }
                    </ul>
                }
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); add()">
                    <lunora-auth-field [field]="{ touched: false, value: name() }" [label]="t.passkeyName" name="passkeyName" (changed)="name.set($event)" />
                    <lunora-auth-submit-button [pending]="state().busy">{{ t.passkeyAdd }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class PasskeysCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "passkey", "PasskeysCard"));
    protected readonly t = this.context().localization;
    protected readonly name = signal("");

    private readonly bridge = controllerSignal((context) => createPasskeysController(context, { autoLoad: this.enabled() }), { context: this.context });
    protected readonly state = this.bridge.state;
    protected readonly actions = this.bridge.actions;

    /** Delegates to the shared helper — Angular templates can only call members. */
    protected passkeyLabel = passkeyLabel;

    protected add(): void {
        void this.actions.add(this.name()).then(() => {
            this.name.set("");

            return true;
        });
    }

    protected remove(id: string): void {
        void this.actions.remove(id);
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-sign-out-button",
    standalone: true,
    template: `
        <button class="lunora-auth-button lunora-auth-button--secondary" type="button" [attr.style]="themeStyle" (click)="signOut()">
            {{ label() ?? t.signOut }}
        </button>
    `,
})
class SignOutButtonComponent {
    readonly label = input<string>();

    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    protected readonly themeStyle = serializeThemeVariables(this.context().themeVariables);

    protected signOut(): void {
        void signOut(this.context());
    }
}

export {
    ChangeEmailCardComponent,
    ChangePasswordCardComponent,
    DeleteAccountCardComponent,
    PasskeysCardComponent,
    ProfileCardComponent,
    SessionsCardComponent,
    SignOutButtonComponent,
};
