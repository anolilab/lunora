import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

import { createAccountsController, linkableProviders, NON_SOCIAL_PROVIDERS } from "../core/accounts";
import { ACCEPT_ATTRIBUTE, createAvatarUploadController } from "../core/avatar";
import { isFlowEnabled } from "../core/flow-gate";
import { providerLabel } from "../core/labels";
import type { ThemeMode } from "../core/theme-mode";
import { createThemeModeController, THEME_MODES } from "../core/theme-mode";
import { createSetUsernameController } from "../core/username";
import { createUsernameAvailabilityController } from "../core/username-availability";
import { AuthCard, Field, FormBanner, Skeleton, SubmitButton, UsernameAvailability } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";
import { UserAvatar } from "./user-button";

const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

/**
 * Which OAuth providers are attached, with link/unlink.
 *
 * The "available to link" list is `context.social` minus what is already
 * attached — so with server discovery on, it is exactly the providers the
 * deployment configured, and an app that adds one gets a new button with no
 * client change.
 */
const LinkedAccountsCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createAccountsController);

    const linkable = (): ReadonlyArray<string> => linkableProviders(state.items, context.social);

    return (
        <AuthCard title={t.accountsTitle}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton />} when={!state.loading}>
                <ul class="lunora-auth-list">
                    <For each={state.items}>
                        {(account) => (
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{providerLabel(account.providerId ?? "")}</span>
                                {/*
                                 * `credential` is the password and `passkey` rows belong to
                                 * <PasskeysCard>; offering "unlink" for either would be a
                                 * button that either fails or deletes the wrong thing.
                                 */}
                                <Show when={!NON_SOCIAL_PROVIDERS.has(account.providerId ?? "")}>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--danger"
                                        disabled={state.busy || state.items.length <= 1}
                                        onClick={() => {
                                            void actions.unlink(account.providerId ?? "", account.accountId);
                                        }}
                                        type="button"
                                    >
                                        {t.remove}
                                    </button>
                                </Show>
                            </li>
                        )}
                    </For>
                    <Show when={state.items.length === 0}>
                        <li class="lunora-auth-list__empty">{t.accountsEmpty}</li>
                    </Show>
                </ul>
            </Show>
            <Show when={linkable().length > 0}>
                <div class="lunora-auth-social">
                    <For each={linkable()}>
                        {(provider) => (
                            <button
                                class="lunora-auth-button lunora-auth-button--secondary"
                                disabled={state.busy}
                                onClick={() => {
                                    void actions.link(provider);
                                }}
                                type="button"
                            >
                                {`${t.accountsLink}: ${providerLabel(provider)}`}
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </AuthCard>
    );
};

/**
 * Avatar upload. Rendered only when the app configured an `avatar.upload`
 * handler — without one there is nowhere to put the bytes, and `<ProfileCard>`'s
 * URL field is the honest fallback.
 */
const AvatarCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createAvatarUploadController);
    // A callback ref, like the other Solid components here: the shorthand's
    // assignment is compiler-generated and invisible to static analysis, which
    // then reads the variable as never assigned.
    let input: HTMLInputElement | undefined;

    if (context.avatar.upload === undefined) {
        return null;
    }

    const onPick = (event: Event & { currentTarget: HTMLInputElement }): void => {
        const file = event.currentTarget.files?.[0];

        // Cleared through the ref rather than the event's target, so the
        // handler doesn't mutate its own argument. Re-picking the same file
        // after a failure still fires `change`, which it otherwise would not.
        if (input) {
            input.value = "";
        }

        if (file) {
            void actions.upload(file);
        }
    };

    return (
        <AuthCard title={t.avatar}>
            <FormBanner error={state.error} />
            <div class="lunora-auth-avatar-row">
                <UserAvatar size={64} user={{ image: state.imageUrl }} />
                <div class="lunora-auth-avatar-row__actions">
                    <input
                        accept={ACCEPT_ATTRIBUTE}
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
                    <Show when={state.imageUrl !== undefined && state.imageUrl !== ""}>
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

/** Claim or change the username, when the `username` plugin is on. */
const SetUsernameCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createSetUsernameController);
    // Checked as the user types, so a taken name surfaces here rather than as a
    // failed save with the field already blurred.
    const [availability, availabilityActions] = createController(createUsernameAvailabilityController);

    if (!isFlowEnabled(context, "username", "SetUsernameCard")) {
        return null;
    }

    return (
        <AuthCard title={t.usernameLabel}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
const AppearanceCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(() => createThemeModeController());

    const label: Record<ThemeMode, string> = { dark: t.themeDark, light: t.themeLight, system: t.themeSystem };

    return (
        <AuthCard title={t.appearance}>
            <div class="lunora-auth-segmented" role="radiogroup">
                <For each={THEME_MODES}>
                    {(mode) => (
                        <button
                            aria-checked={state.mode === mode}
                            class="lunora-auth-segmented__option"
                            onClick={() => {
                                actions.setMode(mode);
                            }}
                            role="radio"
                            type="button"
                        >
                            {label[mode]}
                        </button>
                    )}
                </For>
            </div>
        </AuthCard>
    );
};

export { AppearanceCard, AvatarCard, LinkedAccountsCard, SetUsernameCard };
