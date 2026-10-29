<script lang="ts">
    import { onMount, untrack } from "svelte";

    import type { AdminUsersClient } from "../core";
    import { adminUsersPage, createAdminUsersController, userActions, userJoined, userLabel, userStatusLabel } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";
    import { bindController } from "./use-controller.svelte";

    interface Props {
        /** better-auth's `authClient.admin` — `createAuthClient({ plugins: [adminClient()] }).admin`. */
        client: AdminUsersClient;
        now: number;
        /** Called once an impersonation starts. Navigate (a full load is safest): the session is someone else's now. */
        onSessionChange: () => void;
        /** The signed-in admin, whose own row offers nothing. */
        viewerId: string;
    }

    const { client, now, onSessionChange, viewerId }: Props = $props();

    // The controller is built once, over the client it was first given, as the React
    // port's is. `onSessionChange` is read inside the closure so a swapped one is honoured.
    const controller = createAdminUsersController(
        untrack(() => client),
        {
            onSessionChange: () => {
                onSessionChange();
            },
        },
    );
    const bound = bindController(controller);

    let term = $state("");
    // One row at a time asks to confirm a suspension: it revokes every session the
    // user has, so a single click beside Impersonate is too easy to land by mistake.
    let confirming = $state<string>();
    let reason = $state("");

    const busy = $derived(bound.state.status === "busy");
    const users = $derived(bound.state.users);
    const page = $derived(adminUsersPage(bound.state));

    const confirmSuspend = async (userId: string): Promise<void> => {
        // A refused suspension keeps the step open, beside its error.
        if (await controller.actions.suspend(userId, reason)) {
            confirming = undefined;
        }
    };

    onMount(() => {
        void controller.actions.load();
    });
</script>

<Card subtitle={users ? `${bound.state.total ?? users.length} users` : undefined} title="Users">
    <form
        class="lu-saas-toolbar"
        onsubmit={(event) => {
            event.preventDefault();
            void controller.actions.search(term);
        }}
    >
        <input aria-label="Search users by email" bind:value={term} class="lu-saas-input" placeholder="Search by email" type="search" />
        <button class="lu-saas-button lu-saas-button--quiet" disabled={busy} type="submit">Search</button>
    </form>

    {#if bound.state.error}
        <p class="lu-saas-error" role="alert">{bound.state.error}</p>
    {/if}

    {#if users === undefined}
        <!-- Only while a read runs: after a failed first load the error stands alone. -->
        {#if busy}
            <div aria-busy="true" class="lu-saas-list lu-saas-list--loading"></div>
        {/if}
    {:else if users.length === 0}
        <Empty title={bound.state.search.trim() === "" ? "No users yet" : "Nobody matches that search"} />
    {:else}
        <table class="lu-saas-table">
            <thead>
                <tr>
                    <th scope="col">User</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Joined</th>
                    <th scope="col"><span class="lu-saas-visually-hidden">Actions</span></th>
                </tr>
            </thead>
            <tbody>
                {#each users as user (user.id)}
                    {@const actions = userActions(user, viewerId, now)}
                    {@const label = userLabel(user)}
                    <tr aria-busy={bound.state.pendingUserId === user.id ? true : undefined}>
                        <td>{label}<code class="lu-saas-row__slug">{user.email}</code></td>
                        <td>{user.role ?? "user"}</td>
                        <td>{userStatusLabel(user, now)}</td>
                        <td>{userJoined(user, now)}</td>
                        <td class="lu-saas-table__actions">
                            {#if actions.impersonate}
                                <button
                                    aria-label={`Impersonate ${label}`}
                                    class="lu-saas-button lu-saas-button--quiet"
                                    disabled={busy}
                                    onclick={() => {
                                        void controller.actions.impersonate(user.id);
                                    }}
                                    type="button">Impersonate</button
                                >
                            {/if}
                            {#if actions.suspend && confirming === user.id}
                                <form
                                    class="lu-saas-confirm"
                                    onsubmit={(event) => {
                                        event.preventDefault();
                                        void confirmSuspend(user.id);
                                    }}
                                >
                                    <input
                                        aria-label={`Reason for suspending ${label}`}
                                        bind:value={reason}
                                        class="lu-saas-input"
                                        placeholder="Reason (optional)"
                                        type="text"
                                    />
                                    <button aria-label={`Confirm suspending ${label}`} class="lu-saas-button" disabled={busy} type="submit">Suspend</button>
                                    <button
                                        class="lu-saas-button lu-saas-button--quiet"
                                        disabled={busy}
                                        onclick={() => {
                                            confirming = undefined;
                                        }}
                                        type="button">Cancel</button
                                    >
                                </form>
                            {:else if actions.suspend}
                                <button
                                    aria-label={`Suspend ${label}`}
                                    class="lu-saas-button lu-saas-button--quiet"
                                    disabled={busy}
                                    onclick={() => {
                                        confirming = user.id;
                                        reason = "";
                                    }}
                                    type="button">Suspend</button
                                >
                            {/if}
                            {#if actions.unsuspend}
                                <button
                                    aria-label={`Unsuspend ${label}`}
                                    class="lu-saas-button lu-saas-button--quiet"
                                    disabled={busy}
                                    onclick={() => {
                                        void controller.actions.unsuspend(user.id);
                                    }}
                                    type="button">Unsuspend</button
                                >
                            {/if}
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>
    {/if}

    {#if page.hasPrevious || page.hasNext}
        <nav aria-label="Users pages" class="lu-saas-toolbar">
            <button
                class="lu-saas-button lu-saas-button--quiet"
                disabled={busy || !page.hasPrevious}
                onclick={() => {
                    void controller.actions.previousPage();
                }}
                type="button">Previous</button
            >
            <span>{page.label}</span>
            <button
                class="lu-saas-button lu-saas-button--quiet"
                disabled={busy || !page.hasNext}
                onclick={() => {
                    void controller.actions.nextPage();
                }}
                type="button">Next</button
            >
        </nav>
    {/if}
</Card>
