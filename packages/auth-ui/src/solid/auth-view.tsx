import type { JSX } from "solid-js";
import { Match, Show, Switch } from "solid-js";

import { isFlowEnabled } from "../core/flow-gate";
import { createPhoneSignInController } from "../core/phone-number";
import { createUsernameSignInController } from "../core/username";
import { EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, ResetPasswordOtpCard, SignInCard, SignUpCard, TwoFactorCard } from "./auth-cards";
import { DeviceAuthorizationCard } from "./plugin-cards";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";
import { AcceptInvitationCard, VerifyEmailCard } from "./verify-invite-cards";

const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

/** Sign in with a username instead of an email. */
const UsernameSignInCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createUsernameSignInController);

    if (!isFlowEnabled(context, "username", "UsernameSignInCard")) {
        return null;
    }

    return (
        <AuthCard title={t.signIn}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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
const PhoneSignInCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createPhoneSignInController);

    if (!isFlowEnabled(context, "phoneNumber", "PhoneSignInCard")) {
        return null;
    }

    return (
        <AuthCard title={t.signIn}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const AuthView = (props: AuthViewProps = {}): JSX.Element => {
    const { forgotPasswordMethod, plugins, viewPaths } = useAuthUI();

    /*
     * Plugin-gated views are checked here rather than left to the card's own
     * gate. A card that returns null leaves a blank page, which on a *route* is
     * a dead end; falling back to sign-in keeps the user moving. The cards keep
     * their own gate for when they are mounted directly.
     *
     * A `<Switch>` rather than a `switch`: the segment is a prop, and a Solid
     * component body runs once, so a plain statement would pin the first view
     * forever.
     */
    return (
        <Switch fallback={<SignInCard />}>
            <Match when={props.view === viewPaths.acceptInvitation}>
                <AcceptInvitationCard />
            </Match>
            <Match when={props.view === viewPaths.deviceAuthorization}>
                <Show fallback={<SignInCard />} when={plugins.deviceAuthorization}>
                    <DeviceAuthorizationCard />
                </Show>
            </Match>
            <Match when={props.view === viewPaths.emailOtp}>
                <Show fallback={<SignInCard />} when={plugins.emailOtp}>
                    <EmailOtpCard />
                </Show>
            </Match>
            <Match when={props.view === viewPaths.forgotPassword}>
                <ForgotPasswordCard />
            </Match>
            <Match when={props.view === viewPaths.magicLink}>
                <Show fallback={<SignInCard />} when={plugins.magicLink}>
                    <MagicLinkCard />
                </Show>
            </Match>
            <Match when={props.view === viewPaths.resetPassword}>
                <Show fallback={<ResetPasswordCard />} when={forgotPasswordMethod === "otp"}>
                    <ResetPasswordOtpCard />
                </Show>
            </Match>
            <Match when={props.view === viewPaths.signUp}>
                <SignUpCard />
            </Match>
            <Match when={props.view === viewPaths.twoFactor}>
                <Show fallback={<SignInCard />} when={plugins.twoFactor}>
                    <TwoFactorCard />
                </Show>
            </Match>
            <Match when={props.view === viewPaths.verifyEmail}>
                <VerifyEmailCard />
            </Match>
        </Switch>
    );
};

export type { AuthViewProps };
export { AuthView, PhoneSignInCard, UsernameSignInCard };
