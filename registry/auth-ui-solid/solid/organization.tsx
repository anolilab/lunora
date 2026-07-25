import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";

import { createMembersController, createOrganizationSettingsController, createOrganizationsController, isFlowEnabled } from "../core";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

const ROLE_OPTIONS = ["member", "admin", "owner"] as const;

const slugify = (value: string): string =>
    // Runs of non-alphanumerics collapse to a single "-", so trimming one edge
    // dash each side is enough (keeps the regex linear — no `+` quantifier).
    value
        .toLowerCase()
        .trim()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-|-$/gu, "");

const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

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

    const create = (): void => {
        if (name().trim() === "") {
            return;
        }

        void actions.create(name().trim(), slug().trim() === "" ? slugify(name()) : slug().trim());
        setName("");
        setSlug("");
    };

    return (
        <AuthCard title={t.organizations}>
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
                                            <Show when={organization.id !== undefined}>
                                                <button
                                                    class="lunora-auth-link"
                                                    disabled={state.busy}
                                                    onClick={() => {
                                                        void actions.setActive(organization.id as string);
                                                    }}
                                                    type="button"
                                                >
                                                    {t.switchOrganization}
                                                </button>
                                                <button
                                                    class="lunora-auth-link"
                                                    disabled={state.busy}
                                                    onClick={() => {
                                                        void actions.remove(organization.id as string);
                                                    }}
                                                    type="button"
                                                >
                                                    {t.remove}
                                                </button>
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
                    <label class="lunora-auth-field__label" for="lunora-org-name">
                        {t.organizationName}
                    </label>
                    <input
                        class="lunora-auth-field__input"
                        id="lunora-org-name"
                        onInput={(event) => {
                            setName(event.currentTarget.value);
                        }}
                        value={name()}
                    />
                </div>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for="lunora-org-slug">
                        {t.organizationSlug}
                    </label>
                    <input
                        class="lunora-auth-field__input"
                        id="lunora-org-slug"
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

    const invite = (): void => {
        if (email().trim() === "") {
            return;
        }

        void actions.invite(email().trim(), role());
        setEmail("");
    };

    return (
        <AuthCard title={t.members}>
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
                                    <Show when={member.id !== undefined}>
                                        <button
                                            class="lunora-auth-link"
                                            disabled={state.busy}
                                            onClick={() => {
                                                void actions.removeMember(member.id as string);
                                            }}
                                            type="button"
                                        >
                                            {t.remove}
                                        </button>
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
                                <Show when={invitation.id !== undefined}>
                                    <button
                                        class="lunora-auth-link"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.cancelInvitation(invitation.id as string);
                                        }}
                                        type="button"
                                    >
                                        {t.cancel}
                                    </button>
                                </Show>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>

            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(invite)}>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for="lunora-invite-email">
                        {t.inviteEmailLabel}
                    </label>
                    <input
                        class="lunora-auth-field__input"
                        id="lunora-invite-email"
                        onInput={(event) => {
                            setEmail(event.currentTarget.value);
                        }}
                        type="email"
                        value={email()}
                    />
                </div>
                <div class="lunora-auth-field">
                    <label class="lunora-auth-field__label" for="lunora-invite-role">
                        {t.roleLabel}
                    </label>
                    <select
                        class="lunora-auth-field__input"
                        id="lunora-invite-role"
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
        <AuthCard title={t.organizationSettings}>
            <Show fallback={<p class="lunora-auth-card__description">…</p>} when={!state.loading}>
                <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                    <FormBanner error={state.formError} success={state.successMessage} />
                    <Field
                        field={state.fields.name}
                        label={t.organizationName}
                        name="organizationName"
                        onBlur={() => {
                            actions.blur("name");
                        }}
                        onChange={(value) => {
                            actions.setField("name", value);
                        }}
                    />
                    <Field
                        field={state.fields.slug}
                        label={t.organizationSlug}
                        name="organizationSlug"
                        onBlur={() => {
                            actions.blur("slug");
                        }}
                        onChange={(value) => {
                            actions.setField("slug", value);
                        }}
                    />
                    <Field
                        field={state.fields.logo}
                        label={t.organizationLogo}
                        name="organizationLogo"
                        onBlur={() => {
                            actions.blur("logo");
                        }}
                        onChange={(value) => {
                            actions.setField("logo", value);
                        }}
                    />
                    <SubmitButton pending={state.status === "submitting"}>{t.saveChanges}</SubmitButton>
                </form>
            </Show>
        </AuthCard>
    );
};

export type { OrganizationSettingsCardProps };
export { MembersCard, OrganizationSettingsCard, OrganizationsCard };
