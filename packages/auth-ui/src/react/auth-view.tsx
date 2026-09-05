"use client";

import type { ReactElement } from "react";

import { isFlowEnabled } from "../core/flow-gate";
import { createPhoneSignInController } from "../core/phone-number";
import { createUsernameSignInController } from "../core/username";
import { EmailOtpCard, ForgotPasswordCard, MagicLinkCard, ResetPasswordCard, ResetPasswordOtpCard, SignInCard, SignUpCard, TwoFactorCard } from "./auth-cards";
import { FormField } from "./form";
import { onSubmit } from "./on-submit";
import { DeviceAuthorizationCard } from "./plugin-cards";
import { AuthCard, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import { AcceptInvitationCard, VerifyEmailCard } from "./verify-invite-cards";

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
                <FormField actions={actions} autoComplete="username" field="username" label={t.usernameLabel} state={state} />
                <FormField actions={actions} autoComplete="current-password" field="password" label={t.passwordLabel} state={state} type="password" />
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
                <FormField actions={actions} autoComplete="tel" field="phoneNumber" label={t.phoneLabel} state={state} />
                <FormField actions={actions} autoComplete="current-password" field="password" label={t.passwordLabel} state={state} type="password" />
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
 * that owns it.
 *
 * **Tell the provider where you mounted it**: `viewPaths.base` (`"/auth"` for
 * the route above) is what the links between the screens, `redirects.signIn`,
 * `redirects.twoFactor` and the emailed reset link are all derived from. It
 * defaults to `""` — screens on root-level routes — so leaving it unset on a
 * nested mount sends a user with two-factor enabled to a route that isn't there.
 */
interface AuthViewProps {
    /** The URL segment, e.g. `"sign-up"`. Falls back to the sign-in card. */
    view?: string;
}

const AuthView = ({ view }: AuthViewProps = {}): ReactElement => {
    const { forgotPasswordMethod, plugins, signUp, viewPaths } = useAuthUI();

    /*
     * A lookup keyed by the resolved segment, not a `switch` over
     * `viewPaths.*`. Both express the same mapping, but React Compiler cannot
     * reorder member expressions in case labels, so the switch form opted this
     * whole component out of automatic memoization (nine `react-hooks-js/todo`
     * errors, one per case).
     *
     * Plugin-gated views are resolved here rather than left to the card's own
     * gate: a card that returns null leaves a blank page, which on a *route* is
     * a dead end, so those fall back to sign-in. The cards keep their own gate
     * for when they are mounted directly.
     */
    const routes: Record<string, () => ReactElement> = {
        [viewPaths.acceptInvitation]: () => <AcceptInvitationCard />,
        [viewPaths.deviceAuthorization]: () => (plugins.deviceAuthorization ? <DeviceAuthorizationCard /> : <SignInCard />),
        [viewPaths.emailOtp]: () => (plugins.emailOtp ? <EmailOtpCard /> : <SignInCard />),
        [viewPaths.forgotPassword]: () => <ForgotPasswordCard />,
        [viewPaths.magicLink]: () => (plugins.magicLink ? <MagicLinkCard /> : <SignInCard />),
        [viewPaths.resetPassword]: () => (forgotPasswordMethod === "otp" ? <ResetPasswordOtpCard /> : <ResetPasswordCard />),
        [viewPaths.signUp]: () => (signUp ? <SignUpCard /> : <SignInCard />),
        [viewPaths.twoFactor]: () => (plugins.twoFactor ? <TwoFactorCard /> : <SignInCard />),
        [viewPaths.verifyEmail]: () => <VerifyEmailCard />,
    };

    // An unrecognized segment falls back to sign-in rather than rendering
    // nothing, because a typo'd auth URL should still let someone in. The
    // own-key check matters because `view` is URL input: a plain object
    // literal inherits `Object.prototype`, so a segment like "valueOf" or
    // "constructor" would otherwise resolve to an inherited member instead of
    // falling through.
    const render = view !== undefined && Object.hasOwn(routes, view) ? routes[view] : undefined;

    return render === undefined ? <SignInCard /> : render();
};

export type { AuthViewProps };
export { AuthView, PhoneSignInCard, UsernameSignInCard };
