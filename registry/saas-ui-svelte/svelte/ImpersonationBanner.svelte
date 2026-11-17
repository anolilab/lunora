<script lang="ts">
    import { untrack } from "svelte";

    import type { AdminUsersClient, ImpersonationSessionLike } from "../core";
    import { createStopImpersonatingController, impersonatedUser } from "../core";
    import { bindController } from "./use-controller.svelte";

    interface Props {
        client: Pick<AdminUsersClient, "stopImpersonating">;
        /** Called once the admin has their own session back. Navigate, as for `AdminUsers`. */
        onSessionChange: () => void;
        /** better-auth's current session — `authClient.useSession()`'s `data`. */
        session: ImpersonationSessionLike | null | undefined;
    }

    const { client, onSessionChange, session }: Props = $props();

    // Mount it on every page, not on the admin screen: the admin's queries refuse
    // the user being impersonated, so that screen is the one place the admin cannot reach.
    const controller = createStopImpersonatingController(
        untrack(() => client),
        {
            onSessionChange: () => {
                onSessionChange();
            },
        },
    );
    const bound = bindController(controller);
    const name = $derived(impersonatedUser(session));
</script>

{#if name !== undefined}
    <div class="lu-saas-banner" role="status">
        <span>You are signed in as <strong>{name}</strong>.</span>
        <button
            class="lu-saas-button lu-saas-button--quiet"
            disabled={bound.state.status === "busy"}
            onclick={() => {
                void controller.stop();
            }}
            type="button">Stop impersonating</button
        >
        {#if bound.state.error}
            <p class="lu-saas-error" role="alert">{bound.state.error}</p>
        {/if}
    </div>
{/if}
