import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

import { isFlowEnabled } from "../core/flow-gate";
import { createAuthorizedAppsController, createConsentController, scopeLabels } from "../core/oauth-provider";
import { AuthCard, FormBanner, Skeleton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

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

const ConsentCard = (props: ConsentCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const search = (globalThis as { location?: { search?: string } }).location?.search;
    const resolved = props.consentId ?? (search === undefined ? undefined : (new URLSearchParams(search).get("consent_id") ?? undefined));
    // Resolved before the controller is built: a gated-off card must not fetch a
    // pending authorization request on mount just to render nothing.
    const enabled = isFlowEnabled(context, "oauthProvider", "ConsentCard");
    const [state, actions] = createController((context_) => createConsentController(context_, { autoLoad: enabled, consentId: resolved }));

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.consentTitle}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton rows={3} />} when={!state.loading}>
                <Show when={state.request !== undefined}>
                    <p class="lunora-auth-note">
                        <strong>{state.request?.clientName ?? state.request?.clientId}</strong> {t.consentWants}
                    </p>
                    <ul class="lunora-auth-list">
                        <For each={scopeLabels(state.request?.scope)}>
                            {(scope) => (
                                <li class="lunora-auth-list__item">
                                    <span class="lunora-auth-list__label">{scope}</span>
                                </li>
                            )}
                        </For>
                    </ul>
                    <div class="lunora-auth-actions">
                        {/* Deny first in the DOM: it is the safe answer, so
                            it is the one a keyboard reaches first. */}
                        <button
                            class="lunora-auth-button lunora-auth-button--secondary"
                            disabled={state.status === "submitting"}
                            onClick={() => {
                                void actions.deny();
                            }}
                            type="button"
                        >
                            {t.consentDeny}
                        </button>
                        <button
                            class="lunora-auth-button"
                            disabled={state.status === "submitting"}
                            onClick={() => {
                                void actions.accept();
                            }}
                            type="button"
                        >
                            {t.consentAllow}
                        </button>
                    </div>
                </Show>
            </Show>
        </AuthCard>
    );
};

/**
 * Applications the user has authorized, with revoke — the place a granted
 * consent can be taken back. Without it, the consent screen is a one-way door.
 */
const AuthorizedAppsCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "oauthProvider", "AuthorizedAppsCard");
    const [state, actions] = createController((context_) => createAuthorizedAppsController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.authorizedApps}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton rows={2} />} when={!state.loading}>
                <ul class="lunora-auth-list">
                    <For each={state.items}>
                        {(consent) => (
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{consent.clientName ?? consent.clientId}</span>
                                <button
                                    class="lunora-auth-button lunora-auth-button--danger"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.revoke(consent.id ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.revokeAccess}
                                </button>
                            </li>
                        )}
                    </For>
                    <Show when={state.items.length === 0}>
                        <li class="lunora-auth-list__empty">{t.authorizedAppsEmpty}</li>
                    </Show>
                </ul>
            </Show>
        </AuthCard>
    );
};

export type { ConsentCardProps };
export { AuthorizedAppsCard, ConsentCard };
