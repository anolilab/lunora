<script module lang="ts">
    // Per-instance ids: two cards on one page must not collide.
    let counter = 0;
</script>

<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { slugify } from "../core/labels";
    import { createOrganizationsController } from "../core/organization-list";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    // eslint-disable-next-line no-useless-assignment -- the increment is the point: a module-level counter handing out one DOM id per instance.
    const uid = `lunora-auth-${(counter += 1)}`;
    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "organization", "OrganizationsCard");
    const { actions, state: res } = controllerStore((context_) => createOrganizationsController(context_, { autoLoad: enabled }));

    let name = $state("");
    let slug = $state("");

    const create = (): void => {
        if (name.trim() === "") {
            return;
        }

        void actions.create(name.trim(), slug.trim() === "" ? slugify(name) : slug.trim());
        name = "";
        slug = "";
    };
</script>

{#if enabled}
    <AuthCard headingLevel={2} title={t.organizations}>
        <FormBanner error={$res.error} />
        {#if $res.loading}
            <p class="lunora-auth-card__description">…</p>
        {:else if $res.items.length === 0}
            <p class="lunora-auth-card__description">{t.noOrganizations}</p>
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.items as organization (organization.id ?? organization.slug ?? organization.name)}
                    {@const id = organization.id}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">{organization.name ?? organization.slug}</span>
                        <span class="lunora-auth-list__actions">
                            {#if id !== undefined}
                                <button
                                    class="lunora-auth-link"
                                    disabled={$res.busy}
                                    onclick={() => {
                                        void actions.setActive(id);
                                    }}
                                    type="button"
                                >
                                    {t.switchOrganization}
                                </button>
                                <button
                                    class="lunora-auth-link"
                                    disabled={$res.busy}
                                    onclick={() => {
                                        void actions.remove(id);
                                    }}
                                    type="button"
                                >
                                    {t.remove}
                                </button>
                            {/if}
                        </span>
                    </li>
                {/each}
            </ul>
        {/if}
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                create();
            }}
        >
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="{uid}-org-name">{t.organizationName}</label>
                <input bind:value={name} class="lunora-auth-field__input" id="{uid}-org-name" />
            </div>
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="{uid}-org-slug">{t.organizationSlug}</label>
                <input bind:value={slug} class="lunora-auth-field__input" id="{uid}-org-slug" placeholder={slugify(name)} />
            </div>
            <SubmitButton pending={$res.busy}>{t.createOrganization}</SubmitButton>
        </form>
    </AuthCard>
{/if}
