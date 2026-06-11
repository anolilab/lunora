# @cirrus/vue

Vue adapter for Cirrus — live composables, optimistic mutations, reactive loaders

Part of the [Cirrus](https://github.com/anolilab/cirrus) framework.

## Breaking changes (alpha)

The adapter surface was unified across `@cirrus/solid`/`@cirrus/svelte`/`@cirrus/vue`:

- **`useCirrusClient` → `useCirrus`.** The provider accessor was renamed (no alias)
  to match React/Solid. Replace `useCirrusClient()` with `useCirrus()`.
- **`useMutation().withOptimisticUpdate(...)` removed.** Pass a multi-query
  optimistic update per call instead: `mutate(args, { optimisticUpdate })`. The
  handle is now uniformly `{ data, error, pending, mutate, reset }`.
