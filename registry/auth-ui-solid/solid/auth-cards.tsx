import type { JSX } from "solid-js";
import { createSignal, onMount, Show } from "solid-js";

import { signInAnonymously } from "../core/anonymous";
import { createBackupCodeSignInController } from "../core/backup-codes";
import { queryParameter } from "../core/browser-location";
import { viewHref } from "../core/config";
import { createEmailOtpController } from "../core/email-otp";
import { isFlowEnabled } from "../core/flow-gate";
import { createForgotPasswordController } from "../core/forgot-password";
import { LAST_METHOD_EMAIL, LAST_METHOD_MAGIC_LINK, readLastLoginMethod } from "../core/last-login-method";
import { createMagicLinkController } from "../core/magic-link";
import { createResetPasswordController } from "../core/reset-password";
import { createResetPasswordOtpController } from "../core/reset-password-otp";
import { createSignInController } from "../core/sign-in";
import { createSignUpController } from "../core/sign-up";
import { signInWithSocial } from "../core/social";
import { createTwoFactorVerifyController } from "../core/two-factor-verify";
import { FormField, onSubmit } from "./form";
import { AuthCard, AuthDivider, AuthLink, Field, FormBanner, PasswordStrength, SocialButtons, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/**
 * Guest sign-in, when the `anonymous` plugin is on.
 *
 * Disabled while the call is in flight: `signIn.anonymous` creates an account
 * every time it is called, so a double-click without this leaves a second,
 * orphaned anonymous user behind — and the first click gives no feedback that
 * anything happened, which is what invites the second.
 */
const AnonymousButton = (): JSX.Element => {
    const context = useAuthUI();
    const [pending, setPending] = createSignal(false);

    return (
        <button
            class="lunora-auth-button lunora-auth-button--secondary"
            disabled={pending()}
            onClick={() => {
                setPending(true);
                void signInAnonymously(context).finally(() => {
                    setPending(false);
                });
            }}
            type="button"
        >
            {context.localization.anonymousSignIn}
        </button>
    );
};

interface SignInCardProps {
    /** Defaults to the configured forgot-password route; see `viewPaths.base`. */
    forgotPasswordHref?: string;
    /** Defaults to the configured sign-up route; see `viewPaths.base`. */
    signUpHref?: string;
}

const SignInCard = (props: SignInCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t, social } = context;
    const [state, actions] = createController(createSignInController);
    // Read after mount, not when the card is created: the server has no cookie,
    // so a render-time read is a hydration mismatch. See `lastLoginMethodStore`.
    const [lastUsedAfterMount, setLastUsedAfterMount] = createSignal<string | undefined>();

    onMount(() => {
        setLastUsedAfterMount(readLastLoginMethod());
    });

    const lastUsed = () => (context.plugins.lastLoginMethod ? lastUsedAfterMount() : undefined);

    return (
        <AuthCard
            footer={context.signUp ? <AuthLink href={props.signUpHref ?? viewHref(context, "signUp")}>{t.noAccount}</AuthLink> : undefined}
            title={t.signIn}
        >
            <SocialButtons
                lastUsed={lastUsed()}
                onSelect={(provider) => {
                    void signInWithSocial(context, provider);
                }}
                providers={social}
            />
            <Show when={context.plugins.anonymous}>
                <AnonymousButton />
            </Show>
            <Show when={social.length > 0 && context.credentials}>
                <AuthDivider />
            </Show>
            {/*
             * An OAuth-only deployment has no password form to show. Discovery
             * reports that as `emailAndPassword: false`; without discovery it
             * defaults to true, which is the pre-existing behaviour.
             */}
            <Show when={context.credentials}>
                <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                    <FormBanner error={state.formError} />
                    <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                    <FormField actions={actions} autoComplete="current-password" field="password" label={t.passwordLabel} state={state} type="password" />
                    <AuthLink href={props.forgotPasswordHref ?? viewHref(context, "forgotPassword")}>{t.forgotPasswordLink}</AuthLink>
                    <SubmitButton pending={state.status === "submitting"}>
                        {t.signIn}
                        {/* better-auth records a password sign-in as "email", so without this the badge is invisible for the most common route there is. */}
                        <Show when={lastUsed() === LAST_METHOD_EMAIL}>
                            <span class="lunora-auth-social__badge">{t.lastUsed}</span>
                        </Show>
                    </SubmitButton>
                </form>
            </Show>
        </AuthCard>
    );
};

