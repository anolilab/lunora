<!--
    Renders the errors that have no card to land in — a failed social redirect, a
    failed unlink, a sign-out that didn't. Mount it once in your app shell.

    Errors that *do* belong to a card still render on that card's banner and never
    reach here, so nothing is announced twice.
-->
<script lang="ts">
    import type { Toast } from "../core/toast";
    import { dismissToast, getToasts, subscribeToasts } from "../core/toast";

    /*
     * The store is module-level (see `core/toast.ts`), not a controller bound to
     * the provider, so this mirrors it into local state rather than going through
     * `controllerStore`.
     */
    let toasts = $state<ReadonlyArray<Toast>>(getToasts());

    $effect(() => {
        // Re-read synchronously: a toast can be pushed between initialisation and
        // this effect running.
        toasts = getToasts();

        return subscribeToasts(() => {
            toasts = getToasts();
        });
    });
</script>

<!--
    `polite`, not `assertive`: these are failures the user can retry, not
    something that should interrupt a screen reader mid-sentence.
-->
{#if toasts.length > 0}
    <div aria-live="polite" class="lunora-auth-toaster">
        {#each toasts as toast (toast.id)}
            <div class="lunora-auth-toast" role="status">
                <span class="lunora-auth-toast__message">{toast.message}</span>
                <button
                    aria-label="Dismiss"
                    class="lunora-auth-toast__dismiss"
                    onclick={() => {
                        dismissToast(toast.id);
                    }}
                    type="button"
                >
                    ×
                </button>
            </div>
        {/each}
    </div>
{/if}
