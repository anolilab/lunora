import type { JSX } from "solid-js";
import { Show } from "solid-js";

import {
    createEmailOtpController,
    createForgotPasswordController,
    createMagicLinkController,
    createResetPasswordController,
    createSignInController,
    createSignUpController,
    createTwoFactorVerifyController,
    signInWithSocial,
} from "../core";
import { AuthCard, AuthDivider, AuthLink, Field, FormBanner, SocialButtons, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/** Stop the browser's native submit and run the controller action (async or not). */
const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

interface SignInCardProps {
    forgotPasswordHref?: string;
    signUpHref?: string;
}

const SignInCard = (props: SignInCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t, social } = context;
    const [state, actions] = createController(createSignInController);

    return (
        <AuthCard footer={<AuthLink href={props.signUpHref ?? "/sign-up"}>{t.noAccount}</AuthLink>} title={t.signIn}>
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
                <AuthLink href={props.forgotPasswordHref ?? "/forgot-password"}>{t.forgotPasswordLink}</AuthLink>
                <SubmitButton pending={state.status === "submitting"}>{t.signIn}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface SignUpCardProps {
    signInHref?: string;
}

const SignUpCard = (props: SignUpCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createSignUpController);

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? "/sign-in"}>{t.haveAccount}</AuthLink>} title={t.signUp}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const ForgotPasswordCard = (props: ForgotPasswordCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) => createForgotPasswordController(context, { resetPath: props.resetPath }));

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? "/sign-in"}>{t.backToSignIn}</AuthLink>} title={t.forgotPassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const ResetPasswordCard = (props: ResetPasswordCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) => createResetPasswordController(context, { token: props.token }));

    return (
        <AuthCard title={t.resetPassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const MagicLinkCard = (props: MagicLinkCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createMagicLinkController);

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? "/sign-in"}>{t.backToSignIn}</AuthLink>} title={t.magicLink}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const EmailOtpCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createEmailOtpController);

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
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) => createTwoFactorVerifyController(context, { method: props.method, trustDevice: props.trustDevice }));

    return (
        <AuthCard title={t.twoFactor}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
