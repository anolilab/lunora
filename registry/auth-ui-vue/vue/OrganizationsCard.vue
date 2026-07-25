<script setup lang="ts">
import { computed, ref, useId } from "vue";

import { createOrganizationsController, isFlowEnabled, slugify } from "../core";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

// Generated, not hard-coded: two cards on one page must not collide.
const uid = useId();
const context = useAuthUI();
const t = context.localization;
// Resolved before the controller is built: a gated-off card must not fire the
// resource auto-load on mount just to render nothing.
const enabled = isFlowEnabled(context, "organization", "OrganizationsCard");
const { actions, state } = useController((context_) => createOrganizationsController(context_, { autoLoad: enabled }));

const name = ref("");
const slug = ref("");
const slugPlaceholder = computed(() => slugify(name.value));

const create = (): void => {
    if (name.value.trim() === "") {
        return;
    }

    void actions.create(name.value.trim(), slug.value.trim() === "" ? slugify(name.value) : slug.value.trim());
    name.value = "";
    slug.value = "";
};

// Takes the optional id straight from the row: the template can't narrow,
// so the guard lives here rather than as a cast at the call site.
const onSetActive = (id?: string): void => {
    if (id !== undefined) {
        void actions.setActive(id);
    }
};

// Takes the optional id straight from the row: the template can't narrow,
// so the guard lives here rather than as a cast at the call site.
const onRemove = (id?: string): void => {
    if (id !== undefined) {
        void actions.remove(id);
    }
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.organizations">
        <FormBanner :error="state.error" />
        <p v-if="state.loading" class="lunora-auth-card__description">…</p>
        <p v-else-if="state.items.length === 0" class="lunora-auth-card__description">{{ t.noOrganizations }}</p>
        <ul v-else class="lunora-auth-list">
            <li v-for="organization in state.items" :key="organization.id ?? organization.slug ?? organization.name" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ organization.name ?? organization.slug }}</span>
                <span v-if="organization.id !== undefined" class="lunora-auth-list__actions">
                    <button class="lunora-auth-link" type="button" :disabled="state.busy" @click="onSetActive(organization.id)">
                        {{ t.switchOrganization }}
                    </button>
                    <button class="lunora-auth-link" type="button" :disabled="state.busy" @click="onRemove(organization.id)">
                        {{ t.remove }}
                    </button>
                </span>
            </li>
        </ul>
        <form class="lunora-auth-form" novalidate @submit.prevent="create">
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" :for="`${uid}-org-name`">{{ t.organizationName }}</label>
                <input :id="`${uid}-org-name`" v-model="name" class="lunora-auth-field__input" />
            </div>
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" :for="`${uid}-org-slug`">{{ t.organizationSlug }}</label>
                <input :id="`${uid}-org-slug`" v-model="slug" class="lunora-auth-field__input" :placeholder="slugPlaceholder" />
            </div>
            <SubmitButton :pending="state.busy">{{ t.createOrganization }}</SubmitButton>
        </form>
    </AuthCard>
</template>
