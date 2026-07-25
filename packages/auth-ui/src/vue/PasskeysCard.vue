<script setup lang="ts">
import { ref } from "vue";

import type { AuthPasskey } from "../core";
import { createPasskeysController, isFlowEnabled } from "../core";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "passkey", "PasskeysCard");
const { actions, state } = useController((context_) => createPasskeysController(context_, { autoLoad: enabled }));

const name = ref("");

const passkeyLabel = (passkey: AuthPasskey): string => {
    const label = passkey.name?.trim();

    return label === undefined || label === "" ? t.passkeyUnnamed : label;
};

const onAdd = async (): Promise<void> => {
    await actions.add(name.value);
    name.value = "";
};

const onRemove = (id: string): void => {
    void actions.remove(id);
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.passkeys">
        <FormBanner :error="state.error" />
        <p v-if="state.loading" class="lunora-auth-card__description">…</p>
        <p v-else-if="state.items.length === 0" class="lunora-auth-card__description">{{ t.passkeysEmpty }}</p>
        <ul v-else class="lunora-auth-list">
            <li v-for="passkey in state.items" :key="passkey.id ?? passkeyLabel(passkey)" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ passkeyLabel(passkey) }}</span>
                <button v-if="passkey.id !== undefined" class="lunora-auth-link" type="button" :disabled="state.busy" @click="onRemove(passkey.id as string)">
                    {{ t.remove }}
                </button>
            </li>
        </ul>
        <form class="lunora-auth-form" novalidate @submit.prevent="onAdd">
            <Field :field="{ touched: false, value: name }" :label="t.passkeyName" name="passkeyName" @blur="undefined" @change="name = $event" />
            <SubmitButton :pending="state.busy">{{ t.passkeyAdd }}</SubmitButton>
        </form>
    </AuthCard>
</template>
