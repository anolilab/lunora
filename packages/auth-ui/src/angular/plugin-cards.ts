/**
 * Plugin-gated cards, mirroring the React `plugin-cards.tsx` 1:1: the accounts
 * signed in on this device, the admin user table, device-code approval, the
 * organization's teams, and backup-code regeneration.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, Injector, input, signal } from "@angular/core";

import type { AdminUsersActions, AdminUsersState } from "../core/admin-users";
import { createAdminUsersController } from "../core/admin-users";
import type { BackupCodesField } from "../core/backup-codes";
import { createBackupCodesController } from "../core/backup-codes";
import { queryParameter } from "../core/browser-location";
import type { ResourceState } from "../core/create-resource-controller";
import type { DeviceAuthorizationActions, DeviceAuthorizationState } from "../core/device-authorization";
import { createDeviceAuthorizationController } from "../core/device-authorization";
import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS } from "../core/labels";
import type { DeviceSessionsActions } from "../core/multi-session";
import { createDeviceSessionsController } from "../core/multi-session";
import type { TeamsActions } from "../core/teams";
import { createTeamsController } from "../core/teams";
import type { AuthDeviceSession, AuthTeam, FormActions, FormState } from "../core/types";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, SkeletonComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUIContext } from "./provider";
import { UserViewComponent } from "./user-button";

/**
 * The accounts signed in on *this device*, with switch and sign-out-just-this.
 *
 * Not `<lunora-sessions-card>`, which lists this account's sessions across every
 * device. The two are a keystroke apart in better-auth's API and mean opposite
 * things.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent, UserViewComponent],
    selector: "lunora-multi-session-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.multiSessionTitle">
                <lunora-auth-banner [error]="state().error" />
                @if (state().loading) {
                    <lunora-auth-skeleton [rows]="2" />
                } @else {
                    <ul class="lunora-auth-list">
                        @for (entry of state().items; track entry.session?.token ?? entry.user?.id) {
                            <li class="lunora-auth-list__item">
                                <lunora-user-view [compact]="true" [user]="entry.user" />
                                <span class="lunora-auth-list__actions">
                                    <button
                                        class="lunora-auth-button lunora-auth-button--secondary"
                                        type="button"
                                        [disabled]="state().busy"
                                        (click)="setActive(entry.session?.token ?? '')"
                                    >
                                        {{ t.switchAccount }}
                                    </button>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--danger"
                                        type="button"
                                        [disabled]="state().busy"
                                        (click)="revoke(entry.session?.token ?? '')"
                                    >
                                        {{ t.signOut }}
                                    </button>
                                </span>
                            </li>
                        }
                        @if (state().items.length === 0) {
                            <li class="lunora-auth-list__empty">{{ t.multiSessionEmpty }}</li>
                        }
                    </ul>
                }
            </lunora-auth-card>
        }
    `,
})
class MultiSessionCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "multiSession", "MultiSessionCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal((context) => createDeviceSessionsController(context, { autoLoad: this.enabled() }), { context: this.context });
    protected readonly state: Signal<ResourceState<AuthDeviceSession>> = this.bridge.state;
    private readonly actions: DeviceSessionsActions = this.bridge.actions;

    protected revoke(sessionToken: string): void {
        void this.actions.revoke(sessionToken);
    }

    protected setActive(sessionToken: string): void {
        void this.actions.setActive(sessionToken);
    }
}

/**
 * The admin plugin's user table.
 *
 * Every action here is destructive or privilege-changing, so none of them are
 * optimistic and none are one click from a row's primary target — impersonation
 * in particular navigates away rather than mutating in place, because the whole
 * app is a different user afterwards.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent],
    selector: "lunora-admin-users-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.adminTitle">
                <lunora-auth-banner [error]="state().error" />
                <input
                    class="lunora-auth-field__input"
                    type="search"
                    [attr.aria-label]="t.adminSearch"
                    [attr.placeholder]="t.adminSearch"
                    [value]="state().extra.search"
                    (input)="search($any($event.target).value)"
                />
                @if (state().loading) {
                    <lunora-auth-skeleton />
                } @else {
                    <ul class="lunora-auth-list">
                        @for (user of state().items; track user.id) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">
                                    {{ user.email }}
                                    @if (user.banned === true) {
                                        <span class="lunora-auth-badge">{{ t.adminBan }}</span>
                                    }
                                </span>
                                <span class="lunora-auth-list__actions">
                                    <select
                                        class="lunora-auth-select"
                                        [attr.aria-label]="t.roleLabel"
                                        [disabled]="state().busy"
                                        [value]="user.role ?? 'user'"
                                        (change)="setRole(user.id ?? '', $any($event.target).value)"
                                    >
                                        @for (role of roleOptions; track role) {
                                            <option [value]="role">{{ role }}</option>
                                        }
                                    </select>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--secondary"
                                        type="button"
                                        [disabled]="state().busy"
                                        (click)="impersonate(user.id ?? '')"
                                    >
                                        {{ t.adminImpersonate }}
                                    </button>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--danger"
                                        type="button"
                                        [disabled]="state().busy"
                                        (click)="toggleBan(user.id ?? '', user.banned === true)"
                                    >
                                        {{ user.banned === true ? t.adminUnban : t.adminBan }}
                                    </button>
                                </span>
                            </li>
                        }
                        @if (state().items.length === 0) {
                            <li class="lunora-auth-list__empty">{{ t.adminUsersEmpty }}</li>
                        }
                    </ul>
                }
            </lunora-auth-card>
        }
    `,
})
class AdminUsersCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "admin", "AdminUsersCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal((context) => createAdminUsersController(context, { autoLoad: this.enabled() }), { context: this.context });
    protected readonly state: Signal<AdminUsersState> = this.bridge.state;
    private readonly actions: AdminUsersActions = this.bridge.actions;

    /** `user` is not one of the assignable roles, but it is the default one. */
    protected readonly roleOptions: ReadonlyArray<string> = ["user", ...ROLE_OPTIONS];

    protected impersonate(userId: string): void {
        void this.actions.impersonate(userId);
    }

    protected search(value: string): void {
        void this.actions.setSearch(value);
    }

    protected setRole(userId: string, role: string): void {
        void this.actions.setRole(userId, role);
    }

    protected toggleBan(userId: string, banned: boolean): void {
        void (banned ? this.actions.unban(userId) : this.actions.ban(userId));
    }
}

