"use client";

import type { ReactElement } from "react";
import { useState } from "react";

import { createMembersController, createOrganizationsController, createOrganizationSettingsController, isFlowEnabled } from "../core";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
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

const OrganizationsCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    // Resolved before the controller is built: a gated-off card must not fire
    // the resource controller's auto-load on mount just to render nothing.
    const enabled = isFlowEnabled(context, "organization", "OrganizationsCard");
    const [state, actions] = useController((context_) => createOrganizationsController(context_, { autoLoad: enabled }), [enabled]);
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");

    if (!enabled) {
        return null;
    }

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

const MembersCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "organization", "MembersCard");
    const [state, actions] = useController((context_) => createMembersController(context_, { autoLoad: enabled }), [enabled]);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<string>("member");

    if (!enabled) {
        return null;
    }

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

interface OrganizationSettingsCardProps {
    /** Defaults to the user's active organization. */
    organizationId?: string;
}

/** Rename the active organization and edit its slug and logo. */
const OrganizationSettingsCard = ({ organizationId }: OrganizationSettingsCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "organization", "OrganizationSettingsCard");
    const [state, actions] = useController(
        (context_) => createOrganizationSettingsController(context_, { autoLoad: enabled, organizationId }),
        [enabled, organizationId],
    );

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.organizationSettings}>
            {state.loading ? (
                <p className="lunora-auth-card__description">…</p>
            ) : (
                <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
            )}
        </AuthCard>
    );
};

export type { OrganizationSettingsCardProps };
export { MembersCard, OrganizationsCard, OrganizationSettingsCard };
