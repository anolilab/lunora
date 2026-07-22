<script setup lang="ts">
import { computed, ref } from "vue";

import { createOrganizationsController } from "../core";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const slugify = (value: string): string =>
    // Runs of non-alphanumerics collapse to a single "-", so trimming one edge
    // dash each side is enough (keeps the regex linear — no `+` quantifier).
    value
        .toLowerCase()
        .trim()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-|-$/gu, "");

const { localization: t } = useAuthUI();
const { actions, state } = useController(createOrganizationsController);

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

const onSetActive = (id: string): void => {
    void actions.setActive(id);
};

const onRemove = (id: string): void => {
    void actions.remove(id);
};
</script>

<template>
    <AuthCard :title="t.organizations">
        <FormBanner :error="state.error" />
        <p v-if="state.loading" class="lunora-auth-card__description">…</p>
        <p v-else-if="state.items.length === 0" class="lunora-auth-card__description">{{ t.noOrganizations }}</p>
        <ul v-else class="lunora-auth-list">
            <li v-for="organization in state.items" :key="organization.id ?? organization.slug ?? organization.name" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ organization.name ?? organization.slug }}</span>
                <span v-if="organization.id !== undefined" class="lunora-auth-list__actions">
                    <button class="lunora-auth-link" type="button" :disabled="state.busy" @click="onSetActive(organization.id as string)">
                        {{ t.switchOrganization }}
                    </button>
                    <button class="lunora-auth-link" type="button" :disabled="state.busy" @click="onRemove(organization.id as string)">
                        {{ t.remove }}
                    </button>
                </span>
            </li>
        </ul>
        <form class="lunora-auth-form" novalidate @submit.prevent="create">
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="lunora-org-name">{{ t.organizationName }}</label>
                <input id="lunora-org-name" v-model="name" class="lunora-auth-field__input" />
            </div>
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="lunora-org-slug">{{ t.organizationSlug }}</label>
                <input id="lunora-org-slug" v-model="slug" class="lunora-auth-field__input" :placeholder="slugPlaceholder" />
            </div>
            <SubmitButton :pending="state.busy">{{ t.createOrganization }}</SubmitButton>
        </form>
    </AuthCard>
</template>
