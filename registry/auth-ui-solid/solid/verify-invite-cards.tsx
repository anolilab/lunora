import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

import { queryParameter } from "../core/browser-location";
import { createAcceptInvitationController, createUserInvitationsController } from "../core/invitations";
import { createResendVerificationController, createVerifyEmailController } from "../core/verify-email";
import { FormField, onSubmit } from "./form";
import { AuthCard, FormBanner, Skeleton, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/**
 * The page the verification link lands on. It consumes the token on mount and
 * redirects, so the only states a user sees are "working" and "that link is no
 * longer good".
 */
interface VerifyEmailCardProps {
    /** Defaults to `?token=` from the URL. */
    token?: string;
}

const VerifyEmailCard = (props: VerifyEmailCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) => createVerifyEmailController(context, { token: props.token ?? queryParameter("token") }));

    return (
        <AuthCard title={t.verifyEmail}>
            <FormBanner error={state.error} />
            <Show when={state.status === "submitting" || state.status === "idle"}>
                <p class="lunora-auth-note">{t.verifyEmailVerifying}</p>
            </Show>
            <Show when={state.status === "error"}>
                <button
                    class="lunora-auth-button lunora-auth-button--secondary"
                    onClick={() => {
                        void actions.verify();
                    }}
                    type="button"
                >
                    {t.verifyEmailResend}
                </button>
            </Show>
        </AuthCard>
    );
};

/** Request a fresh verification link — the companion to `VerifyEmailCard`. */
const ResendVerificationCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createResendVerificationController);

    return (
        <AuthCard title={t.verifyEmail}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
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

const AcceptInvitationCard = (props: AcceptInvitationCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) =>
        createAcceptInvitationController(context, { invitationId: props.invitationId ?? queryParameter("invitationId") }),
    );

    return (
        <AuthCard description={state.invitation?.organizationName} title={t.invitationTitle}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton rows={2} />} when={!state.loading}>
                <div class="lunora-auth-actions">
                    <button
                        class="lunora-auth-button"
                        disabled={state.status === "submitting" || state.invitation === undefined}
                        onClick={() => {
                            void actions.accept();
                        }}
                        type="button"
                    >
                        {t.invitationAccept}
                    </button>
                    <button
                        class="lunora-auth-button lunora-auth-button--secondary"
                        disabled={state.status === "submitting" || state.invitation === undefined}
                        onClick={() => {
                            void actions.reject();
                        }}
                        type="button"
                    >
                        {t.invitationReject}
                    </button>
                </div>
            </Show>
        </AuthCard>
    );
};

/** Every invitation waiting for the signed-in user, decidable in place. */
const UserInvitationsCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createUserInvitationsController);

    return (
        <AuthCard title={t.invitations}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton rows={2} />} when={!state.loading}>
                <ul class="lunora-auth-list">
                    <For each={state.items}>
                        {(invitation) => (
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{invitation.organizationName ?? invitation.email}</span>
                                <span class="lunora-auth-list__actions">
                                    <button
                                        class="lunora-auth-button"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.accept(invitation.id ?? "");
                                        }}
                                        type="button"
                                    >
                                        {t.invitationAccept}
                                    </button>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--secondary"
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
                        )}
                    </For>
                    <Show when={state.items.length === 0}>
                        <li class="lunora-auth-list__empty">{t.invitationsEmpty}</li>
                    </Show>
                </ul>
            </Show>
        </AuthCard>
    );
};

export type { AcceptInvitationCardProps, VerifyEmailCardProps };
export { AcceptInvitationCard, ResendVerificationCard, UserInvitationsCard, VerifyEmailCard };
