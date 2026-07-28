<script setup lang="ts">
// Teams in the active organization.
//
// Gated on `context.organization.teams` rather than a flow flag: teams are an
// option of the one `organization` plugin, so no plugin id reveals them and the
// server reports them from the resolved table map instead.
import { computed, ref } from "vue";

import { createTeamsController } from "../core/teams";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import Skeleton from "./Skeleton.vue";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => context.value.plugins.organization && context.value.organization.teams);
// Read inside the factory rather than captured: `useController` re-runs it when
// the discovered context lands, and a gated-off card must not fire the resource
// auto-load just to render nothing.
const { actions, state } = useController((context_) => createTeamsController(context_, { autoLoad: enabled.value }));

const name = ref("");

const onCreate = async (): Promise<void> => {
    if (name.value.trim() === "") {
        return;
    }

    await actions.create(name.value);
    name.value = "";
};

// Takes the optional id straight from the row: the template can't narrow,
// so the guard lives here rather than as a cast at the call site.
const onRemove = (id?: string): void => {
    void actions.remove(id ?? "");
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.teams">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" :rows="2" />
        <ul v-else class="lunora-auth-list">
            <li v-for="team in state.items" :key="team.id" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ team.name }}</span>
                <button class="lunora-auth-button lunora-auth-button--danger" type="button" :disabled="state.busy" @click="onRemove(team.id)">
                    {{ t.remove }}
                </button>
            </li>
            <li v-if="state.items.length === 0" class="lunora-auth-list__empty">{{ t.teamsEmpty }}</li>
        </ul>
        <form class="lunora-auth-form" novalidate @submit.prevent="onCreate">
            <Field :field="{ touched: false, value: name }" :label="t.teamNameLabel" name="team" @change="name = $event" />
            <SubmitButton :pending="state.busy">{{ t.saveChanges }}</SubmitButton>
        </form>
    </AuthCard>
</template>
