<!--
    One route for every auth screen: mount this at `/auth/:view` and pass the
    segment, instead of wiring ten routes to ten cards.

    The segments are configurable through the provider's `viewPaths`, so the URLs
    stay the app's decision — this only maps whichever segment arrives to the card
    that owns it. An unrecognized segment falls back to sign-in rather than
    rendering nothing, because a typo'd auth URL should still let someone in.

    **Tell the provider where you mounted it**: `viewPaths.base` ("/auth" for
    the route above) is what the links between the screens, `redirects.signIn`,
    `redirects.twoFactor` and the emailed reset link are all derived from. It
    defaults to "" — screens on root-level routes — so leaving it unset on a
    nested mount sends a user with two-factor enabled to a route that isn't there.
-->
<script lang="ts">
    import AcceptInvitationCard from "./AcceptInvitationCard.svelte";
    import { useAuthUI } from "./context";
    import DeviceAuthorizationCard from "./DeviceAuthorizationCard.svelte";
    import EmailOtpCard from "./EmailOtpCard.svelte";
    import ForgotPasswordCard from "./ForgotPasswordCard.svelte";
    import MagicLinkCard from "./MagicLinkCard.svelte";
    import ResetPasswordCard from "./ResetPasswordCard.svelte";
    import ResetPasswordOtpCard from "./ResetPasswordOtpCard.svelte";
    import SignInCard from "./SignInCard.svelte";
    import SignUpCard from "./SignUpCard.svelte";
    import TwoFactorCard from "./TwoFactorCard.svelte";
    import VerifyEmailCard from "./VerifyEmailCard.svelte";

    let {
        view,
    }: {
        /** The URL segment, e.g. `"sign-up"`. Falls back to the sign-in card. */
        view?: string;
    } = $props();

    const { forgotPasswordMethod, plugins, signUp, viewPaths } = useAuthUI();
</script>

<!--
    Plugin-gated views are checked here rather than left to the card's own gate. A
    card that renders nothing leaves a blank page, which on a *route* is a dead
    end; falling through to the sign-in card keeps the user moving. The cards keep
    their own gate for when they are mounted directly.
-->
{#if view === viewPaths.acceptInvitation}
    <AcceptInvitationCard />
{:else if view === viewPaths.deviceAuthorization && plugins.deviceAuthorization}
    <DeviceAuthorizationCard />
{:else if view === viewPaths.emailOtp && plugins.emailOtp}
    <EmailOtpCard />
{:else if view === viewPaths.forgotPassword}
    <ForgotPasswordCard />
{:else if view === viewPaths.magicLink && plugins.magicLink}
    <MagicLinkCard />
{:else if view === viewPaths.resetPassword}
    {#if forgotPasswordMethod === "otp"}
        <ResetPasswordOtpCard />
    {:else}
        <ResetPasswordCard />
    {/if}
{:else if view === viewPaths.signUp && signUp}
    <SignUpCard />
{:else if view === viewPaths.twoFactor && plugins.twoFactor}
    <TwoFactorCard />
{:else if view === viewPaths.verifyEmail}
    <VerifyEmailCard />
{:else}
    <SignInCard />
{/if}
