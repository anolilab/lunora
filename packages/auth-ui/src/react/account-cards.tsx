"use client";

import type { ChangeEvent, ReactElement } from "react";
import { useRef } from "react";

import { createAccountsController, linkableProviders, NON_SOCIAL_PROVIDERS } from "../core/accounts";
import { ACCEPT_ATTRIBUTE, createAvatarUploadController } from "../core/avatar";
import { isFlowEnabled } from "../core/flow-gate";
import { providerLabel } from "../core/labels";
import { createThemeModeController, THEME_MODES } from "../core/theme-mode";
import { createSetUsernameController } from "../core/username";
import { createUsernameAvailabilityController } from "../core/username-availability";
import { AuthCard, Field, FormBanner, Skeleton, SubmitButton, UsernameAvailability } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import { UserAvatar } from "./user-button";

const onSubmit =
    (run: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void run();
    };

/**
 * Which OAuth providers are attached, with link/unlink.
 *
 * The "available to link" list is `context.social` minus what is already
 * attached — so with server discovery on, it is exactly the providers the
 * deployment configured, and an app that adds one gets a new button with no
 * client change.
 */
const LinkedAccountsCard = (): ReactElement => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createAccountsController);

    const linkable = linkableProviders(state.items, context.social);

    return (
        <AuthCard title={t.accountsTitle}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton />
            ) : (
                <ul className="lunora-auth-list">
                    {state.items.map((account) => (
                        <li className="lunora-auth-list__item" key={account.id ?? account.providerId}>
                            <span className="lunora-auth-list__label">{providerLabel(account.providerId ?? "")}</span>
                            {/*
                             * `credential` is the password and `passkey` rows belong to
                             * <PasskeysCard>; offering "unlink" for either would be a
                             * button that either fails or deletes the wrong thing.
                             */}
                            {NON_SOCIAL_PROVIDERS.has(account.providerId ?? "") ? null : (
                                <button
                                    className="lunora-auth-button lunora-auth-button--danger"
                                    disabled={state.busy || state.items.length <= 1}
                                    onClick={() => {
                                        void actions.unlink(account.providerId ?? "", account.accountId);
                                    }}
                                    type="button"
                                >
                                    {t.remove}
                                </button>
                            )}
                        </li>
                    ))}
                    {state.items.length === 0 ? <li className="lunora-auth-list__empty">{t.accountsEmpty}</li> : null}
                </ul>
            )}
            {linkable.length > 0 ? (
                <div className="lunora-auth-social">
                    {linkable.map((provider) => (
                        <button
                            className="lunora-auth-button lunora-auth-button--secondary"
                            disabled={state.busy}
                            key={provider}
                            onClick={() => {
                                void actions.link(provider);
                            }}
                            type="button"
                        >
                            {`${t.accountsLink}: ${providerLabel(provider)}`}
                        </button>
                    ))}
                </div>
            ) : null}
        </AuthCard>
    );
};

/**
 * Avatar upload. Rendered only when the app configured an `avatar.upload`
 * handler — without one there is nowhere to put the bytes, and `&lt;ProfileCard>`'s
 * URL field is the honest fallback.
 */
const AvatarCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createAvatarUploadController);
    const inputRef = useRef<HTMLInputElement | null>(null);

    if (context.avatar.upload === undefined) {
        return null;
    }

    const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
        const file = event.target.files?.[0];

        // Clear the input so re-picking the same file after a failure still
        // fires `change` — browsers suppress it when the value is unchanged.
        // Cleared through the ref rather than `event.target` so the handler
        // doesn't mutate its own argument.
        if (inputRef.current) {
            inputRef.current.value = "";
        }

        if (file) {
            void actions.upload(file);
        }
    };

    return (
        <AuthCard title={t.avatar}>
            <FormBanner error={state.error} />
            <div className="lunora-auth-avatar-row">
                <UserAvatar size={64} user={{ image: state.imageUrl }} />
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
                    {state.imageUrl === undefined || state.imageUrl === "" ? null : (
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

/** Claim or change the username, when the `username` plugin is on. */
const SetUsernameCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createSetUsernameController);
    // Checked as the user types, so a taken name surfaces here rather than as a
    // failed save with the field already blurred.
    const [availability, availabilityActions] = useController(createUsernameAvailabilityController);

    if (!isFlowEnabled(context, "username", "SetUsernameCard")) {
        return null;
    }

    return (
        <AuthCard title={t.usernameLabel}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="username"
                    field={state.fields.username}
                    label={t.usernameLabel}
                    name="username"
                    onBlur={() => {
                        actions.blur("username");
                    }}
                    onChange={(value) => {
                        actions.setField("username", value);
                        availabilityActions.check(value);
                    }}
                />
                <UsernameAvailability status={availability.status} />
                <SubmitButton pending={state.status === "submitting"}>{t.saveChanges}</SubmitButton>
            </form>
        </AuthCard>
    );
};

/**
 * Light / dark / system. Not a better-auth feature at all — it lives here
 * because account settings is where people look for it.
 */
const AppearanceCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(() => createThemeModeController());

    const label: Record<string, string> = { dark: t.themeDark, light: t.themeLight, system: t.themeSystem };

    return (
        <AuthCard title={t.appearance}>
            <div className="lunora-auth-segmented" role="radiogroup">
                {THEME_MODES.map((mode) => (
                    <button
                        aria-checked={state.mode === mode}
                        className="lunora-auth-segmented__option"
                        key={mode}
                        onClick={() => {
                            actions.setMode(mode);
                        }}
                        role="radio"
                        type="button"
                    >
                        {label[mode]}
                    </button>
                ))}
            </div>
        </AuthCard>
    );
};

export { AppearanceCard, AvatarCard, LinkedAccountsCard, SetUsernameCard };
