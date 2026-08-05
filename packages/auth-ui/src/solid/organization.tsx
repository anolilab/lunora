import type { JSX } from "solid-js";
import { createSignal, createUniqueId, For, Show } from "solid-js";

import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS, slugify } from "../core/labels";
import { createMembersController } from "../core/members";
import { createOrganizationsController } from "../core/organization-list";
import { createOrganizationSettingsController } from "../core/organization-settings";
import { FormField, onSubmit } from "./form";
import { AuthCard, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

const OrganizationsCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    // Resolved before the controller is built: a gated-off card must not fire
    // the resource controller's auto-load on mount just to render nothing.
    const enabled = isFlowEnabled(context, "organization", "OrganizationsCard");
    const [state, actions] = createController((context_) => createOrganizationsController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }
    const [name, setName] = createSignal("");
    const [slug, setSlug] = createSignal("");
    // Generated, not hard-coded: two cards on one page must not collide.
    const nameId = createUniqueId();
    const slugId = createUniqueId();

    const create = (): void => {
        if (name().trim() === "") {
            return;
        }

        void actions.create(name().trim(), slug().trim() === "" ? slugify(name()) : slug().trim());
        setName("");
        setSlug("");
    };

    return (
        <AuthCard headingLevel={2} title={t.organizations}>
            <FormBanner error={state.error} />
            <Show
                fallback={
                    <Show fallback={<p class="lunora-auth-card__description">{t.noOrganizations}</p>} when={state.items.length > 0}>
                        <ul class="lunora-auth-list">
                            <For each={state.items}>
                                {(organization) => (
                                    <li class="lunora-auth-list__item">
                                        <span class="lunora-auth-list__label">{organization.name ?? organization.slug}</span>
                                        <span class="lunora-auth-list__actions">
                                            <Show when={organization.id}>
                                                {/* `Show` hands the narrowed id to the callback — no cast needed. */}
                                                {(id) => (
                                                    <>
                                                        <button
                                                            class="lunora-auth-link"
                                                            disabled={state.busy}
                                                            onClick={() => {
                                                                void actions.setActive(id());
                                                            }}
                                                            type="button"
                                                        >
                                                            {t.switchOrganization}
                                                        </button>
                                                        <button
                                                            class="lunora-auth-link"
                                                            disabled={state.busy}
                                                            onClick={() => {
                                                                void actions.remove(id());
                                                            }}
                                                            type="button"
                                                        >
                                                            {t.remove}
                                                        </button>
                                                    </>
                                                )}
                                            </Show>
                                        </span>
                                    </li>
                                )}
                            </For>
                        </ul>
                    </Show>
                }
                when={state.loading}
            >
                <p class="lunora-auth-card__description">…</p>
            </Show>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(create)}>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for={nameId}>
                        {t.organizationName}
                    </label>
                    <input
                        class="lunora-auth-field__input"
                        id={nameId}
                        onInput={(event) => {
                            setName(event.currentTarget.value);
                        }}
                        value={name()}
                    />
                </div>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for={slugId}>
                        {t.organizationSlug}
                    </label>
                    <input
                        class="lunora-auth-field__input"
                        id={slugId}
                        onInput={(event) => {
                            setSlug(event.currentTarget.value);
                        }}
                        placeholder={slugify(name())}
                        value={slug()}
                    />
                </div>
                <SubmitButton pending={state.busy}>{t.createOrganization}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const MembersCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "organization", "MembersCard");
    const [state, actions] = createController((context_) => createMembersController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }
    const [email, setEmail] = createSignal("");
    const [role, setRole] = createSignal<string>("member");
    // Generated, not hard-coded: two cards on one page must not collide.
    const emailId = createUniqueId();
    const roleId = createUniqueId();

    const invite = (): void => {
        if (email().trim() === "") {
            return;
        }

        void actions.invite(email().trim(), role());
        setEmail("");
    };

    return (
        <AuthCard headingLevel={2} title={t.members}>
            <FormBanner error={state.error} />

            <Show
                fallback={
                    <ul class="lunora-auth-list">
                        <For each={state.members}>
                            {(member) => (
                                <li class="lunora-auth-list__item">
                                    <span class="lunora-auth-list__label">
                                        {member.user?.email ?? member.user?.name ?? member.userId} · {member.role}
                                    </span>
                                    <Show when={member.id}>
                                        {/* `Show` hands the narrowed value to the callback — no cast needed. */}
                                        {(id) => (
                                            <button
                                                class="lunora-auth-link"
                                                disabled={state.busy}
                                                onClick={() => {
                                                    id();
                                                }}
                                                type="button"
                                            >
                                                {t.remove}
                                            </button>
                                        )}
                                    </Show>
                                </li>
                            )}
                        </For>
                    </ul>
                }
                when={state.loading}
            >
                <p class="lunora-auth-card__description">…</p>
            </Show>

            <Show when={state.invitations.length > 0}>
                <p class="lunora-auth-card__description">{t.invitations}</p>
                <ul class="lunora-auth-list">
                    <For each={state.invitations}>
                        {(invitation) => (
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">
                                    {invitation.email} · {invitation.role}
                                </span>
                                <Show when={invitation.id}>
                                    {/* `Show` hands the narrowed value to the callback — no cast needed. */}
                                    {(id) => (
                                        <button
                                            class="lunora-auth-link"
                                            disabled={state.busy}
                                            onClick={() => {
                                                void actions.cancelInvitation(id());
                                            }}
                                            type="button"
                                        >
                                            {t.cancel}
                                        </button>
                                    )}
                                </Show>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>

            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(invite)}>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for={emailId}>
                        {t.inviteEmailLabel}
                    </label>
                    <input
                        class="lunora-auth-field__input"
                        id={emailId}
                        onInput={(event) => {
                            setEmail(event.currentTarget.value);
                        }}
                        type="email"
                        value={email()}
                    />
                </div>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for={roleId}>
                        {t.roleLabel}
                    </label>
                    <select
                        class="lunora-auth-field__input"
                        id={roleId}
                        onChange={(event) => {
                            setRole(event.currentTarget.value);
                        }}
                        value={role()}
                    >
                        <For each={ROLE_OPTIONS}>{(option) => <option value={option}>{option}</option>}</For>
                    </select>
                </div>
                <SubmitButton pending={state.busy}>{t.inviteMember}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface OrganizationSettingsCardProps {
    /** Defaults to the user's active organization. */
    organizationId?: string;
}

/** Rename the active organization and edit its slug and logo. */
const OrganizationSettingsCard = (props: OrganizationSettingsCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "organization", "OrganizationSettingsCard");
    const [state, actions] = createController((context_) =>
        createOrganizationSettingsController(context_, { autoLoad: enabled, organizationId: props.organizationId }),
    );

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard headingLevel={2} title={t.organizationSettings}>
            <Show fallback={<p class="lunora-auth-card__description">…</p>} when={!state.loading}>
                <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                    <FormBanner error={state.formError} success={state.successMessage} />
                    <FormField actions={actions} field="name" label={t.organizationName} name="organizationName" state={state} />
                    <FormField actions={actions} field="slug" label={t.organizationSlug} name="organizationSlug" state={state} />
                    <FormField actions={actions} field="logo" label={t.organizationLogo} name="organizationLogo" state={state} />
                    <SubmitButton pending={state.status === "submitting"}>{t.saveChanges}</SubmitButton>
                </form>
            </Show>
        </AuthCard>
    );
};

export type { OrganizationSettingsCardProps };
export { MembersCard, OrganizationsCard, OrganizationSettingsCard };
