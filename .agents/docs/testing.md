# Testing ladder

Read it when you need to know which gate a change has to pass before you push,
or when you are adding a test to stateful code. The gate commands and the
traps behind them are in `AGENTS.md`; this page says which of them a change
needs.

## Layers

Push each failure to the fastest layer that can catch it. A change is done when
every layer its kind of change touches has passed.

| Layer               | Command                                           | Catches                                                                 |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Lint and types      | `pnpm run lint:eslint`, `pnpm run lint:types`     | Code shape, wiring, leaked types                                        |
| Package unit        | `pnpm run test:affected` or one `--filter`        | Logic, contracts, and stateful invariants                               |
| workerd             | `pnpm run test:workerd`                           | Durable Object storage, D1 and SQL dialect, alarms                      |
| Generated output    | `pnpm run api:check`, `dist:check`, `lint:package-json` | Public surface, bundle cleanliness, manifest key order            |
| Templates and SDKs  | `pnpm run test:templates`, `bash sdks/run-all.sh` | Scaffolds that install and build; the eight non-JS SDK conformance suites |
| Cross-process       | `pnpm run test:celld`, `pnpm run e2e`             | Platform and engine behaviour against a live host, the Playwright flows |

## Which layers a change needs

- **Pure logic in one package:** lint and types, then the package's unit tests.
- **Stateful logic** (reservations, rate limits, retries, rollover, scheduling):
  add a property test. See the convention below.
- **SQL, storage, or a Durable Object:** `pnpm run test:workerd`. The local
  unit run uses `node:sqlite`, which accepts SQL that workerd rejects.
- **A public export, config key, or generated file:** `api:check` against a
  fresh build, and the golden fixtures and `_generated/` output it changes.
- **A `package.json`:** `lint:package-json`. No other gate reads key order.
- **A template or the scaffold:** `test:templates`.
- **The public surface of a non-JS SDK:** `bash sdks/run-all.sh`.

## Property tests for stateful code

Use `fast-check` (pinned as `catalog:test`). Generate a history of steps, replay
it through the code exactly as the store would persist it, and assert invariants
at each step. The rate-limit properties in
`packages/ratelimit/__tests__/evaluate.properties.test.ts` are the model.

- **Assert invariants, not outputs.** Limits are never exceeded, state never moves
  backwards, a denied call persists nothing.
- **Assert the promises the code makes to its callers.** A retry-after that does
  not admit the request is a lie the caller will chase forever. Check it by
  retrying at that time.
- **Use `fc.check` and `expect` on its result,** so a failure prints the shrunk
  counterexample.
- **Keep the property deterministic.** Seed it when a failure needs replaying,
  and never read the wall clock inside the property. Time comes from the history.
- **Verify it goes red.** Break the code under test and watch the property fail
  before you trust it. A property that never fails tests nothing.
