"use client";

import type { ReactElement } from "react";

import { queryParameter } from "../core/browser-location";
import { isFlowEnabled } from "../core/flow-gate";
import { createAuthorizedAppsController, createConsentController, scopeLabels } from "../core/oauth-provider";
import { AuthCard, FormBanner, Skeleton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

/**
 * The consent screen a third-party application redirects the user into.
 *
 * Deliberately plain: it names the application, lists exactly what it is asking
 * for, and offers two equally-weighted answers. Nothing is pre-selected and
 * there is no "remember this" shortcut — an authorization prompt that is easier
 * to approve than to read is the failure mode this screen exists to avoid.
 */
interface ConsentCardProps {
    /** Defaults to `?consent_id=` from the URL. */
    consentId?: string;
}

const ConsentCard = ({ consentId }: ConsentCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const resolved = consentId ?? queryParameter("consent_id");
    const enabled = isFlowEnabled(context, "oauthProvider", "ConsentCard");
    const [state, actions] = useController((context_) => createConsentController(context_, { autoLoad: enabled, consentId: resolved }), [resolved, enabled]);

    if (!enabled) {
        return null;
    }

    const application = state.request?.clientName ?? state.request?.clientId;
    const scopes = scopeLabels(state.request?.scope);
    const pending = state.status === "submitting";

    return (
        <AuthCard title={t.consentTitle}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton rows={3} />
            ) : (
                <>
                    {state.request === undefined ? null : (
                        <>
                            <p className="lunora-auth-note">
                                <strong>{application}</strong> {t.consentWants}
                            </p>
                            <ul className="lunora-auth-list">
                                {scopes.map((scope) => (
                                    <li className="lunora-auth-list__item" key={scope}>
                                        <span className="lunora-auth-list__label">{scope}</span>
                                    </li>
                                ))}
                            </ul>
                            <div className="lunora-auth-actions">
                                {/* Deny first in the DOM: it is the safe answer, so
                                    it is the one a keyboard reaches first. */}
                                <button
                                    className="lunora-auth-button lunora-auth-button--secondary"
                                    disabled={pending}
                                    onClick={() => {
                                        void actions.deny();
                                    }}
                                    type="button"
                                >
                                    {t.consentDeny}
                                </button>
                                <button
                                    className="lunora-auth-button"
                                    disabled={pending}
                                    onClick={() => {
                                        void actions.accept();
                                    }}
                                    type="button"
                                >
                                    {t.consentAllow}
                                </button>
                            </div>
                        </>
                    )}
                </>
            )}
        </AuthCard>
    );
};

/**
 * Applications the user has authorized, with revoke — the place a granted
 * consent can be taken back. Without it, the consent screen is a one-way door.
 */
const AuthorizedAppsCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "oauthProvider", "AuthorizedAppsCard");
    const [state, actions] = useController((context_) => createAuthorizedAppsController(context_, { autoLoad: enabled }), [enabled]);

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.authorizedApps}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton rows={2} />
            ) : (
                <ul className="lunora-auth-list">
                    {state.items.map((consent) => (
                        <li className="lunora-auth-list__item" key={consent.id}>
                            <span className="lunora-auth-list__label">{consent.clientName ?? consent.clientId}</span>
                            <button
                                className="lunora-auth-button lunora-auth-button--danger"
                                disabled={state.busy}
                                onClick={() => {
                                    void actions.revoke(consent.id ?? "");
                                }}
                                type="button"
                            >
                                {t.revokeAccess}
                            </button>
                        </li>
                    ))}
                    {state.items.length === 0 ? <li className="lunora-auth-list__empty">{t.authorizedAppsEmpty}</li> : null}
                </ul>
            )}
        </AuthCard>
    );
};

export type { ConsentCardProps };
export { AuthorizedAppsCard, ConsentCard };
