"use client";

import type { ReactElement } from "react";

import { createPhoneSignInController } from "../core/phone-number";
import { createUsernameSignInController } from "../core/username";
import { isFlowEnabled } from "../core/flow-gate";
import { EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, SignInCard, SignUpCard, TwoFactorCard } from "./auth-cards";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { DeviceAuthorizationCard } from "./plugin-cards";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import { AcceptInvitationCard, VerifyEmailCard } from "./verify-invite-cards";

const onSubmit =
    (action: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void action();
    };

/** Sign in with a username instead of an email. */
const UsernameSignInCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createUsernameSignInController);

    if (!isFlowEnabled(context, "username", "UsernameSignInCard")) {
        return null;
    }

    return (
        <AuthCard title={t.signIn}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
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
                    }}
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
                <SubmitButton pending={state.status === "submitting"}>{t.signIn}</SubmitButton>
            </form>
        </AuthCard>
    );
};

/** Sign in with a phone number and password. */
const PhoneSignInCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createPhoneSignInController);

    if (!isFlowEnabled(context, "phoneNumber", "PhoneSignInCard")) {
        return null;
    }

    return (
        <AuthCard title={t.signIn}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <Field
                    autoComplete="tel"
                    field={state.fields.phoneNumber}
                    label={t.phoneLabel}
                    name="phoneNumber"
                    onBlur={() => {
                        actions.blur("phoneNumber");
                    }}
                    onChange={(value) => {
                        actions.setField("phoneNumber", value);
                    }}
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
                <SubmitButton pending={state.status === "submitting"}>{t.signIn}</SubmitButton>
            </form>
        </AuthCard>
    );
};

/**
 * One route for every auth screen: mount this at `/auth/:view` and pass the
 * segment, instead of wiring ten routes to ten cards.
 *
 * The segments are configurable through the provider's `viewPaths`, so the URLs
 * stay the app's decision — this only maps whichever segment arrives to the card
 * that owns it. An unrecognized segment falls back to sign-in rather than
 * rendering nothing, because a typo'd auth URL should still let someone in.
 */
interface AuthViewProps {
    /** The URL segment, e.g. `"sign-up"`. Falls back to the sign-in card. */
    view?: string;
}

const AuthView = ({ view }: AuthViewProps = {}): ReactElement => {
    const { plugins, viewPaths } = useAuthUI();

    /*
     * Plugin-gated views are checked here rather than left to the card's own
     * gate. A card that returns null leaves a blank page, which on a *route* is
     * a dead end; falling back to sign-in keeps the user moving. The cards keep
     * their own gate for when they are mounted directly.
     */
    switch (view) {
        case viewPaths.acceptInvitation: {
            return <AcceptInvitationCard />;
        }

        case viewPaths.deviceAuthorization: {
            return plugins.deviceAuthorization ? <DeviceAuthorizationCard /> : <SignInCard />;
        }

        case viewPaths.emailOtp: {
            return plugins.emailOtp ? <EmailOtpCard /> : <SignInCard />;
        }

        case viewPaths.forgotPassword: {
            return <ForgotPasswordCard />;
        }

        case viewPaths.magicLink: {
            return plugins.magicLink ? <MagicLinkCard /> : <SignInCard />;
        }

        case viewPaths.resetPassword: {
            return <ResetPasswordCard />;
        }

        case viewPaths.signUp: {
            return <SignUpCard />;
        }

        case viewPaths.twoFactor: {
            return plugins.twoFactor ? <TwoFactorCard /> : <SignInCard />;
        }

        case viewPaths.verifyEmail: {
            return <VerifyEmailCard />;
        }

        default: {
            return <SignInCard />;
        }
    }
};

export type { AuthViewProps };
export { AuthView, PhoneSignInCard, UsernameSignInCard };
