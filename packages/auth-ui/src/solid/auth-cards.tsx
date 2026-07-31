import type { JSX } from "solid-js";
import { Show } from "solid-js";

import { signInAnonymously } from "../core/anonymous";
import { queryParameter } from "../core/browser-location";
import { createEmailOtpController } from "../core/email-otp";
import { isFlowEnabled } from "../core/flow-gate";
import { createForgotPasswordController } from "../core/forgot-password";
import { readLastLoginMethod } from "../core/last-login-method";
import { createMagicLinkController } from "../core/magic-link";
import { createResetPasswordController } from "../core/reset-password";
import { createResetPasswordOtpController } from "../core/reset-password-otp";
import { createSignInController } from "../core/sign-in";
import { createSignUpController } from "../core/sign-up";
import { signInWithSocial } from "../core/social";
import { createTwoFactorVerifyController } from "../core/two-factor-verify";
import { AuthCard, AuthDivider, AuthLink, Field, FormBanner, PasswordStrength, SocialButtons, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/** Guest sign-in, when the `anonymous` plugin is on. */
const AnonymousButton = (): JSX.Element => {
    const context = useAuthUI();

    return (
        <button
            class="lunora-auth-button lunora-auth-button--secondary"
            onClick={() => {
                void signInAnonymously(context);
            }}
            type="button"
        >
            {context.localization.anonymousSignIn}
        </button>
    );
};

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
    // Read once when the card is created rather than in an effect: it is a
    // cookie, it is available before the first paint, and it only picks a badge.
    const lastUsed = readLastLoginMethod();

    return (
        <AuthCard footer={<AuthLink href={props.signUpHref ?? "/sign-up"}>{t.noAccount}</AuthLink>} title={t.signIn}>
            <SocialButtons
                lastUsed={context.plugins.lastLoginMethod ? lastUsed : undefined}
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
            </Show>
        </AuthCard>
    );
};

interface SignUpCardProps {
    signInHref?: string;
}

const SignUpCard = (props: SignUpCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t, social } = context;
    const [state, actions] = createController(createSignUpController);

    return (
        <AuthCard footer={<AuthLink href={props.signInHref ?? "/sign-in"}>{t.haveAccount}</AuthLink>} title={t.signUp}>
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
                    autoComplete="one-time-code"
                    field={state.fields.otp}
                    label={t.codeLabel}
                    name="otp"
                    onBlur={() => {
                        actions.blur("otp");
                    }}
                    onChange={(value) => {
                        actions.setField("otp", value);
                    }}
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
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createMagicLinkController);

    if (!isFlowEnabled(context, "magicLink", "MagicLinkCard")) {
        return null;
    }

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

    if (!isFlowEnabled(context, "twoFactor", "TwoFactorCard")) {
        return null;
    }

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
export { AnonymousButton, EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, ResetPasswordOtpCard, SignInCard, SignUpCard, TwoFactorCard };
