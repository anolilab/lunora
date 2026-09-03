"use client";

import type { ReactElement } from "react";
import { useState, useSyncExternalStore } from "react";

import { signInAnonymously } from "../core/anonymous";
import { createBackupCodeSignInController } from "../core/backup-codes";
import { queryParameter } from "../core/browser-location";
import { createEmailOtpController } from "../core/email-otp";
import { isFlowEnabled } from "../core/flow-gate";
import { createForgotPasswordController } from "../core/forgot-password";
import { LAST_METHOD_EMAIL, LAST_METHOD_MAGIC_LINK, lastLoginMethodStore } from "../core/last-login-method";
import { createMagicLinkController } from "../core/magic-link";
import { createResetPasswordController } from "../core/reset-password";
import { createResetPasswordOtpController } from "../core/reset-password-otp";
import { createSignInController } from "../core/sign-in";
import { createSignUpController } from "../core/sign-up";
import { signInWithSocial } from "../core/social";
import { createTwoFactorVerifyController } from "../core/two-factor-verify";
import { FormField } from "./form";
import { onSubmit } from "./on-submit";
import { AuthCard, AuthDivider, AuthLink, Field, FormBanner, LastUsedBadge, PasswordStrength, SocialButtons, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

/** Guest sign-in, when the `anonymous` plugin is on. */
const AnonymousButton = (): ReactElement => {
    const context = useAuthUI();

    return (
        <button
            className="lunora-auth-button lunora-auth-button--secondary"
            onClick={() => {
                void signInAnonymously(context);
            }}
            type="button"
        >
            {context.localization.anonymousSignIn}
        </button>
    );
};

interface SignInCardProps {
    forgotPasswordHref?: string;
    signUpHref?: string;
}

const SignInCard = ({ forgotPasswordHref = "/forgot-password", signUpHref = "/sign-up" }: SignInCardProps = {}): ReactElement => {
    const context = useAuthUI();
    const { localization: t, social } = context;
    const [state, actions] = useController(createSignInController);
    const pending = state.status === "submitting";
    // Read after hydration, not during render: the server has no cookie, so a
    // render-time read is a hydration mismatch. See `lastLoginMethodStore`.
    const lastUsedAfterHydration = useSyncExternalStore(
        lastLoginMethodStore.subscribe,
        lastLoginMethodStore.getSnapshot,
        lastLoginMethodStore.getServerSnapshot,
    );
    const lastUsed = context.plugins.lastLoginMethod ? lastUsedAfterHydration : undefined;

    return (
        <AuthCard footer={context.signUp ? <AuthLink href={signUpHref}>{t.noAccount}</AuthLink> : undefined} title={t.signIn}>
            <SocialButtons
                lastUsed={lastUsed}
                onSelect={(provider) => {
                    void signInWithSocial(context, provider);
                }}
                providers={social}
            />
            {context.plugins.anonymous ? <AnonymousButton /> : null}
            {social.length > 0 && context.credentials ? <AuthDivider /> : null}
            {/*
             * An OAuth-only deployment has no password form to show. Discovery
             * reports that as `emailAndPassword: false`; without discovery it
             * defaults to true, which is the pre-existing behaviour.
             */}
            {context.credentials ? (
                <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                    <FormBanner error={state.formError} />
                    <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                    <FormField actions={actions} autoComplete="current-password" field="password" label={t.passwordLabel} state={state} type="password" />
                    <AuthLink href={forgotPasswordHref}>{t.forgotPasswordLink}</AuthLink>
                    <SubmitButton pending={pending}>
                        {t.signIn}
                        {lastUsed === LAST_METHOD_EMAIL ? <LastUsedBadge /> : null}
                    </SubmitButton>
                </form>
            ) : null}
        </AuthCard>
    );
};

interface SignUpCardProps {
    signInHref?: string;
}

const SignUpCard = ({ signInHref = "/sign-in" }: SignUpCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t, social } = context;
    const [state, actions] = useController(createSignUpController);

    // The server can close self-serve sign-up (`emailAndPassword.disableSignUp`).
    // Mirrors the plugin-gated cards below: mounted directly, this card renders
    // nothing rather than a form that will fail on submit; `AuthView`'s route
    // falls back to the sign-in card instead of landing on a blank page.
    if (!context.signUp) {
        return null;
    }

    return (
        <AuthCard footer={<AuthLink href={signInHref}>{t.haveAccount}</AuthLink>} title={t.signUp}>
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
            {social.length > 0 ? <AuthDivider /> : null}
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
    resetPath?: string;
    signInHref?: string;
}

const ForgotPasswordCard = ({ resetPath, signInHref = "/sign-in" }: ForgotPasswordCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController((context) => createForgotPasswordController(context, { resetPath }), [resetPath]);

    return (
        <AuthCard footer={<AuthLink href={signInHref}>{t.backToSignIn}</AuthLink>} title={t.forgotPassword}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const ResetPasswordCard = ({ token }: ResetPasswordCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const resolved = token ?? queryParameter("token");
    const [state, actions] = useController((context) => createResetPasswordController(context, { token: resolved }), [resolved]);

    return (
        <AuthCard title={t.resetPassword}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
const ResetPasswordOtpCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createResetPasswordOtpController);

    return (
        <AuthCard description={t.resetPasswordOtpDescription} title={t.resetPassword}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
    signInHref?: string;
}

const MagicLinkCard = ({ signInHref = "/sign-in" }: MagicLinkCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createMagicLinkController);
    // Read after hydration, not during render: the server has no cookie, so a
    // render-time read is a hydration mismatch. See `lastLoginMethodStore`.
    const lastUsedAfterHydration = useSyncExternalStore(
        lastLoginMethodStore.subscribe,
        lastLoginMethodStore.getSnapshot,
        lastLoginMethodStore.getServerSnapshot,
    );
    const lastUsed = context.plugins.lastLoginMethod ? lastUsedAfterHydration : undefined;

    if (!isFlowEnabled(context, "magicLink", "MagicLinkCard")) {
        return null;
    }

    return (
        <AuthCard footer={<AuthLink href={signInHref}>{t.backToSignIn}</AuthLink>} title={t.magicLink}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="email" field="email" label={t.emailLabel} state={state} type="email" />
                <SubmitButton pending={state.status === "submitting"}>
                    {t.magicLink}
                    {lastUsed === LAST_METHOD_MAGIC_LINK ? <LastUsedBadge /> : null}
                </SubmitButton>
            </form>
        </AuthCard>
    );
};

const EmailOtpCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createEmailOtpController);
    const pending = state.status === "submitting";

    if (!isFlowEnabled(context, "emailOtp", "EmailOtpCard")) {
        return null;
    }

    if (state.step === "verify") {
        return (
            <AuthCard
                description={t.emailOtpSent}
                footer={
                    <button className="lunora-auth-link" onClick={actions.back} type="button">
                        {t.sendNewCode}
                    </button>
                }
                title={t.emailOtp}
            >
                <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.verify)}>
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
                    <SubmitButton pending={pending}>{t.twoFactor}</SubmitButton>
                </form>
            </AuthCard>
        );
    }

    return (
        <AuthCard title={t.emailOtp}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.sendCode)}>
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
                <SubmitButton pending={pending}>{t.emailOtp}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface TwoFactorCardProps {
    method?: "otp" | "totp";
    trustDevice?: boolean;
}

