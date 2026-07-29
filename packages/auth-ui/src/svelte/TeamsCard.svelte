<!--
    Teams in the active organization.

    Gated on `context.organization.teams` rather than a flow flag: teams are an
    option of the one `organization` plugin, so no plugin id reveals them and the
    server reports them from the resolved table map instead.
-->
<script lang="ts">
    import { createTeamsController } from "../core/teams";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import Skeleton from "./Skeleton.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = context.plugins.organization && context.organization.teams;
    const { actions, state: res } = controllerStore((context_) => createTeamsController(context_, { autoLoad: enabled }));

    let name = $state("");
</script>

{#if enabled}
    <AuthCard title={t.teams}>
        <FormBanner error={$res.error} />
        {#if $res.loading}
            <Skeleton rows={2} />
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.items as team (team.id)}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">{team.name}</span>
                        <button
                            class="lunora-auth-button lunora-auth-button--danger"
                            disabled={$res.busy}
                            onclick={() => {
                                void actions.remove(team.id ?? "");
                            }}
                            type="button"
                        >
                            {t.remove}
                        </button>
                    </li>
                {/each}
                {#if $res.items.length === 0}
                    <li class="lunora-auth-list__empty">{t.teamsEmpty}</li>
                {/if}
            </ul>
        {/if}
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();

                if (name.trim() !== "") {
                    void actions.create(name).then(() => {
                        name = "";
                    });
                }
            }}
        >
            <Field
                field={{ touched: false, value: name }}
                label={t.teamNameLabel}
                name="team"
                onBlur={() => {}}
                onChange={(value) => {
                    name = value;
                }}
            />
            <SubmitButton pending={$res.busy}>{t.saveChanges}</SubmitButton>
        </form>
    </AuthCard>
{/if}
