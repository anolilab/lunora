<script setup lang="ts">
import type { FunctionalComponent } from "vue";
import { shallowRef, useSlots, watch } from "vue";

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

const context = provideAuthUI(props);
const slots = useSlots();

/*
 * The subtree is keyed on the context identity, which changes exactly once — when
 * server discovery answers, and never for an unreachable endpoint.
 *
 * This is what keeps the cards honest. Vue does not re-run a component's
 * `setup()`, so a card that resolved `isFlowEnabled(...)`, or a resource
 * controller that decided its `autoLoad`, before the server replied would be
 * stuck on the pre-discovery verdict for the life of the page: a card the
 * deployment does not support left on screen, or a request fired for a plugin
 * that isn't installed. Re-creating the subtree re-runs every one of those
 * decisions, which is exactly what React gets by re-rendering the consumers of a
 * rebuilt context.
 */
const generation = shallowRef(0);

watch(context, () => {
    generation.value += 1;
});

// A functional wrapper rather than a keyed element: it renders the slot and
// nothing of its own, so keying it costs no DOM and no extra styling surface.
const Subtree: FunctionalComponent = () => slots.default?.() ?? null;
</script>

<template>
    <component :is="Subtree" :key="generation" />
</template>
