/**
 * Organization cards, mirroring the React `organization.tsx` 1:1: an
 * organizations list with a create form (name + auto-slug), and a members list
 * with pending invitations and an invite form. Local form fields are plain
 * signals; the lists come from the core controllers.
 */
import type { Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

import type { AuthOrganization, MembersActions, MembersState, OrganizationsActions, ResourceState } from "../core";
import { createMembersController, createOrganizationsController } from "../core";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, FormBannerComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUI } from "./provider";

const ROLE_OPTIONS = ["member", "admin", "owner"] as const;

const slugify = (value: string): string =>
    // Runs of non-alphanumerics collapse to a single "-", so trimming one edge
    // dash each side is enough (keeps the regex linear — no `+` quantifier).
    value
        .toLowerCase()
        .trim()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-|-$/gu, "");

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-organizations-card",
    standalone: true,
    template: `
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
                    <label class="lunora-auth-field__label" for="lunora-org-name">{{ t.organizationName }}</label>
                    <input class="lunora-auth-field__input" id="lunora-org-name" [value]="name()" (input)="name.set($any($event.target).value)" />
                </div>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for="lunora-org-slug">{{ t.organizationSlug }}</label>
                    <input
                        class="lunora-auth-field__input"
                        id="lunora-org-slug"
                        [value]="slug()"
                        [attr.placeholder]="slugify(name())"
                        (input)="slug.set($any($event.target).value)"
                    />
                </div>
                <lunora-auth-submit-button [pending]="state().busy">{{ t.createOrganization }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class OrganizationsCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createOrganizationsController, { context: this.context });
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
        <lunora-auth-card [title]="t.members">
            <lunora-auth-banner [error]="state().error" />

            @if (state().loading) {
                <p class="lunora-auth-card__description">…</p>
            } @else {
                <ul class="lunora-auth-list">
                    @for (member of state().members; track member.id ?? member.userId ?? member.user?.email) {
                        <li class="lunora-auth-list__item">
                            <span class="lunora-auth-list__label"> {{ member.user?.email ?? member.user?.name ?? member.userId }} · {{ member.role }} </span>
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
                    <label class="lunora-auth-field__label" for="lunora-invite-email">{{ t.inviteEmailLabel }}</label>
                    <input
                        class="lunora-auth-field__input"
                        id="lunora-invite-email"
                        type="email"
                        [value]="email()"
                        (input)="email.set($any($event.target).value)"
                    />
                </div>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for="lunora-invite-role">{{ t.roleLabel }}</label>
                    <select class="lunora-auth-field__input" id="lunora-invite-role" [value]="role()" (change)="role.set($any($event.target).value)">
                        @for (option of roleOptions; track option) {
                            <option [value]="option">{{ option }}</option>
                        }
                    </select>
                </div>
                <lunora-auth-submit-button [pending]="state().busy">{{ t.inviteMember }}</lunora-auth-submit-button>
            </form>
        </lunora-auth-card>
    `,
})
class MembersCardComponent {
    private readonly context = injectAuthUI();
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createMembersController, { context: this.context });
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

export { MembersCardComponent, OrganizationsCardComponent };
