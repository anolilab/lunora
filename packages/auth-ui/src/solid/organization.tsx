import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";

import { createMembersController, createOrganizationsController } from "../core";
import { AuthCard, FormBanner, SubmitButton } from "./primitives";
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
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createOrganizationsController);
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
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createMembersController);
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

export { MembersCard, OrganizationsCard };
