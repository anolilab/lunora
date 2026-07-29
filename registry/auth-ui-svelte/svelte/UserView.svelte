<!-- Avatar + name + email, the block that identifies an account in a list or menu. -->
<script lang="ts">
    import { userLabel } from "../core/session";
    import type { AuthUser } from "../core/types";
    import UserAvatar from "./UserAvatar.svelte";

    let {
        compact,
        user,
    }: {
        /** Hide the email line, for tight rows. */
        compact?: boolean;
        user?: AuthUser;
    } = $props();
</script>

<span class="lunora-auth-user">
    <UserAvatar size={compact === true ? 24 : 36} {user} />
    <span class="lunora-auth-user__text">
        <span class="lunora-auth-user__name">{userLabel(user)}</span>
        {#if compact !== true && user?.email !== undefined}
            <span class="lunora-auth-user__email">{user.email}</span>
        {/if}
    </span>
</span>
