<script setup lang="ts">
// `useFetch` runs the `/api/messages` handler on the server during SSR, so the
// `Preloaded` token is resolved server-side and embedded in the page payload.
// On the client it deserializes without a second network call, then
// `<MessageFeed>` hands it to `hydratePreloaded` to seed + go live.
const { data } = await useFetch("/api/messages");
</script>

<template>
    <main style="font-family: system-ui; padding: 24px">
        <h1>{{ "{{name}}" }}</h1>
        <p>Nuxt + Lunora realtime queries — your loader is live.</p>
        <MessageFeed v-if="data" :preloaded="data.preloaded" />
    </main>
</template>
