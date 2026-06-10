<script lang="ts">
    import { hydratePreloaded, mutation } from "@cirrus/svelte";

    import { api } from "../../cirrus/_generated/api";
    import type { PageData } from "./$types";

    export let data: PageData;

    const channelId = "channel:demo" as const;

    // The reactive-loader handoff: the store is seeded SYNCHRONOUSLY from
    // data.preloaded.value (no loading flash, no hydration mismatch), then a
    // live WS subscription attaches on the client and `$messages` re-renders on
    // every server delta — the Svelte equivalent of React's usePreloadedQuery.
    const messages = hydratePreloaded(data.preloaded);

    // Optimistic mutation: `$pending` is a ref-counted store for disabling UI.
    const { mutate, pending } = mutation(api.messages.send);

    let draft = "";

    const send = (event: SubmitEvent) => {
        event.preventDefault();
        void mutate({ channelId, text: draft });
        draft = "";
    };
</script>

<main style="font-family: system-ui; padding: 24px;">
    <h1>{"{{name}}"}</h1>
    <p>SvelteKit + Cirrus — your loader is live.</p>

    <pre>{JSON.stringify($messages, null, 2)}</pre>

    <form on:submit={send}>
        <input bind:value={draft} placeholder="Say something" />
        <button type="submit" disabled={$pending}>Send</button>
    </form>
</main>
