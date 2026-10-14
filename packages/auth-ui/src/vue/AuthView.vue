<script setup lang="ts">
// One route for every auth screen: mount this at `/auth/:view` and pass the
// segment, instead of wiring ten routes to ten cards.
//
// The segments are configurable through the provider's `viewPaths`, so the URLs
// stay the app's decision — this only maps whichever segment arrives to the card
// that owns it. An unrecognized segment falls back to sign-in rather than
// rendering nothing, because a typo'd auth URL should still let someone in.
//
// **Tell the provider where you mounted it**: `viewPaths.base` ("/auth" for
// the route above) is what the links between the screens, `redirects.signIn`,
// `redirects.twoFactor` and the emailed reset link are all derived from. It
// defaults to "" — screens on root-level routes — so leaving it unset on a
// nested mount sends a user with two-factor enabled to a route that isn't there.
import type { Component } from "vue";
import { computed } from "vue";

import AcceptInvitationCard from "./AcceptInvitationCard.vue";
import DeviceAuthorizationCard from "./DeviceAuthorizationCard.vue";
import EmailOtpCard from "./EmailOtpCard.vue";
import ForgotPasswordCard from "./ForgotPasswordCard.vue";
import MagicLinkCard from "./MagicLinkCard.vue";
import { useAuthUIContextRef } from "./provider";
import ResetPasswordCard from "./ResetPasswordCard.vue";
import ResetPasswordOtpCard from "./ResetPasswordOtpCard.vue";
import SignInCard from "./SignInCard.vue";
import SignUpCard from "./SignUpCard.vue";
import TwoFactorCard from "./TwoFactorCard.vue";
import VerifyEmailCard from "./VerifyEmailCard.vue";

const props = defineProps<{
    /** The URL segment, e.g. `"sign-up"`. Falls back to the sign-in card. */
    view?: string;
}>();

// The context *ref*, so `card` below re-runs when discovery answers: a route
// that fell back to sign-in because a plugin looked absent has to correct itself
// once the server says otherwise.
const context = useAuthUIContextRef();

/*
 * Plugin-gated views are checked here rather than left to the card's own gate. A
 * card that renders nothing leaves a blank page, which on a *route* is a dead
 * end; falling back to sign-in keeps the user moving. The cards keep their own
 * gate for when they are mounted directly.
 */
const card = computed<Component>(() => {
    const { forgotPasswordMethod, plugins, signUp, viewPaths } = context.value;

    switch (props.view) {
        case viewPaths.acceptInvitation: {
            return AcceptInvitationCard;
        }

        case viewPaths.deviceAuthorization: {
            return plugins.deviceAuthorization ? DeviceAuthorizationCard : SignInCard;
        }

        case viewPaths.emailOtp: {
            return plugins.emailOtp ? EmailOtpCard : SignInCard;
        }

        case viewPaths.forgotPassword: {
            return ForgotPasswordCard;
        }

        case viewPaths.magicLink: {
            return plugins.magicLink ? MagicLinkCard : SignInCard;
        }

        case viewPaths.resetPassword: {
            return forgotPasswordMethod === "otp" ? ResetPasswordOtpCard : ResetPasswordCard;
        }

        case viewPaths.signUp: {
            return signUp ? SignUpCard : SignInCard;
        }

        case viewPaths.twoFactor: {
            return plugins.twoFactor ? TwoFactorCard : SignInCard;
        }

        case viewPaths.verifyEmail: {
            return VerifyEmailCard;
        }

        default: {
            return SignInCard;
        }
    }
});
</script>

<template>
    <component :is="card" />
</template>
