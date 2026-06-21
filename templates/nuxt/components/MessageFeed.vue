<script setup lang="ts">
import type { Preloaded, ReturnOf } from "lunorash/client";
import { hydratePreloaded, useMutation } from "@lunora/vue";
import { ref } from "vue";

import { api } from "../lunora/_generated/api";

const channelId = "channel:demo" as const;

const props = defineProps<{
    preloaded: Preloaded<ReturnOf<typeof api.messages.list>>;
}>();

// `hydratePreloaded` seeds the ref SYNCHRONOUSLY from the SSR token — the first
// render shows the server value with no loading flash — then attaches a live WS
// subscription that updates `data` on every server delta.
const data = hydratePreloaded(props.preloaded);

const { mutate, pending } = useMutation(api.messages.send);
const draft = ref("");

const submit = async (): Promise<void> => {
    if (!draft.value) {
        return;
    }

    const text = draft.value;
    draft.value = "";
    await mutate({ channelId, text });
};
</script>

<template>
    <section>
        <pre>{{ JSON.stringify(data, null, 2) }}</pre>
        <form @submit.prevent="submit">
            <input v-model="draft" placeholder="Say something" />
            <button type="submit" :disabled="pending">Send</button>
        </form>
    </section>
</template>