/**
 * Approve or deny a device code.
 *
 * A code arriving in the URL prefills the field and never submits: a link that
 * silently grants access to whatever device sent it is exactly what this flow
 * exists to make visible.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent],
    selector: "lunora-device-authorization-card",
    standalone: true,
    template: `
        @if (enabled()) {
            @if (state().decision !== undefined) {
                <lunora-auth-card [title]="t.deviceTitle">
                    <lunora-auth-banner [success]="state().decision === 'approved' ? t.deviceApproved : t.deviceDenied" />
                </lunora-auth-card>
            } @else {
                <lunora-auth-card [title]="t.deviceTitle">
                    <lunora-auth-banner [error]="state().error" />
                    <lunora-auth-field
                        [field]="{ touched: false, value: state().code }"
                        [label]="t.deviceCodeLabel"
                        name="user_code"
                        (changed)="actions.setCode($event)"
                    />
                    <div class="lunora-auth-actions">
                        <button class="lunora-auth-button" type="button" [disabled]="state().status === 'submitting'" (click)="approve()">
                            {{ t.deviceApprove }}
                        </button>
                        <button
                            class="lunora-auth-button lunora-auth-button--secondary"
                            type="button"
                            [disabled]="state().status === 'submitting'"
                            (click)="deny()"
                        >
                            {{ t.deviceDeny }}
                        </button>
                    </div>
                </lunora-auth-card>
            }
        }
    `,
})
class DeviceAuthorizationCardComponent implements OnInit {
    /** Defaults to `?user_code=` from the URL. */
    readonly userCode = input<string>();

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "deviceAuthorization", "DeviceAuthorizationCard"));
    protected readonly t = this.context().localization;
    protected state!: Signal<DeviceAuthorizationState>;
    protected actions!: DeviceAuthorizationActions;

    // Built in ngOnInit, not a field initializer: `userCode()` is unbound until
    // Angular has set the inputs, so the field would never prefill from a prop.
    ngOnInit(): void {
        const resolved = this.userCode() ?? queryParameter("user_code");
        const bridge = controllerSignal((context) => createDeviceAuthorizationController(context, { userCode: resolved }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }

    protected approve(): void {
        void this.actions.approve();
    }

    protected deny(): void {
        void this.actions.deny();
    }
}

/**
 * Teams in the active organization.
 *
 * Gated on `context.organization.teams` rather than a flow flag: teams are an
 * option of the one `organization` plugin, so no plugin id reveals them and the
 * server reports them from the resolved table map instead.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SkeletonComponent, SubmitButtonComponent],
    selector: "lunora-teams-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.teams">
                <lunora-auth-banner [error]="state().error" />
                @if (state().loading) {
                    <lunora-auth-skeleton [rows]="2" />
                } @else {
                    <ul class="lunora-auth-list">
                        @for (team of state().items; track team.id) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{{ team.name }}</span>
                                <button
                                    class="lunora-auth-button lunora-auth-button--danger"
                                    type="button"
                                    [disabled]="state().busy"
                                    (click)="remove(team.id ?? '')"
                                >
                                    {{ t.remove }}
                                </button>
                            </li>
                        }
                        @if (state().items.length === 0) {
                            <li class="lunora-auth-list__empty">{{ t.teamsEmpty }}</li>
                        }
                    </ul>
                }
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); create()">
                    <lunora-auth-field [field]="{ touched: false, value: name() }" [label]="t.teamNameLabel" name="team" (changed)="name.set($event)" />
                    <lunora-auth-submit-button [pending]="state().busy">{{ t.saveChanges }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class TeamsCardComponent {
    private readonly context = injectAuthUIContext();
    /*
     * The only gate in the set that can flip *on* mid-life: teams are off until
     * the server reports the team tables. That is exactly why the bridge rebuilds
     * the controller on a context swap — `autoLoad` is re-decided with it, so the
     * card that appears has already asked for its list.
     */
    protected readonly enabled = computed(() => this.context().plugins.organization && this.context().organization.teams);
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal((context) => createTeamsController(context, { autoLoad: this.enabled() }), { context: this.context });
    protected readonly state: Signal<ResourceState<AuthTeam>> = this.bridge.state;
    private readonly actions: TeamsActions = this.bridge.actions;

    protected readonly name = signal("");

    protected create(): void {
        const name = this.name().trim();

        if (name === "") {
            return;
        }

        void this.actions.create(name).then(() => {
            this.name.set("");

            return true;
        });
    }

    protected remove(teamId: string): void {
        void this.actions.remove(teamId);
    }
}

