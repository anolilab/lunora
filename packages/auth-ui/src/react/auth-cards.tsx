"use client";

import type { ReactElement } from "react";

import {
    createEmailOtpController,
    createForgotPasswordController,
    createMagicLinkController,
    createResetPasswordController,
    createSignInController,
    createSignUpController,
    createTwoFactorVerifyController,
    isFlowEnabled,
    signInWithSocial,
} from "../core";
import { AuthCard, AuthDivider, AuthLink, Field, FormBanner, SocialButtons, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

/** Stop the browser's native submit and run the controller action (async or not). */
const onSubmit =
    (action: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void action();
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

    return (
        <AuthCard footer={<AuthLink href={signUpHref}>{t.noAccount}</AuthLink>} title={t.signIn}>
            <SocialButtons
                onSelect={(provider) => {
                    void signInWithSocial(context, provider);
                }}
                providers={social}
            />
            {social.length > 0 ? <AuthDivider /> : null}
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
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
                <Field
                    autoComplete="current-password"
                    field={state.fields.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => {
                        actions.blur("password");
                    }}
                    onChange={(value) => {
                        actions.setField("password", value);
                    }}
                    type="password"
                />
                <AuthLink href={forgotPasswordHref}>{t.forgotPasswordLink}</AuthLink>
                <SubmitButton pending={pending}>{t.signIn}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface SignUpCardProps {
    signInHref?: string;
}

const SignUpCard = ({ signInHref = "/sign-in" }: SignUpCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createSignUpController);

    return (
        <AuthCard footer={<AuthLink href={signInHref}>{t.haveAccount}</AuthLink>} title={t.signUp}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <Field
                    autoComplete="name"
                    field={state.fields.name}
                    label={t.nameLabel}
                    name="name"
                    onBlur={() => {
                        actions.blur("name");
                    }}
                    onChange={(value) => {
                        actions.setField("name", value);
                    }}
                />
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
                <Field
                    autoComplete="new-password"
                    field={state.fields.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => {
                        actions.blur("password");
                    }}
                    onChange={(value) => {
                        actions.setField("password", value);
                    }}
                    type="password"
                />
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
                <SubmitButton pending={state.status === "submitting"}>{t.forgotPassword}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface ResetPasswordCardProps {
    /** The reset token from the URL (`?token=...`). */
    token?: string;
}

const ResetPasswordCard = ({ token }: ResetPasswordCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController((context) => createResetPasswordController(context, { token }), [token]);

    return (
        <AuthCard title={t.resetPassword}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="new-password"
                    field={state.fields.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => {
                        actions.blur("password");
                    }}
                    onChange={(value) => {
                        actions.setField("password", value);
                    }}
                    type="password"
                />
                <Field
                    autoComplete="new-password"
                    field={state.fields.confirmPassword}
                    label={t.confirmPasswordLabel}
                    name="confirmPassword"
                    onBlur={() => {
                        actions.blur("confirmPassword");
                    }}
                    onChange={(value) => {
                        actions.setField("confirmPassword", value);
                    }}
                    type="password"
                />
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

    if (!isFlowEnabled(context, "magicLink", "MagicLinkCard")) {
        return null;
    }

    return (
        <AuthCard footer={<AuthLink href={signInHref}>{t.backToSignIn}</AuthLink>} title={t.magicLink}>
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
                <SubmitButton pending={state.status === "submitting"}>{t.magicLink}</SubmitButton>
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

    if (!isFlowEnabled(context, "twoFactor", "TwoFactorCard")) {
        return null;
    }

    return (
        <AuthCard title={t.twoFactor}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <Field
                    autoComplete="one-time-code"
                    field={state.fields.code}
                    label={t.codeLabel}
                    name="code"
                    onBlur={() => {
                        actions.blur("code");
                    }}
                    onChange={(value) => {
                        actions.setField("code", value);
                    }}
                />
                <SubmitButton pending={state.status === "submitting"}>{t.twoFactor}</SubmitButton>
            </form>
        </AuthCard>
    );
};

export type { ForgotPasswordCardProps, MagicLinkCardProps, ResetPasswordCardProps, SignInCardProps, SignUpCardProps, TwoFactorCardProps };
export { EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, SignInCard, SignUpCard, TwoFactorCard };
