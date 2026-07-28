<script setup lang="ts">
import type { AuthUIProviderProps } from "./provider";
import { provideAuthUI } from "./provider";

// Provides the resolved auth-UI context to the default slot. One base component
// set serves every meta-framework: pass your router into `nav`/`Link` (Nuxt,
// vue-router, Astro islands) and the cards navigate through it.
/*
 * `discover` is declared with an explicit `undefined` default to opt out of Vue's
 * boolean casting, which turns an *absent* `Boolean`-typed prop into `false`
 * rather than leaving it undefined. Discovery is opt-out (`discover === false`),
 * so without this the feature would be off for everyone who never mentions it.
 */
const props = withDefaults(defineProps<AuthUIProviderProps>(), {
    discover: undefined,
});

/*
 * Nothing here but the provide. The subtree used to be keyed on the context
 * identity and re-created when server discovery answered, because a card's
 * `isFlowEnabled(...)` gate and a controller's `autoLoad` were resolved in a
 * `setup()` Vue never re-runs — a remount was the only way to re-decide them.
 *
 * Both now read *through* the context ref instead (a `computed` gate, and a
 * factory that re-reads it when `useController` rebuilds), so the remount had
 * nothing left to do but throw away every card's DOM and half-typed form on the
 * one tick discovery lands. Two mechanisms for one job, so this is the one that
 * went. It also makes this component and `createAuthUI` exactly equivalent —
 * which is the point, and what the caveat in `provider.ts` used to admit.
 */
provideAuthUI(props);
</script>

<template>
    <slot />
</template>
