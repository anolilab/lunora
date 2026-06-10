<script lang="ts">
    import { CirrusClient } from "@cirrus/client";
    import { setCirrusClient } from "@cirrus/svelte";

    // Publish one CirrusClient on Svelte context for the whole app. The live
    // `query`/`mutation`/`hydratePreloaded` stores resolve it via getContext.
    // `setContext` must run during component init — exactly here, at the root.
    setCirrusClient(new CirrusClient({ url: import.meta.env.VITE_CIRRUS_URL ?? "http://localhost:8787" }));
</script>

<slot />
