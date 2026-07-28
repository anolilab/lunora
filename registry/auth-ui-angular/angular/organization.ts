let organizationFieldId = 0;

/**
 * Organization cards, mirroring the React `organization.tsx` 1:1: an
 * organizations list with a create form (name + auto-slug), and a members list
 * with pending invitations and an invite form. Local form fields are plain
 * signals; the lists come from the core controllers.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from "@angular/core";

import type { ResourceState } from "../core/create-resource-controller";
import type { MembersActions, MembersState } from "../core/members";
import type { OrganizationsActions } from "../core/organization-list";
import type { OrganizationSettingsField } from "../core/organization-settings";
import type { AuthOrganization, FormActions, FormState } from "../core/types";
import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS, slugify } from "../core/labels";
import { createMembersController } from "../core/members";
import { createOrganizationsController } from "../core/organization-list";
import { createOrganizationSettingsController } from "../core/organization-settings";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUI } from "./provider";

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-organizations-card",
    standalone: true,
    template: `
        @if (enabled) {
            <lunora-auth-card [title]="t.organizations">
                <lunora-auth-banner [error]="state().error" />
                @if (state().loading) {
                    <p class="lunora-auth-card__description">…</p>
                } @else if (state().items.length === 0) {
                    <p class="lunora-auth-card__description">{{ t.noOrganizations }}</p>
                } @else {
                    <ul class="lunora-auth-list">
                        @for (organization of state().items; track organization.id ?? organization.slug ?? organization.name) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{{ organization.name ?? organization.slug }}</span>
                                <span class="lunora-auth-list__actions">
                                    @if (organization.id !== undefined) {
                                        <button class="lunora-auth-link" type="button" [disabled]="state().busy" (click)="actions.setActive(organization.id!)">
                                            {{ t.switchOrganization }}
                                        </button>
                                        <button class="lunora-auth-link" type="button" [disabled]="state().busy" (click)="actions.remove(organization.id!)">
                                            {{ t.remove }}
                                        </button>
                                    }
                                </span>
                            </li>
                        }
                    </ul>
                }
                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); create()">
                    <div class="lunora-auth-field">
                        <label class="lunora-auth-field__label" [attr.for]="uid + '-org-name'">{{ t.organizationName }}</label>
                        <input class="lunora-auth-field__input" [attr.id]="uid + '-org-name'" [value]="name()" (input)="name.set($any($event.target).value)" />
                    </div>
                    <div class="lunora-auth-field">
                        <label class="lunora-auth-field__label" [attr.for]="uid + '-org-slug'">{{ t.organizationSlug }}</label>
                        <input
                            class="lunora-auth-field__input"
                            [attr.id]="uid + '-org-slug'"
                            [value]="slug()"
                            [attr.placeholder]="slugify(name())"
                            (input)="slug.set($any($event.target).value)"
                        />
                    </div>
                    <lunora-auth-submit-button [pending]="state().busy">{{ t.createOrganization }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class OrganizationsCardComponent {
    // Per-instance ids: two cards on one page must not collide.
    protected readonly uid = `lunora-auth-${(organizationFieldId += 1)}`;
    private readonly context = injectAuthUI();
    protected readonly enabled = isFlowEnabled(this.context, "organization", "OrganizationsCard");
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal((context) => createOrganizationsController(context, { autoLoad: this.enabled }), { context: this.context });
    protected readonly state: Signal<ResourceState<AuthOrganization>> = this.bridge.state;
    protected readonly actions: OrganizationsActions = this.bridge.actions;

    protected readonly name = signal("");
    protected readonly slug = signal("");

    protected readonly slugify = slugify;

    protected create(): void {
        const name = this.name().trim();

        if (name === "") {
            return;
        }

        const slug = this.slug().trim();

        void this.actions.create(name, slug === "" ? slugify(name) : slug);
        this.name.set("");
        this.slug.set("");
    }
}

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-members-card",
    standalone: true,
    template: `
        @if (enabled) {
            <lunora-auth-card [title]="t.members">
                <lunora-auth-banner [error]="state().error" />

                @if (state().loading) {
                    <p class="lunora-auth-card__description">…</p>
                } @else {
                    <ul class="lunora-auth-list">
                        @for (member of state().members; track member.id ?? member.userId ?? member.user?.email) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">
                                    {{ member.user?.email ?? member.user?.name ?? member.userId }} · {{ member.role }}
                                </span>
                                @if (member.id !== undefined) {
                                    <button class="lunora-auth-link" type="button" [disabled]="state().busy" (click)="actions.removeMember(member.id!)">
                                        {{ t.remove }}
                                    </button>
                                }
                            </li>
                        }
                    </ul>
                }

                @if (state().invitations.length > 0) {
                    <p class="lunora-auth-card__description">{{ t.invitations }}</p>
                    <ul class="lunora-auth-list">
                        @for (invitation of state().invitations; track invitation.id ?? invitation.email) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{{ invitation.email }} · {{ invitation.role }}</span>
                                @if (invitation.id !== undefined) {
                                    <button class="lunora-auth-link" type="button" [disabled]="state().busy" (click)="actions.cancelInvitation(invitation.id!)">
                                        {{ t.cancel }}
                                    </button>
                                }
                            </li>
                        }
                    </ul>
                }

                <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); invite()">
                    <div class="lunora-auth-field">
                        <label class="lunora-auth-field__label" [attr.for]="uid + '-invite-email'">{{ t.inviteEmailLabel }}</label>
                        <input
                            class="lunora-auth-field__input"
                            [attr.id]="uid + '-invite-email'"
                            type="email"
                            [value]="email()"
                            (input)="email.set($any($event.target).value)"
                        />
                    </div>
                    <div class="lunora-auth-field">
                        <label class="lunora-auth-field__label" [attr.for]="uid + '-invite-role'">{{ t.roleLabel }}</label>
                        <select
                            class="lunora-auth-field__input"
                            [attr.id]="uid + '-invite-role'"
                            [value]="role()"
                            (change)="role.set($any($event.target).value)"
                        >
                            @for (option of roleOptions; track option) {
                                <option [value]="option">{{ option }}</option>
                            }
                        </select>
                    </div>
                    <lunora-auth-submit-button [pending]="state().busy">{{ t.inviteMember }}</lunora-auth-submit-button>
                </form>
            </lunora-auth-card>
        }
    `,
})
class MembersCardComponent {
    // Per-instance ids: two cards on one page must not collide.
    protected readonly uid = `lunora-auth-${(organizationFieldId += 1)}`;
    private readonly context = injectAuthUI();
    protected readonly enabled = isFlowEnabled(this.context, "organization", "MembersCard");
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal((context) => createMembersController(context, { autoLoad: this.enabled }), { context: this.context });
    protected readonly state: Signal<MembersState> = this.bridge.state;
    protected readonly actions: MembersActions = this.bridge.actions;

    protected readonly roleOptions = ROLE_OPTIONS;
    protected readonly email = signal("");
    protected readonly role = signal<string>("member");

    protected invite(): void {
        const email = this.email().trim();

        if (email === "") {
            return;
        }

        void this.actions.invite(email, this.role());
        this.email.set("");
    }
}

/** Rename the active organization and edit its slug and logo. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-organization-settings-card",
    standalone: true,
    template: `
        @if (enabled) {
            <lunora-auth-card [title]="t.organizationSettings">
                @if (state().loading) {
                    <p class="lunora-auth-card__description">…</p>
                } @else {
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.submit()">
                        <lunora-auth-banner [error]="state().formError" [success]="state().successMessage" />
                        <lunora-auth-field
                            [field]="state().fields.name"
                            [label]="t.organizationName"
                            name="organizationName"
                            (changed)="actions.setField('name', $event)"
                            (blurred)="actions.blur('name')"
                        />
                        <lunora-auth-field
                            [field]="state().fields.slug"
                            [label]="t.organizationSlug"
                            name="organizationSlug"
                            (changed)="actions.setField('slug', $event)"
                            (blurred)="actions.blur('slug')"
                        />
                        <lunora-auth-field
                            [field]="state().fields.logo"
                            [label]="t.organizationLogo"
                            name="organizationLogo"
                            (changed)="actions.setField('logo', $event)"
                            (blurred)="actions.blur('logo')"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.saveChanges }}</lunora-auth-submit-button>
                    </form>
                }
            </lunora-auth-card>
        }
    `,
})
class OrganizationSettingsCardComponent implements OnInit {
    /** Defaults to the user's active organization. */
    readonly organizationId = input<string>();

    private readonly context = injectAuthUI();
    private readonly destroyRef = inject(DestroyRef);
    protected readonly enabled = isFlowEnabled(this.context, "organization", "OrganizationSettingsCard");
    protected readonly t = this.context.localization;
    protected state!: Signal<FormState<OrganizationSettingsField>>;
    protected actions!: FormActions<OrganizationSettingsField>;

    // Built in ngOnInit, not a field initializer: `organizationId()` is unbound
    // until Angular has set the inputs, so initializing here would silently pin
    // every instance to the active organization.
    ngOnInit(): void {
        const bridge = controllerSignal(
            (context) => createOrganizationSettingsController(context, { autoLoad: this.enabled, organizationId: this.organizationId() }),
            { context: this.context, destroyRef: this.destroyRef },
        );

        this.state = bridge.state;
        this.actions = bridge.actions;
    }
}

export { MembersCardComponent, OrganizationSettingsCardComponent, OrganizationsCardComponent };
