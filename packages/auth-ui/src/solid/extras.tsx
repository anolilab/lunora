/* eslint-disable no-secrets/no-secrets -- JSDoc names the `<OrganizationSettingsCard>` component, not a credential. */

import type { JSX } from "solid-js";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { ACCEPT_ATTRIBUTE } from "../core/avatar";
import type { CaptchaProvider } from "../core/captcha";
import { renderCaptcha } from "../core/captcha";
import { promptOneTap } from "../core/one-tap";
import { createOrganizationLogoController } from "../core/organization-logo";
import type { Toast } from "../core/toast";
import { dismissToast, getToasts, subscribeToasts } from "../core/toast";
import { AuthCard, FormBanner } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/**
 * Renders the errors that have no card to land in — a failed social redirect, a
 * failed unlink, a sign-out that didn't. Mount it once in your app shell.
 *
 * Errors that *do* belong to a card still render on that card's banner and never
 * reach here, so nothing is announced twice.
 */
const ErrorToaster = (): JSX.Element => {
    // The store is module-level (see `core/toast.ts`), so this mirrors it into a
    // signal rather than going through `createController` — there is no
    // per-provider controller to build.
    const [toasts, setToasts] = createSignal<ReadonlyArray<Toast>>(getToasts());

    onCleanup(
        subscribeToasts(() => {
            setToasts(getToasts());
        }),
    );

    return (
        // `polite`, not `assertive`: these are failures the user can retry, not
        // something that should interrupt a screen reader mid-sentence.
        <Show when={toasts().length > 0}>
            <div aria-live="polite" class="lunora-auth-toaster">
                <For each={toasts()}>
                    {(toast) => (
                        <div class="lunora-auth-toast" role="status">
                            <span class="lunora-auth-toast__message">{toast.message}</span>
                            <button
                                aria-label="Dismiss"
                                class="lunora-auth-toast__dismiss"
                                onClick={() => {
                                    dismissToast(toast.id);
                                }}
                                type="button"
                            >
                                ×
                            </button>
                        </div>
                    )}
                </For>
            </div>
        </Show>
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

const Captcha = (props: CaptchaProps): JSX.Element => {
    const context = useAuthUI();
    // An empty string is the same as "not configured" — an app reading the key
    // out of an env var that isn't set should render nothing, not a widget the
    // provider will reject.
    const siteKey = (): string | undefined => (props.siteKey === "" ? undefined : props.siteKey);

    return (
        // The widget is created inside the `<Show>` branch, so its owner is the
        // branch: losing the site key disposes the effect below and runs the
        // teardown, which also drops any single-use token it left behind.
        <Show when={siteKey()}>
            {(key) => {
                let host: HTMLDivElement | undefined;

                createEffect(() => {
                    if (host === undefined) {
                        return;
                    }

                    onCleanup(renderCaptcha(host, { onError: context.onError, provider: props.provider, siteKey: key() }));
                });

                return (
                    <div
                        class="lunora-auth-captcha"
                        ref={(element) => {
                            host = element;
                        }}
                    />
                );
            }}
        </Show>
    );
};

/**
 * Fires Google One Tap once on mount. Renders nothing — the prompt is Google's
 * own floating UI, not ours.
 *
 * Mount it on the sign-in screen only when signed out; it is an accelerator
 * beside the form, and every reason it declines to appear is normal (see
 * `core/one-tap.ts`).
 */
const OneTap = (): JSX.Element => {
    const context = useAuthUI();

    // `onMount`, not `createEffect`: prompting again on any later change would
    // nag the user with a prompt they already dismissed.
    onMount(() => {
        if (context.plugins.oneTap) {
            void promptOneTap(context);
        }
    });

    return null;
};

/**
 * Upload an organization's logo. Renders only when the app configured an
 * `avatar.upload` handler — without one, `<OrganizationSettingsCard>`'s logo URL
 * field is the fallback.
 */
interface OrganizationLogoCardProps {
    organizationId?: string;
}

const OrganizationLogoCard = (props: OrganizationLogoCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController((context_) => createOrganizationLogoController(context_, { organizationId: props.organizationId }));
    // A callback ref rather than Solid's shorthand — see the note in
    // `user-button.tsx`: the shorthand's compiler-generated assignment is
    // invisible to static analysis, which then reads the `if (input)` guard
    // below as dead code.
    let input: HTMLInputElement | undefined;

    if (context.avatar.upload === undefined || !context.plugins.organization) {
        return null;
    }

    const onPick = (): void => {
        const file = input?.files?.[0];

        // Clear the input so re-picking the same file after a failure still
        // fires `change` — browsers suppress it when the value is unchanged.
        if (input) {
            input.value = "";
        }

        if (file) {
            void actions.upload(file);
        }
    };

    return (
        <AuthCard title={t.organizationLogo}>
            <FormBanner error={state.error} />
            <div class="lunora-auth-avatar-row">
                <Show
                    fallback={<span aria-hidden="true" class="lunora-auth-avatar lunora-auth-avatar--initials" />}
                    when={state.logoUrl !== undefined && state.logoUrl !== ""}
                >
                    <img alt="" class="lunora-auth-avatar" src={state.logoUrl} />
                </Show>
                <div class="lunora-auth-avatar-row__actions">
                    <input
                        accept={ACCEPT_ATTRIBUTE}
                        aria-label={t.avatarUpload}
                        class="lunora-auth-visually-hidden"
                        onChange={onPick}
                        ref={(element) => {
                            input = element;
                        }}
                        type="file"
                    />
                    <button
                        class="lunora-auth-button"
                        disabled={state.status === "submitting"}
                        onClick={() => {
                            input?.click();
                        }}
                        type="button"
                    >
                        {t.avatarUpload}
                    </button>
                    <Show when={state.logoUrl !== undefined && state.logoUrl !== ""}>
                        <button
                            class="lunora-auth-button lunora-auth-button--danger"
                            disabled={state.status === "submitting"}
                            onClick={() => {
                                void actions.remove();
                            }}
                            type="button"
                        >
                            {t.avatarRemove}
                        </button>
                    </Show>
                </div>
            </div>
        </AuthCard>
    );
};

export type { CaptchaProps, OrganizationLogoCardProps };
export { Captcha, ErrorToaster, OneTap, OrganizationLogoCard };
