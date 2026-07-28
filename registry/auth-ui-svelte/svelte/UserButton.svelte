<!--
    The avatar menu: who is signed in, plus sign-out and whatever the app hangs
    off it.

    It is a disclosure rather than a `<menu>` because its contents are app-defined
    — links, an organization switcher, a theme row — and forcing those into menu
    item semantics would mislabel them. Escape and outside-click close it, and
    focus returns to the trigger, which is the part hand-rolled dropdowns usually
    miss.
-->
<script module lang="ts">
    // Per-instance ids: two menus on one page must not collide.
    let counter = 0;
</script>

<script lang="ts">
    import type { Snippet } from "svelte";

    import { createSessionController, userLabel } from "../core/session";
    import { signOut } from "../core/session-actions";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import UserAvatar from "./UserAvatar.svelte";
    import UserView from "./UserView.svelte";

    let {
        children,
        hideWhenSignedOut,
    }: {
        /** Extra rows rendered above sign-out (links, an org switcher, …). */
        children?: Snippet;
        /** Render nothing at all when signed out, instead of a sign-in link. */
        hideWhenSignedOut?: boolean;
    } = $props();

    const menuId = `lunora-auth-menu-${(counter += 1)}`;
    const context = useAuthUI();
    const t = context.localization;
    const { actions, state: session } = controllerStore(createSessionController);

    let open = $state(false);
    let root = $state<HTMLDivElement | undefined>(undefined);
    let trigger = $state<HTMLButtonElement | undefined>(undefined);

    const close = (): void => {
        open = false;
        trigger?.focus();
    };

    // Listeners only exist while the menu is open, so a page full of closed
    // disclosures costs nothing.
    $effect(() => {
        if (!open) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                close();
            }
        };

        const onPointerDown = (event: MouseEvent): void => {
            if (root && !root.contains(event.target as Node)) {
                // Not `close()`: a click elsewhere is the user moving on, and
                // yanking focus back to the trigger would fight them for it.
                open = false;
            }
        };

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("mousedown", onPointerDown);
        };
    });
</script>

{#if !$session.settled}
    <!--
        "Not asked yet" and "asked, nobody home" look identical in `user`, and
        rendering a sign-in link during the first request makes every page flash
        one. `settled` is the difference.
    -->
    <span class="lunora-auth-userbutton lunora-auth-userbutton--loading"></span>
{:else if $session.user === undefined}
    {#if hideWhenSignedOut !== true}
        <a class="lunora-auth-link" href={context.redirects.signIn}>{t.signIn}</a>
    {/if}
{:else}
    <div bind:this={root} class="lunora-auth-userbutton">
        <button
            aria-controls={open ? menuId : undefined}
            aria-expanded={open}
            aria-haspopup="true"
            aria-label={userLabel($session.user)}
            bind:this={trigger}
            class="lunora-auth-userbutton__trigger"
            onclick={() => {
                open = !open;
            }}
            type="button"
        >
            <UserAvatar user={$session.user} />
        </button>
        {#if open}
            <div class="lunora-auth-userbutton__menu" id={menuId}>
                <div class="lunora-auth-userbutton__header">
                    <UserView user={$session.user} />
                </div>
                {#if children}{@render children()}{/if}
                <button
                    class="lunora-auth-button lunora-auth-button--secondary"
                    onclick={() => {
                        open = false;
                        void signOut(context).then(actions.refetch);
                    }}
                    type="button"
                >
                    {t.signOut}
                </button>
            </div>
        {/if}
    </div>
{/if}
