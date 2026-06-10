<script lang="ts">
    import { CirrusClient } from "@cirrus/client";
    import { setCirrusClient } from "@cirrus/svelte";

    // Publish one CirrusClient on Svelte context for the whole app. The live
    // `query`/`mutation`/`hydratePreloaded` stores resolve it via getContext.
    // `setContext` must run during component init — exactly here, at the root.
    //
    // SAME-ORIGIN: Cirrus realtime is mounted under `/_cirrus/*` in SvelteKit's
    // own worker (see `src/worker.ts`'s `withCirrus`), so the client talks to the
    // page origin — no second worker, no CORS, and the WebSocket resumes the same
    // cookie-based session. `VITE_CIRRUS_URL` overrides only for a split deploy.
    const url = import.meta.env.VITE_CIRRUS_URL ?? (typeof window === "undefined" ? "" : window.location.origin);

    setCirrusClient(new CirrusClient({ url }));
</script>

<slot />