interface SignUpCardProps {
    /** Defaults to `redirects.signIn`, itself derived from `viewPaths.base`. */
    signInHref?: string;
}

const SignUpCard = (props: SignUpCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t, social } = context;
    const [state, actions] = createController(createSignUpController);

    // The server can close self-serve sign-up (`emailAndPassword.disableSignUp`).
    // Mirrors the plugin-gated cards above: mounted directly, this card renders
    // nothing rather than a form that will fail on submit; `AuthView`'s route
    // falls back to the sign-in card instead of landing on a blank page.
    if (!context.signUp) {
        return null;
    }

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? context.redirects.signIn}>{t.haveAccount}</AuthLink>} title={t.signUp}>
            {/*
             * Social buttons belong on sign-up too — OAuth is a sign-up path, not
             * just a sign-in one, and omitting them here sends new users through a
             * password form they never needed. This was the gap against
             * better-auth-ui's <AuthView>.
             */}
            <SocialButtons
                onSelect={(provider) => {
                    void signInWithSocial(context, provider);
                }}
                providers={social}
            />
            <Show when={social.length > 0}>
                <AuthDivider />
            </Show>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <FormField actions={actions} autoComplete="name" field="name" label={t.nameLabel} state={state} />
                <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                <FormField actions={actions} autoComplete="new-password" field="password" label={t.passwordLabel} state={state} type="password" />
                <PasswordStrength value={state.fields.password.value} />
                <SubmitButton pending={state.status === "submitting"}>{t.signUp}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface ForgotPasswordCardProps {
    /** Defaults to the configured reset-password route; see `viewPaths.base`. */
    resetPath?: string;
    /** Defaults to `redirects.signIn`, itself derived from `viewPaths.base`. */
    signInHref?: string;
}

const ForgotPasswordCard = (props: ForgotPasswordCardProps = {}): JSX.Element => {
    const { localization: t, redirects } = useAuthUI();
    const [state, actions] = createController((context) => createForgotPasswordController(context, { resetPath: props.resetPath }));

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? redirects.signIn}>{t.backToSignIn}</AuthLink>} title={t.forgotPassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                <SubmitButton pending={state.status === "submitting"}>{t.forgotPassword}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface ResetPasswordCardProps {
    /** Defaults to `?token=` from the URL. */
    token?: string;
}

const ResetPasswordCard = (props: ResetPasswordCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) => createResetPasswordController(context, { token: props.token ?? queryParameter("token") }));

    return (
        <AuthCard title={t.resetPassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="new-password" field="password" label={t.passwordLabel} state={state} type="password" />
                <FormField actions={actions} autoComplete="new-password" field="confirmPassword" label={t.confirmPasswordLabel} state={state} type="password" />
                <SubmitButton pending={state.status === "submitting"}>{t.resetPassword}</SubmitButton>
            </form>
        </AuthCard>
    );
};

/**
 * Redeems an emailed one-time code instead of a link — for apps that set
 * `forgotPassword: { method: "otp" }`. Unlike {@link ResetPasswordCard}, the
 * email address is a field rather than something carried from the previous
 * screen: a code can legitimately be redeemed from a fresh tab.
 */
const ResetPasswordOtpCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) => createResetPasswordOtpController(context));

    return (
        <AuthCard description={t.resetPasswordOtpDescription} title={t.resetPassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                <FormField actions={actions} autoComplete="one-time-code" field="otp" inputMode="numeric" label={t.codeLabel} state={state} />
                <FormField actions={actions} autoComplete="new-password" field="password" label={t.passwordLabel} state={state} type="password" />
                <FormField actions={actions} autoComplete="new-password" field="confirmPassword" label={t.confirmPasswordLabel} state={state} type="password" />
                <SubmitButton pending={state.status === "submitting"}>{t.resetPassword}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface MagicLinkCardProps {
    /** Defaults to `redirects.signIn`, itself derived from `viewPaths.base`. */
    signInHref?: string;
}

const MagicLinkCard = (props: MagicLinkCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createMagicLinkController);
    // Read after mount, not when the card is created: the server has no cookie,
    // so a render-time read is a hydration mismatch. See `lastLoginMethodStore`.
    const [lastUsedAfterMount, setLastUsedAfterMount] = createSignal<string | undefined>();

    onMount(() => {
        setLastUsedAfterMount(readLastLoginMethod());
    });

    const lastUsed = () => (context.plugins.lastLoginMethod ? lastUsedAfterMount() : undefined);

    if (!isFlowEnabled(context, "magicLink", "MagicLinkCard")) {
        return null;
    }

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? context.redirects.signIn}>{t.backToSignIn}</AuthLink>} title={t.magicLink}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                <SubmitButton pending={state.status === "submitting"}>
                    {t.magicLink}
                    <Show when={lastUsed() === LAST_METHOD_MAGIC_LINK}>
                        <span class="lunora-auth-social__badge">{t.lastUsed}</span>
                    </Show>
                </SubmitButton>
            </form>
        </AuthCard>
    );
};

const EmailOtpCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createEmailOtpController);

    if (!isFlowEnabled(context, "emailOtp", "EmailOtpCard")) {
        return null;
    }

    return (
        <Show
            fallback={
                <AuthCard title={t.emailOtp}>
                    <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.sendCode)}>
                        <FormBanner error={state.formError} success={state.successMessage} />
                        <Field
                            autoComplete="email"
                            field={state.email}
                            label={t.emailLabel}
                            name="email"
                            onBlur={() => undefined}
                            onChange={actions.setEmail}
                            type="email"
                        />
                        <SubmitButton pending={state.status === "submitting"}>{t.emailOtp}</SubmitButton>
                    </form>
                </AuthCard>
            }
            when={state.step === "verify"}
        >
            <AuthCard
                description={t.emailOtpSent}
                footer={
                    <button class="lunora-auth-link" onClick={actions.back} type="button">
                        {t.sendNewCode}
                    </button>
                }
                title={t.emailOtp}
            >
                <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.verify)}>
                    <FormBanner error={state.formError} />
                    <Field
                        autoComplete="one-time-code"
                        field={state.code}
                        inputMode="numeric"
                        label={t.codeLabel}
                        name="code"
                        onBlur={() => undefined}
                        onChange={actions.setCode}
                    />
                    <SubmitButton pending={state.status === "submitting"}>{t.twoFactor}</SubmitButton>
                </form>
            </AuthCard>
        </Show>
    );
};

interface TwoFactorCardProps {
    method?: "otp" | "totp";
    trustDevice?: boolean;
}

const TwoFactorCard = (props: TwoFactorCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController((context_) =>
        createTwoFactorVerifyController(context_, { method: props.method, trustDevice: props.trustDevice }),
    );
    // Both controllers stay live regardless of which form is showing — a
    // session-mutating submit must not depend on the toggle's current position.
    const [backupState, backupActions] = createController((context_) => createBackupCodeSignInController(context_, { trustDevice: props.trustDevice }));
    const [useBackupCode, setUseBackupCode] = createSignal(false);

    if (!isFlowEnabled(context, "twoFactor", "TwoFactorCard")) {
        return null;
    }

    return (
        <Show
            fallback={
                <AuthCard
                    footer={
                        <button
                            class="lunora-auth-link"
                            onClick={() => {
                                setUseBackupCode(true);
                            }}
                            type="button"
                        >
                            {t.backupCodeSignIn}
                        </button>
                    }
                    title={t.twoFactor}
                >
                    <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                        <FormBanner error={state.formError} />
                        <FormField actions={actions} autoComplete="one-time-code" field="code" inputMode="numeric" label={t.codeLabel} state={state} />
                        <SubmitButton pending={state.status === "submitting"}>{t.twoFactor}</SubmitButton>
                    </form>
                </AuthCard>
            }
            when={useBackupCode()}
        >
            <AuthCard
                footer={
                    <button
                        class="lunora-auth-link"
                        onClick={() => {
                            setUseBackupCode(false);
                        }}
                        type="button"
                    >
                        {t.twoFactorUseAuthenticator}
                    </button>
                }
                title={t.twoFactor}
            >
                <form class="lunora-auth-form" noValidate onSubmit={onSubmit(backupActions.submit)}>
                    <FormBanner error={backupState.formError} />
                    <FormField actions={backupActions} autoComplete="one-time-code" field="code" label={t.backupCodeLabel} state={backupState} />
                    <SubmitButton pending={backupState.status === "submitting"}>{t.twoFactor}</SubmitButton>
                </form>
            </AuthCard>
        </Show>
    );
};

export type { ForgotPasswordCardProps, MagicLinkCardProps, ResetPasswordCardProps, SignInCardProps, SignUpCardProps, TwoFactorCardProps };
export { AnonymousButton, EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, ResetPasswordOtpCard, SignInCard, SignUpCard, TwoFactorCard };
