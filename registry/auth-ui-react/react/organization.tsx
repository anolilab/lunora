"use client";

import type { ReactElement } from "react";
import { useState } from "react";

import { createMembersController, createOrganizationsController } from "../core";
import { AuthCard, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

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
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void action();
    };

const OrganizationsCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createOrganizationsController);
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");

    const create = (): void => {
        if (name.trim() === "") {
            return;
        }

        void actions.create(name.trim(), slug.trim() === "" ? slugify(name) : slug.trim());
        setName("");
        setSlug("");
    };

    const list = ((): ReactElement => {
        if (state.loading) {
            return <p className="lunora-auth-card__description">…</p>;
        }

        if (state.items.length === 0) {
            return <p className="lunora-auth-card__description">{t.noOrganizations}</p>;
        }

        return (
            <ul className="lunora-auth-list">
                {state.items.map((organization) => (
                    <li className="lunora-auth-list__item" key={organization.id ?? organization.slug ?? organization.name}>
                        <span className="lunora-auth-list__label">{organization.name ?? organization.slug}</span>
                        <span className="lunora-auth-list__actions">
                            {organization.id === undefined ? null : (
                                <>
                                    <button
                                        className="lunora-auth-link"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.setActive(organization.id as string);
                                        }}
                                        type="button"
                                    >
                                        {t.switchOrganization}
                                    </button>
                                    <button
                                        className="lunora-auth-link"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.remove(organization.id as string);
                                        }}
                                        type="button"
                                    >
                                        {t.remove}
                                    </button>
                                </>
                            )}
                        </span>
                    </li>
                ))}
            </ul>
        );
    })();

    return (
        <AuthCard title={t.organizations}>
            <FormBanner error={state.error} />
            {list}
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(create)}>
                <div className="lunora-auth-field">
                    <label className="lunora-auth-field__label" htmlFor="lunora-org-name">
                        {t.organizationName}
                    </label>
                    <input
                        className="lunora-auth-field__input"
                        id="lunora-org-name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        value={name}
                    />
                </div>
                <div className="lunora-auth-field">
                    <label className="lunora-auth-field__label" htmlFor="lunora-org-slug">
                        {t.organizationSlug}
                    </label>
                    <input
                        className="lunora-auth-field__input"
                        id="lunora-org-slug"
                        onChange={(event) => {
                            setSlug(event.target.value);
                        }}
                        placeholder={slugify(name)}
                        value={slug}
                    />
                </div>
                <SubmitButton pending={state.busy}>{t.createOrganization}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const MembersCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createMembersController);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<string>("member");

    const invite = (): void => {
        if (email.trim() === "") {
            return;
        }

        void actions.invite(email.trim(), role);
        setEmail("");
    };

    return (
        <AuthCard title={t.members}>
            <FormBanner error={state.error} />

            {state.loading ? (
                <p className="lunora-auth-card__description">…</p>
            ) : (
                <ul className="lunora-auth-list">
                    {state.members.map((member) => (
                        <li className="lunora-auth-list__item" key={member.id ?? member.userId ?? member.user?.email}>
                            <span className="lunora-auth-list__label">
                                {member.user?.email ?? member.user?.name ?? member.userId} · {member.role}
                            </span>
                            {member.id === undefined ? null : (
                                <button
                                    className="lunora-auth-link"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.removeMember(member.id as string);
                                    }}
                                    type="button"
                                >
                                    {t.remove}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {state.invitations.length === 0 ? null : (
                <>
                    <p className="lunora-auth-card__description">{t.invitations}</p>
                    <ul className="lunora-auth-list">
                        {state.invitations.map((invitation) => (
                            <li className="lunora-auth-list__item" key={invitation.id ?? invitation.email}>
                                <span className="lunora-auth-list__label">
                                    {invitation.email} · {invitation.role}
                                </span>
                                {invitation.id === undefined ? null : (
                                    <button
                                        className="lunora-auth-link"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.cancelInvitation(invitation.id as string);
                                        }}
                                        type="button"
                                    >
                                        {t.cancel}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                </>
            )}

            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(invite)}>
                <div className="lunora-auth-field">
                    <label className="lunora-auth-field__label" htmlFor="lunora-invite-email">
                        {t.inviteEmailLabel}
                    </label>
                    <input
                        className="lunora-auth-field__input"
                        id="lunora-invite-email"
                        onChange={(event) => {
                            setEmail(event.target.value);
                        }}
                        type="email"
                        value={email}
                    />
                </div>
                <div className="lunora-auth-field">
                    <label className="lunora-auth-field__label" htmlFor="lunora-invite-role">
                        {t.roleLabel}
                    </label>
                    <select
                        className="lunora-auth-field__input"
                        id="lunora-invite-role"
                        onChange={(event) => {
                            setRole(event.target.value);
                        }}
                        value={role}
                    >
                        {ROLE_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </div>
                <SubmitButton pending={state.busy}>{t.inviteMember}</SubmitButton>
            </form>
        </AuthCard>
    );
};

export { MembersCard, OrganizationsCard };