const TwoFactorCard = ({ method, trustDevice }: TwoFactorCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController((context_) => createTwoFactorVerifyController(context_, { method, trustDevice }), [method, trustDevice]);
    const [backupState, backupActions] = useController((context_) => createBackupCodeSignInController(context_, { trustDevice }), [trustDevice]);
    // Both controllers are always live — a form's live session-mutating submit
    // must not depend on which mode happened to be showing when it was called.
    const [useBackupCode, setUseBackupCode] = useState(false);

    if (!isFlowEnabled(context, "twoFactor", "TwoFactorCard")) {
        return null;
    }

    if (useBackupCode) {
        return (
            <AuthCard
                footer={
                    <button
                        className="lunora-auth-link"
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
                <form className="lunora-auth-form" noValidate onSubmit={onSubmit(backupActions.submit)}>
                    <FormBanner error={backupState.formError} />
                    <FormField actions={backupActions} autoComplete="one-time-code" field="code" label={t.backupCodeLabel} state={backupState} />
                    <SubmitButton pending={backupState.status === "submitting"}>{t.twoFactor}</SubmitButton>
                </form>
            </AuthCard>
        );
    }

    return (
        <AuthCard
            footer={
                <button
                    className="lunora-auth-link"
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
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <FormField actions={actions} autoComplete="one-time-code" field="code" inputMode="numeric" label={t.codeLabel} state={state} />
                <SubmitButton pending={state.status === "submitting"}>{t.twoFactor}</SubmitButton>
            </form>
        </AuthCard>
    );
};

export type { ForgotPasswordCardProps, MagicLinkCardProps, ResetPasswordCardProps, SignInCardProps, SignUpCardProps, TwoFactorCardProps };
export { AnonymousButton, EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, ResetPasswordOtpCard, SignInCard, SignUpCard, TwoFactorCard };
