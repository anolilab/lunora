"use client";

import type { ReactElement } from "react";
import { useId, useState } from "react";

import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS, slugify } from "../core/labels";
import { createMembersController } from "../core/members";
import { createOrganizationsController } from "../core/organization-list";
import { createOrganizationSettingsController } from "../core/organization-settings";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

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
                {state.items.map((organization) => {
                    // Bound once: TS can't narrow an optional property through a
                    // closure, and a local beats an `as string` at each call site.
                    const { id } = organization;

                    return (
                        <li className="lunora-auth-list__item" key={id ?? organization.slug ?? organization.name}>
                            <span className="lunora-auth-list__label">{organization.name ?? organization.slug}</span>
                            <span className="lunora-auth-list__actions">
                                {id === undefined ? null : (
                                    <>
                                        <button
                                            className="lunora-auth-link"
                                            disabled={state.busy}
                                            onClick={() => {
                                                void actions.setActive(id);
                                            }}
                                            type="button"
                                        >
                                            {t.switchOrganization}
                                        </button>
                                        <button
                                            className="lunora-auth-link"
                                            disabled={state.busy}
                                            onClick={() => {
                                                void actions.remove(id);
                                            }}
                                            type="button"
                                        >
                                            {t.remove}
                                        </button>
                                    </>
                                )}
                            </span>
                        </li>
                    );
                })}
            </ul>
        );
    })();

    return (
        <AuthCard title={t.organizations}>
            <FormBanner error={state.error} />
            {list}
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(create)}>
                <Field field={{ touched: false, value: name }} label={t.organizationName} name="organizationName" onBlur={() => undefined} onChange={setName} />
                <Field
                    field={{ touched: false, value: slug }}
                    label={t.organizationSlug}
                    name="organizationSlug"
                    onBlur={() => undefined}
                    onChange={setSlug}
                    placeholder={slugify(name)}
                />
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
    // Generated, not hard-coded: two cards on one page must not collide.
    const roleId = useId();

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
                    {state.members.map((member) => {
                        // Bound once: TS can't narrow an optional through a closure.
                        const memberId = member.id;

                        return (
                            <li className="lunora-auth-list__item" key={memberId ?? member.userId ?? member.user?.email}>
                                <span className="lunora-auth-list__label">
                                    {member.user?.email ?? member.user?.name ?? member.userId} · {member.role}
                                </span>
                                {memberId === undefined ? null : (
                                    <button
                                        className="lunora-auth-link"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.removeMember(memberId);
                                        }}
                                        type="button"
                                    >
                                        {t.remove}
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {state.invitations.length === 0 ? null : (
                <>
                    <p className="lunora-auth-card__description">{t.invitations}</p>
                    <ul className="lunora-auth-list">
                        {state.invitations.map((invitation) => {
                            const invitationId = invitation.id;

                            return (
                                <li className="lunora-auth-list__item" key={invitationId ?? invitation.email}>
                                    <span className="lunora-auth-list__label">
                                        {invitation.email} · {invitation.role}
                                    </span>
                                    {invitationId === undefined ? null : (
                                        <button
                                            className="lunora-auth-link"
                                            disabled={state.busy}
                                            onClick={() => {
                                                void actions.cancelInvitation(invitationId);
                                            }}
                                            type="button"
                                        >
                                            {t.cancel}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}

            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(invite)}>
                <Field
                    field={{ touched: false, value: email }}
                    label={t.inviteEmailLabel}
                    name="inviteEmail"
                    onBlur={() => undefined}
                    onChange={setEmail}
                    type="email"
                />
                <div className="lunora-auth-field">
                    <label className="lunora-auth-field__label" htmlFor={roleId}>
                        {t.roleLabel}
                    </label>
                    <select
                        className="lunora-auth-field__input"
                        id={roleId}
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