/**
 * Regenerate two-factor backup codes.
 *
 * The new codes are shown once and never again — they are not refetchable by
 * design — so they render inline on success rather than behind a navigation the
 * user might not come back from.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-backup-codes-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.backupCodesRegenerate">
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); submit()">
                    <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                    <lunora-auth-field
                        [field]="state().fields.password"
                        [label]="t.currentPasswordLabel"
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        (changed)="actions.setField('password', $event)"
                        (blurred)="actions.blur('password')"
                    />
                    <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.backupCodesRegenerate }}</lunora-auth-submit-button>
                </form>
                @if (codes().length > 0) {
                    <p class="lunora-auth-note">{{ t.backupCodes }}</p>
                    <ul class="lunora-auth-codes">
                        @for (code of codes(); track code) {
                            <li class="lunora-auth-codes__item">{{ code }}</li>
                        }
                    </ul>
                }
            </lunora-auth-card>
        }
    `,
})
class BackupCodesCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "twoFactor", "BackupCodesCard"));
    protected readonly t = this.context().localization;
    private readonly handle = createBackupCodesController(this.context());
    private readonly bridge = controllerSignal(() => this.handle.controller, { context: this.context });
    protected readonly state: Signal<FormState<BackupCodesField>> = this.bridge.state;
    protected readonly actions: FormActions<BackupCodesField> = this.bridge.actions;

    // The codes live beside the form state rather than inside it (see
    // `backup-codes.ts`), so they are mirrored into their own signal.
    protected readonly codes = signal<ReadonlyArray<string>>(this.handle.getCodes());

    protected submit(): void {
        void this.actions.submit().then(() => {
            this.codes.set(this.handle.getCodes());

            return true;
        });
    }
}

export { AdminUsersCardComponent, BackupCodesCardComponent, DeviceAuthorizationCardComponent, MultiSessionCardComponent, TeamsCardComponent };
