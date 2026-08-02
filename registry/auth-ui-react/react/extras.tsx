"use client";

import type { ReactElement } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { ACCEPT_ATTRIBUTE } from "../core/avatar";
import type { CaptchaProvider } from "../core/captcha";
import { renderCaptcha } from "../core/captcha";
import { promptOneTap } from "../core/one-tap";
import { createOrganizationLogoController } from "../core/organization-logo";
import { dismissToast, getToasts, subscribeToasts } from "../core/toast";
import { AuthCard, FormBanner } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

/**
 * Renders the errors that have no card to land in — a failed social redirect, a
 * failed unlink, a sign-out that didn't. Mount it once in your app shell.
 *
 * Errors that *do* belong to a card still render on that card's banner and never
 * reach here, so nothing is announced twice.
 *
 * The `aria-live` region mounts unconditionally — including with no toasts yet.
 * A live region only announces changes made AFTER it exists in the accessibility
 * tree; mounting it together with the first toast (as `{toasts.length === 0 ?
 * null : …}` did) means that very first toast lands before assistive tech is
 * watching the region, so it goes unannounced.
 */
const ErrorToaster = (): ReactElement => {
    const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

    return (
        // `polite`, not `assertive`: these are failures the user can retry, not
        // something that should interrupt a screen reader mid-sentence.
        <div aria-live="polite" className="lunora-auth-toaster">
            {toasts.map((toast) => (
                <div className="lunora-auth-toast" key={toast.id} role="status">
                    <span className="lunora-auth-toast__message">{toast.message}</span>
                    <button
                        aria-label="Dismiss"
                        className="lunora-auth-toast__dismiss"
                        onClick={() => {
                            dismissToast(toast.id);
                        }}
                        type="button"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
};

/**
 * A CAPTCHA widget for the sign-in / sign-up forms.
 *
 * Place it inside the card; it publishes a token that `client.ts` attaches to
 * outgoing auth requests via `captchaHeaders()` (see `core/captcha.ts` — the
 * token is not threaded through the flows). It renders nothing without a
 * `siteKey`, so it is safe to mount unconditionally.
 */
interface CaptchaProps {
    provider: CaptchaProvider;
    siteKey?: string;
}

const Captcha = ({ provider, siteKey }: CaptchaProps): ReactElement | null => {
    const context = useAuthUI();
    const hostRef = useRef<HTMLDivElement | null>(null);
    const { onError } = context;

    useEffect(() => {
        const host = hostRef.current;

        if (host === null || siteKey === undefined || siteKey === "") {
            return undefined;
        }

        return renderCaptcha(host, { onError, provider, siteKey });
    }, [provider, siteKey, onError]);

    if (siteKey === undefined || siteKey === "") {
        return null;
    }

    return <div className="lunora-auth-captcha" ref={hostRef} />;
};

/**
 * Fires Google One Tap once on mount. Renders nothing — the prompt is Google's
 * own floating UI, not ours.
 *
 * Mount it on the sign-in screen only when signed out; it is an accelerator
 * beside the form, and every reason it declines to appear is normal (see
 * `core/one-tap.ts`).
 */
const OneTap = (): null => {
    const context = useAuthUI();
    const enabled = context.plugins.oneTap;

    useEffect(() => {
        if (enabled) {
            void promptOneTap(context);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per mount; re-prompting on every context change would nag the user.
    }, [enabled]);

    return null;
};

/**
 * Upload an organization's logo. Renders only when the app configured an
 * `avatar.upload` handler — without one, `&lt;OrganizationSettingsCard>`'s logo URL
 * field is the fallback.
 */
interface OrganizationLogoCardProps {
    organizationId?: string;
}

const OrganizationLogoCard = ({ organizationId }: OrganizationLogoCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController((context_) => createOrganizationLogoController(context_, { organizationId }), [organizationId]);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const onPick = (event: { target: { files?: FileList | null } }): void => {
        const file = event.target.files?.[0];

        if (inputRef.current) {
            inputRef.current.value = "";
        }

        if (file) {
            void actions.upload(file);
        }
    };

    if (context.avatar.upload === undefined || !context.plugins.organization) {
        return null;
    }

    return (
        <AuthCard title={t.organizationLogo}>
            <FormBanner error={state.error} />
            <div className="lunora-auth-avatar-row">
                {state.logoUrl === undefined || state.logoUrl === "" ? (
                    <span aria-hidden="true" className="lunora-auth-avatar lunora-auth-avatar--initials" />
                ) : (
                    <img alt="" className="lunora-auth-avatar" src={state.logoUrl} />
                )}
                <div className="lunora-auth-avatar-row__actions">
                    <input
                        accept={ACCEPT_ATTRIBUTE}
                        aria-label={t.avatarUpload}
                        className="lunora-auth-visually-hidden"
                        onChange={onPick}
                        ref={inputRef}
                        type="file"
                    />
                    <button
                        className="lunora-auth-button"
                        disabled={state.status === "submitting"}
                        onClick={() => {
                            inputRef.current?.click();
                        }}
                        type="button"
                    >
                        {t.avatarUpload}
                    </button>
                    {state.logoUrl === undefined || state.logoUrl === "" ? null : (
                        <button
                            className="lunora-auth-button lunora-auth-button--danger"
                            disabled={state.status === "submitting"}
                            onClick={() => {
                                void actions.remove();
                            }}
                            type="button"
                        >
                            {t.avatarRemove}
                        </button>
                    )}
                </div>
            </div>
        </AuthCard>
    );
};

export type { CaptchaProps, OrganizationLogoCardProps };
export { Captcha, ErrorToaster, OneTap, OrganizationLogoCard };
