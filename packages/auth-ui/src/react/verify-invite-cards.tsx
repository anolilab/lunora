"use client";

import type { ReactElement } from "react";

import { queryParameter } from "../core/browser-location";
import { createAcceptInvitationController, createUserInvitationsController } from "../core/invitations";
import { createResendVerificationController, createVerifyEmailController } from "../core/verify-email";
import { AuthCard, Field, FormBanner, Skeleton, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const onSubmit =
    (run: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void run();
    };

/**
 * The page the verification link lands on.
 *
 * It consumes the token on mount and redirects, so the only states a user sees
 * are "working" and "that link is no longer good".
 */
interface VerifyEmailCardProps {
    /** Defaults to `?token=` from the URL. */
    token?: string;
}

const VerifyEmailCard = ({ token }: VerifyEmailCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const resolved = token ?? queryParameter("token");
    const [state, actions] = useController((context) => createVerifyEmailController(context, { token: resolved }), [resolved]);

    return (
        <AuthCard title={t.verifyEmail}>
            <FormBanner error={state.error} />
            {state.status === "submitting" || state.status === "idle" ? <p className="lunora-auth-note">{t.verifyEmailVerifying}</p> : null}
            {state.status === "error" ? (
                <button
                    className="lunora-auth-button lunora-auth-button--secondary"
                    onClick={() => {
                        void actions.verify();
                    }}
                    type="button"
                >
                    {t.verifyEmailResend}
                </button>
            ) : null}
        </AuthCard>
    );
};

/** Request a fresh verification link — the companion to {@link VerifyEmailCard}. */
const ResendVerificationCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createResendVerificationController);

    return (
        <AuthCard title={t.verifyEmail}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="email"
                    field={state.fields.email}
                    label={t.emailLabel}
                    name="email"
                    onBlur={() => {
                        actions.blur("email");
                    }}
                    onChange={(value) => {
                        actions.setField("email", value);
                    }}
                    type="email"
                />
                <SubmitButton pending={state.status === "submitting"}>{t.verifyEmailResend}</SubmitButton>
            </form>
        </AuthCard>
    );
};

/**
 * The screen an organization invitation link lands on.
 *
 * It renders the organization's name before asking for a decision — an "Accept"
 * button with nothing above it is not consent — and bounces through sign-in when
 * there is no session, returning to this same invitation afterwards.
 */
interface AcceptInvitationCardProps {
    /** Defaults to `?invitationId=` from the URL. */
    invitationId?: string;
}

const AcceptInvitationCard = ({ invitationId }: AcceptInvitationCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const resolved = invitationId ?? queryParameter("invitationId");
    const [state, actions] = useController((context) => createAcceptInvitationController(context, { invitationId: resolved }), [resolved]);

    const organization = state.invitation?.organizationName;

    return (
        <AuthCard description={organization} title={t.invitationTitle}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton rows={2} />
            ) : (
                <div className="lunora-auth-actions">
                    <button
                        className="lunora-auth-button"
                        disabled={state.status === "submitting" || state.invitation === undefined}
                        onClick={() => {
                            void actions.accept();
                        }}
                        type="button"
                    >
                        {t.invitationAccept}
                    </button>
                    <button
                        className="lunora-auth-button lunora-auth-button--secondary"
                        disabled={state.status === "submitting" || state.invitation === undefined}
                        onClick={() => {
                            void actions.reject();
                        }}
                        type="button"
                    >
                        {t.invitationReject}
                    </button>
                </div>
            )}
        </AuthCard>
    );
};

/** Every invitation waiting for the signed-in user, decidable in place. */
const UserInvitationsCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createUserInvitationsController);

    return (
        <AuthCard title={t.invitations}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton rows={2} />
            ) : (
                <ul className="lunora-auth-list">
                    {state.items.map((invitation) => (
                        <li className="lunora-auth-list__item" key={invitation.id}>
                            <span className="lunora-auth-list__label">{invitation.organizationName ?? invitation.email}</span>
                            <span className="lunora-auth-list__actions">
                                <button
                                    className="lunora-auth-button"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.accept(invitation.id ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.invitationAccept}
                                </button>
                                <button
                                    className="lunora-auth-button lunora-auth-button--secondary"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.reject(invitation.id ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.invitationReject}
                                </button>
                            </span>
                        </li>
                    ))}
                    {state.items.length === 0 ? <li className="lunora-auth-list__empty">{t.invitationsEmpty}</li> : null}
                </ul>
            )}
        </AuthCard>
    );
};

export type { AcceptInvitationCardProps, VerifyEmailCardProps };
export { AcceptInvitationCard, ResendVerificationCard, UserInvitationsCard, VerifyEmailCard };
