/**
 * Account settings cards, mirroring the React `account-cards.tsx` 1:1: linked
 * OAuth accounts, avatar upload, the username claim, and the light/dark/system
 * appearance row.
 */
import type { Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed } from "@angular/core";

import type { AccountsActions } from "../core/accounts";
import { createAccountsController, linkableProviders, NON_SOCIAL_PROVIDERS } from "../core/accounts";
import type { AvatarUploadActions, AvatarUploadState } from "../core/avatar";
import { ACCEPT_ATTRIBUTE, createAvatarUploadController } from "../core/avatar";
import type { ResourceState } from "../core/create-resource-controller";
import { isFlowEnabled } from "../core/flow-gate";
import { providerLabel } from "../core/labels";
import type { ThemeMode, ThemeModeActions, ThemeModeState } from "../core/theme-mode";
import { createThemeModeController, THEME_MODES } from "../core/theme-mode";
import type { AuthAccount, FormActions, FormState } from "../core/types";
import type { SetUsernameField } from "../core/username";
import { createSetUsernameController } from "../core/username";
import type { UsernameAvailabilityActions, UsernameAvailabilityState } from "../core/username-availability";
import { createUsernameAvailabilityController } from "../core/username-availability";
import { controllerSignal } from "./controller-signal";
import {
    AuthCardComponent,
    AuthFieldComponent,
    FormBannerComponent,
    SkeletonComponent,
    SubmitButtonComponent,
    UsernameAvailabilityComponent,
} from "./primitives";
import { injectAuthUIContext } from "./provider";
import { UserAvatarComponent } from "./user-button";

/**
 * Which OAuth providers are attached, with link/unlink.
 *
 * The "available to link" list is `context.social` minus what is already
 * attached — so with server discovery on, it is exactly the providers the
 * deployment configured, and an app that adds one gets a new button with no
 * client change.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent],
    selector: "lunora-linked-accounts-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.accountsTitle">
            <lunora-auth-banner [error]="state().error" />
            @if (state().loading) {
                <lunora-auth-skeleton />
            } @else {
                <ul class="lunora-auth-list">
                    @for (account of state().items; track account.id ?? account.providerId) {
                        <li class="lunora-auth-list__item">
                            <span class="lunora-auth-list__label">{{ providerLabel(account.providerId ?? "") }}</span>
                            <!--
                              "credential" is the password and "passkey" rows belong to
                              <lunora-passkeys-card>; offering "unlink" for either would be
                              a button that either fails or deletes the wrong thing.
                            -->
                            @if (!isNonSocial(account.providerId ?? "")) {
                                <button
                                    class="lunora-auth-button lunora-auth-button--danger"
                                    type="button"
                                    [disabled]="state().busy || state().items.length <= 1"
                                    (click)="unlink(account)"
                                >
                                    {{ t.remove }}
                                </button>
                            }
                        </li>
                    }
                    @if (state().items.length === 0) {
                        <li class="lunora-auth-list__empty">{{ t.accountsEmpty }}</li>
                    }
                </ul>
            }
            @if (linkable().length > 0) {
                <div class="lunora-auth-social">
                    @for (provider of linkable(); track provider) {
                        <button class="lunora-auth-button lunora-auth-button--secondary" type="button" [disabled]="state().busy" (click)="link(provider)">
                            {{ t.accountsLink }}: {{ providerLabel(provider) }}
                        </button>
                    }
                </div>
            }
        </lunora-auth-card>
    `,
})
class LinkedAccountsCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createAccountsController, { context: this.context });
    protected readonly state: Signal<ResourceState<AuthAccount>> = this.bridge.state;
    private readonly actions: AccountsActions = this.bridge.actions;

    protected readonly linkable = computed(() => linkableProviders(this.state().items, this.context().social));

    /** Delegates to the shared helper — Angular templates can only call members. */
    protected readonly providerLabel = providerLabel;

    // eslint-disable-next-line class-methods-use-this -- a pure predicate the template calls; a field would allocate one closure per instance.
    protected isNonSocial(providerId: string): boolean {
        return NON_SOCIAL_PROVIDERS.has(providerId);
    }

    protected link(provider: string): void {
        void this.actions.link(provider);
    }

    protected unlink(account: AuthAccount): void {
        void this.actions.unlink(account.providerId ?? "", account.accountId);
    }
}

