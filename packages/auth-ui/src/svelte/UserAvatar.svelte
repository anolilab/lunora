<!--
    A user's photo, or their initials when there isn't one.

    The image is the only thing here that can fail at runtime, so a broken URL
    falls back to the initials rather than to a browser's broken-image glyph —
    `user.image` is a plain string column an app can put anything in.
-->
<script lang="ts">
    import { userInitials } from "../core/session";
    import type { AuthUser } from "../core/types";

    let {
        size = 32,
        user,
    }: {
        size?: number;
        user?: AuthUser;
    } = $props();

    /*
     * Which URL failed, rather than a boolean "it failed": a new user means a new
     * image URL, and a previous failure must not stick to it. Comparing the two
     * resets the fallback without an effect, and without painting the initials for
     * a frame first.
     */
    let failedImage = $state<string | undefined>(undefined);

    const image = $derived(user?.image);
    const showImage = $derived(image !== undefined && image !== "" && failedImage !== image);
    const style = $derived(`height:${size}px;width:${size}px`);
</script>

{#if showImage}
    <img
        alt=""
        class="lunora-auth-avatar"
        onerror={() => {
            failedImage = image;
        }}
        src={image}
        {style}
    />
{:else}
    <span aria-hidden="true" class="lunora-auth-avatar lunora-auth-avatar--initials" {style}>{userInitials(user)}</span>
{/if}