/**
 * Avatar upload. Rendered only when the app configured an `avatar.upload`
 * handler — without one there is nowhere to put the bytes, and
 * `&lt;lunora-profile-card>`'s URL field is the honest fallback.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, UserAvatarComponent],
    selector: "lunora-avatar-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.avatar">
                <lunora-auth-banner [error]="state().error" />
                <div class="lunora-auth-avatar-row">
                    <lunora-user-avatar [size]="64" [user]="{ image: state().imageUrl }" />
                    <div class="lunora-auth-avatar-row__actions">
                        <input class="lunora-auth-visually-hidden" type="file" #picker [attr.accept]="accept" (change)="pick($event)" />
                        <button class="lunora-auth-button" type="button" [disabled]="state().status === 'submitting'" (click)="picker.click()">
                            {{ t.avatarUpload }}
                        </button>
                        @if (state().imageUrl !== undefined && state().imageUrl !== "") {
                            <button
                                class="lunora-auth-button lunora-auth-button--danger"
                                type="button"
                                [disabled]="state().status === 'submitting'"
                                (click)="remove()"
                            >
                                {{ t.avatarRemove }}
                            </button>
                        }
                    </div>
                </div>
            </lunora-auth-card>
        }
    `,
})
class AvatarCardComponent {
    private readonly context = injectAuthUIContext();
    /** Config, not discovery — but derived anyway so every gate reads the same way. */
    protected readonly enabled = computed(() => this.context().avatar.upload !== undefined);
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createAvatarUploadController, { context: this.context });
    protected readonly state: Signal<AvatarUploadState> = this.bridge.state;
    private readonly actions: AvatarUploadActions = this.bridge.actions;

    protected readonly accept = ACCEPT_ATTRIBUTE;

    protected pick(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];

        // Clear the input so re-picking the same file after a failure still
        // fires `change` — browsers suppress it when the value is unchanged.
        input.value = "";

        if (file) {
            void this.actions.upload(file);
        }
    }

    protected remove(): void {
        void this.actions.remove();
    }
}

/** Claim or change the username, when the `username` plugin is on. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent, UsernameAvailabilityComponent],
    selector: "lunora-set-username-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.usernameLabel">
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                    <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                    <lunora-auth-field
                        [field]="state().fields.username"
                        [label]="t.usernameLabel"
                        name="username"
                        autoComplete="username"
                        (changed)="setUsername($event)"
                        (blurred)="actions.blur('username')"
                    />
                    <lunora-auth-username-availability [status]="availability().status" />
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.saveChanges }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class SetUsernameCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "username", "SetUsernameCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal(createSetUsernameController, { context: this.context });
    protected readonly state: Signal<FormState<SetUsernameField>> = this.bridge.state;
    protected readonly actions: FormActions<SetUsernameField> = this.bridge.actions;

    // Checked as the user types, so a taken name surfaces here rather than as a
    // failed save with the field already blurred.
    private readonly availabilityBridge = controllerSignal(createUsernameAvailabilityController, { context: this.context });
    protected readonly availability: Signal<UsernameAvailabilityState> = this.availabilityBridge.state;
    private readonly availabilityActions: UsernameAvailabilityActions = this.availabilityBridge.actions;

    protected setUsername(value: string): void {
        this.actions.setField("username", value);
        this.availabilityActions.check(value);
    }
}

/**
 * Light / dark / system. Not a better-auth feature at all — it lives here
 * because account settings is where people look for it.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent],
    selector: "lunora-appearance-card",
    standalone: true,
    template: `
        <lunora-auth-card [title]="t.appearance">
            <div class="lunora-auth-segmented" role="radiogroup">
                @for (mode of modes; track mode) {
                    <button
                        class="lunora-auth-segmented__option"
                        type="button"
                        role="radio"
                        [attr.aria-checked]="state().mode === mode"
                        (click)="actions.setMode(mode)"
                    >
                        {{ label(mode) }}
                    </button>
                }
            </div>
        </lunora-auth-card>
    `,
})
class AppearanceCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly t = this.context().localization;
    // The theme controller is the one that takes no context — it is not a
    // better-auth flow — so the factory's argument is ignored.
    private readonly bridge = controllerSignal(() => createThemeModeController(), { context: this.context });
    protected readonly state: Signal<ThemeModeState> = this.bridge.state;
    protected readonly actions: ThemeModeActions = this.bridge.actions;

    protected readonly modes = THEME_MODES;

    protected label(mode: ThemeMode): string {
        if (mode === "dark") {
            return this.t.themeDark;
        }

        return mode === "light" ? this.t.themeLight : this.t.themeSystem;
    }
}

export { AppearanceCardComponent, AvatarCardComponent, LinkedAccountsCardComponent, SetUsernameCardComponent };
