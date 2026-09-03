## @lunora/astro [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.110...@lunora/astro@1.0.0-alpha.111) (2026-09-03)

### ⚠ BREAKING CHANGES

* writes already sitting in a durable outbox carry no identity stamp and are
dropped on the next drain instead of replayed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(db): report the reserved outbox handler's drop instead of swallowing it

The per-collection replay handler wraps its NonRetriableError and reports it on
`onWriteRejected`; the reserved `__lunora_outbox__` handler threw bare. A write
dropped there rolled the optimistic row back with no UI signal — the exact
failure that option was added to prevent, on the one path that already had the
identity guard. Reports the identity drop and a server-coded replay rejection
alike, because reporting only the first would leave the handler with the same
half-guarded shape it is being fixed for.

Also validates `rollout.gracePeriodSeconds` in `defineContainer`, which reached
wrangler's `rollout_active_grace_period` unchecked while its sibling
`stepPercentage` was validated; a fractional or negative value became a
deploy-time failure far from the line that caused it. Only the shape is
asserted — 0 is meaningful and no upper bound is sourced.

And corrects a `collection-options.ts` docblock that stated the inverse of the
code: it justified lazy resolution by an identity switch "retiring" the derived
registry, but a switch rewinds each registry in place precisely so captures stay
valid. The real replacement case is a client teardown.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* docs(container): cite the platform ceiling the readiness budget sits on

`READINESS_TIMEOUT_MS` is 30s, which is exactly Cloudflare's documented timeout
for a `blockConcurrencyWhile` callback — "if this timeout is exceeded, the
Durable Object will be reset" — and `armHardTimeout`'s three storage round-trips
run ahead of it. While that wait sat inside the gate the reset won the race, so
the `LunoraError` naming the failing check, port and budget was unreachable on
the one path it exists for. The same page calls blocking that gate on I/O an
anti-pattern, which a `readyOn` probe is.

Records the source at the constant so the number is not re-derived by assumption
and the wait is not moved back inside the gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(db): hold a replayed write when no identity is established yet

The identity gate compared the stamped identity against `currentIdentity()` with
a bare `!==`. That destroys the queuing user's own offline writes on every
reload: `startOfflineExecutor` replays from its own constructor, before the app
has resolved its session and called `setAuthToken`, so `currentIdentity()` is
still null while the replay runs. A `NonRetriableError` there is terminal — the
executor removes the entry from durable storage — so an offline write made
before a reload was deleted rather than sent.

The property being protected is "never replay as a DIFFERENT user". A null
current identity is no user at all, so there is nobody to impersonate and the
write must be held. The verdict now belongs to the client
(`replayIdentityVerdict`): a mismatch is terminal, an unknown identity throws a
retriable error and the write waits. It also routes through the existing
token-hash check, so a subject that resolves after the token no longer looks
like a different user. Both replay handlers share it, which closes the same bare
comparison in the reserved `__lunora_outbox__` handler.

Also gates request proxying on the `readyOn` probes. The base commits the
healthy state inside its start gate, before the probes run, so `containerFetch`
skipped startup entirely and proxied to a container that never reported ready;
`afterContainerStart` is now single-flight and `containerFetch` awaits it.

Reads the last-login cookie after mount in all six auth-ui ports, so the first
client render matches the server instead of producing markup the server could
not have produced, and gates the email and magic-link badges on
`plugins.lastLoginMethod` the way the social buttons already were. Hardens the
cookie read against a malformed percent-escape, which threw `URIError` during
render.
* `db.actions.*` transactions persist `{ identity, shardKey }`
metadata. A write queued by an older build carries no stamp and is held rather
than replayed under an unverified identity.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(container): clear the readiness gate when a run stops

The single-flight gate added for concurrent starts outlived the run it belonged
to. After `onStop` — including the `onActivityExpired` path, which stops the
container — a restart found the settled promise and returned early, so the new
run skipped both `armHardTimeout` and the `readyOn` probes: the restarted app
was proxied to before it reported ready, and its hard timeout was never re-armed.

Cleared when the run ends rather than at the top of a start, so single-flight
still holds within a run. Resetting per start would let two concurrent starters
each build a gate and each arm a schedule stamped with the same generation,
which is the race the single-flight was added to close.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* close 15 audit findings across the db outbox, container DO and adapters ([#589](https://github.com/anolilab/lunora/issues/589)) ([57080c6](https://github.com/anolilab/lunora/commit/57080c65698170d60403f1ca7731a9009661f1fc))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.74

## @lunora/astro [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.109...@lunora/astro@1.0.0-alpha.110) (2026-09-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.73
* **@lunora/runtime:** upgraded to 1.0.0-alpha.90

## @lunora/astro [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.108...@lunora/astro@1.0.0-alpha.109) (2026-09-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.72
* **@lunora/runtime:** upgraded to 1.0.0-alpha.89

## @lunora/astro [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.107...@lunora/astro@1.0.0-alpha.108) (2026-09-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.71
* **@lunora/runtime:** upgraded to 1.0.0-alpha.88

## @lunora/astro [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.106...@lunora/astro@1.0.0-alpha.107) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.70
* **@lunora/runtime:** upgraded to 1.0.0-alpha.87

## @lunora/astro [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.105...@lunora/astro@1.0.0-alpha.106) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.69
* **@lunora/runtime:** upgraded to 1.0.0-alpha.86

## @lunora/astro [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.104...@lunora/astro@1.0.0-alpha.105) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.68
* **@lunora/runtime:** upgraded to 1.0.0-alpha.85

## @lunora/astro [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.103...@lunora/astro@1.0.0-alpha.104) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.67
* **@lunora/runtime:** upgraded to 1.0.0-alpha.84

## @lunora/astro [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.102...@lunora/astro@1.0.0-alpha.103) (2026-08-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.66
* **@lunora/runtime:** upgraded to 1.0.0-alpha.83

## @lunora/astro [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.101...@lunora/astro@1.0.0-alpha.102) (2026-08-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.65
* **@lunora/runtime:** upgraded to 1.0.0-alpha.82

## @lunora/astro [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.100...@lunora/astro@1.0.0-alpha.101) (2026-08-29)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.64
* **@lunora/runtime:** upgraded to 1.0.0-alpha.81

## @lunora/astro [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.99...@lunora/astro@1.0.0-alpha.100) (2026-08-29)

### ⚠ BREAKING CHANGES

* eleven packages now declare peerDependencies. Consumers that
relied on those packages resolving through hoisting must install them; the
alternative was shipping types that fail to resolve off this repo's node_modules.

`@lunora/workflow` is an optional peer of `@lunora/runtime`, so packem inlines
its types rather than importing them — the published `@lunora/runtime` carries no
`@lunora/workflow` dependency, as its source comments already promised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

* fix: satisfy eslint and the template matrix after the packem gate

Two CI failures from making packem warnings fatal, each a gate that the local
packem sweep does not cover.

`@lunora/advisor` back to a real dependency on `@lunora/errors`. `ae-metrics.ts`
imports `LunoraError` as a VALUE, and import/no-extraneous-dependencies requires
that for anything under `src/` regardless of whether the module reaches the
bundle. packem cannot see it because that module's value exports are
quarantined — `src/index.ts` re-exports only its types — so the throwing code is
tree-shaken out. The two rules disagree by construction; the packem side is now a
commented `unused` exclusion that says which condition would end it.

`@lunora/workflow` becomes a REQUIRED peer of `@lunora/runtime`. As an optional
peer it was auto-installed anyway, and every one of the twelve templates then
resolved `@lunora/workflow` from the npm REGISTRY instead of this checkout — the
scaffold matrix builds its local-tarball map from required peers only, on the
assumption that optional ones are never pulled in. Forcing the type to inline
instead (`resolveExternals.exclude`) does not work: that option governs the JS
bundle, and the declaration build has its own resolver, so the import survived.
A required peer matches the other seven packages here and keeps the type
resolvable for consumers.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AWDgSnuBJaeQHfEitB2zeL

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.63
* **@lunora/runtime:** upgraded to 1.0.0-alpha.80

## @lunora/astro [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.98...@lunora/astro@1.0.0-alpha.99) (2026-08-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.62

## @lunora/astro [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.97...@lunora/astro@1.0.0-alpha.98) (2026-08-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.61
* **@lunora/runtime:** upgraded to 1.0.0-alpha.79

## @lunora/astro [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.96...@lunora/astro@1.0.0-alpha.97) (2026-08-27)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.78

## @lunora/astro [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.95...@lunora/astro@1.0.0-alpha.96) (2026-08-27)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.77

## @lunora/astro [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.94...@lunora/astro@1.0.0-alpha.95) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.60

## @lunora/astro [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.93...@lunora/astro@1.0.0-alpha.94) (2026-08-26)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.76

## @lunora/astro [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.92...@lunora/astro@1.0.0-alpha.93) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.59
* **@lunora/runtime:** upgraded to 1.0.0-alpha.75

## @lunora/astro [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.91...@lunora/astro@1.0.0-alpha.92) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.58
* **@lunora/runtime:** upgraded to 1.0.0-alpha.74

## @lunora/astro [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.90...@lunora/astro@1.0.0-alpha.91) (2026-08-25)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.73

## @lunora/astro [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.89...@lunora/astro@1.0.0-alpha.90) (2026-08-25)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.72

## @lunora/astro [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.88...@lunora/astro@1.0.0-alpha.89) (2026-08-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.57
* **@lunora/runtime:** upgraded to 1.0.0-alpha.71

## @lunora/astro [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.87...@lunora/astro@1.0.0-alpha.88) (2026-08-24)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.70

## @lunora/astro [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.86...@lunora/astro@1.0.0-alpha.87) (2026-08-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.56
* **@lunora/runtime:** upgraded to 1.0.0-alpha.69

## @lunora/astro [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.85...@lunora/astro@1.0.0-alpha.86) (2026-08-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.55

## @lunora/astro [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.84...%40lunora%2Fastro%401.0.0-alpha.85) (2026-08-19)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.68

## @lunora/astro [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.83...%40lunora%2Fastro%401.0.0-alpha.84) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.54

## @lunora/astro [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.82...%40lunora%2Fastro%401.0.0-alpha.83) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.53
* **@lunora/runtime:** upgraded to 1.0.0-alpha.67

## @lunora/astro [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.81...%40lunora%2Fastro%401.0.0-alpha.82) (2026-08-18)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.66

## @lunora/astro [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.80...%40lunora%2Fastro%401.0.0-alpha.81) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.52

## @lunora/astro [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.79...%40lunora%2Fastro%401.0.0-alpha.80) (2026-08-15)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.65

## @lunora/astro [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.78...%40lunora%2Fastro%401.0.0-alpha.79) (2026-08-14)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.64

## @lunora/astro [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.77...%40lunora%2Fastro%401.0.0-alpha.78) (2026-08-14)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.51
* **@lunora/runtime:** upgraded to 1.0.0-alpha.63

## @lunora/astro [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.76...%40lunora%2Fastro%401.0.0-alpha.77) (2026-08-12)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.50

## @lunora/astro [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.75...%40lunora%2Fastro%401.0.0-alpha.76) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.49
* **@lunora/runtime:** upgraded to 1.0.0-alpha.62

## @lunora/astro [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.74...%40lunora%2Fastro%401.0.0-alpha.75) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.48

## @lunora/astro [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.73...%40lunora%2Fastro%401.0.0-alpha.74) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.47
* **@lunora/runtime:** upgraded to 1.0.0-alpha.61

## @lunora/astro [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.72...%40lunora%2Fastro%401.0.0-alpha.73) (2026-08-10)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.46
* **@lunora/runtime:** upgraded to 1.0.0-alpha.60

## @lunora/astro [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.71...%40lunora%2Fastro%401.0.0-alpha.72) (2026-08-09)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.45
* **@lunora/runtime:** upgraded to 1.0.0-alpha.59

## @lunora/astro [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.70...%40lunora%2Fastro%401.0.0-alpha.71) (2026-08-09)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.44
* **@lunora/runtime:** upgraded to 1.0.0-alpha.58

## @lunora/astro [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.69...%40lunora%2Fastro%401.0.0-alpha.70) (2026-08-07)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.57

## @lunora/astro [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.68...%40lunora%2Fastro%401.0.0-alpha.69) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.43
* **@lunora/runtime:** upgraded to 1.0.0-alpha.56

## @lunora/astro [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.67...%40lunora%2Fastro%401.0.0-alpha.68) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.42
* **@lunora/runtime:** upgraded to 1.0.0-alpha.55

## @lunora/astro [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.66...%40lunora%2Fastro%401.0.0-alpha.67) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.41
* **@lunora/runtime:** upgraded to 1.0.0-alpha.54

## @lunora/astro [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.65...%40lunora%2Fastro%401.0.0-alpha.66) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.40
* **@lunora/runtime:** upgraded to 1.0.0-alpha.53

## @lunora/astro [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.64...%40lunora%2Fastro%401.0.0-alpha.65) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.38
* **@lunora/runtime:** upgraded to 1.0.0-alpha.52

## @lunora/astro [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.63...%40lunora%2Fastro%401.0.0-alpha.64) (2026-08-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.37

## @lunora/astro [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.62...%40lunora%2Fastro%401.0.0-alpha.63) (2026-08-02)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.51

## @lunora/astro [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.61...%40lunora%2Fastro%401.0.0-alpha.62) (2026-08-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.36
* **@lunora/runtime:** upgraded to 1.0.0-alpha.50

## @lunora/astro [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.60...%40lunora%2Fastro%401.0.0-alpha.61) (2026-07-31)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.35
* **@lunora/runtime:** upgraded to 1.0.0-alpha.49

## @lunora/astro [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.59...%40lunora%2Fastro%401.0.0-alpha.60) (2026-07-31)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.34
* **@lunora/runtime:** upgraded to 1.0.0-alpha.48

## @lunora/astro [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.58...%40lunora%2Fastro%401.0.0-alpha.59) (2026-07-31)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.47

## @lunora/astro [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.57...%40lunora%2Fastro%401.0.0-alpha.58) (2026-07-29)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.45

## @lunora/astro [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.56...%40lunora%2Fastro%401.0.0-alpha.57) (2026-07-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.32
* **@lunora/runtime:** upgraded to 1.0.0-alpha.44

## @lunora/astro [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.55...%40lunora%2Fastro%401.0.0-alpha.56) (2026-07-28)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.43

## @lunora/astro [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.54...%40lunora%2Fastro%401.0.0-alpha.55) (2026-07-27)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.42

## @lunora/astro [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.53...%40lunora%2Fastro%401.0.0-alpha.54) (2026-07-27)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.41

## @lunora/astro [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.52...%40lunora%2Fastro%401.0.0-alpha.53) (2026-07-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.31
* **@lunora/runtime:** upgraded to 1.0.0-alpha.40

## @lunora/astro [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.51...%40lunora%2Fastro%401.0.0-alpha.52) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.30

## @lunora/astro [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.50...%40lunora%2Fastro%401.0.0-alpha.51) (2026-07-25)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.39

## @lunora/astro [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.49...%40lunora%2Fastro%401.0.0-alpha.50) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.29
* **@lunora/runtime:** upgraded to 1.0.0-alpha.38

## @lunora/astro [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.48...%40lunora%2Fastro%401.0.0-alpha.49) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.28
* **@lunora/runtime:** upgraded to 1.0.0-alpha.37

## @lunora/astro [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.47...%40lunora%2Fastro%401.0.0-alpha.48) (2026-07-24)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.36

## @lunora/astro [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.46...%40lunora%2Fastro%401.0.0-alpha.47) (2026-07-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.27
* **@lunora/runtime:** upgraded to 1.0.0-alpha.35

## @lunora/astro [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.45...%40lunora%2Fastro%401.0.0-alpha.46) (2026-07-22)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.34

## @lunora/astro [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.44...%40lunora%2Fastro%401.0.0-alpha.45) (2026-07-21)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.33

## @lunora/astro [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.43...%40lunora%2Fastro%401.0.0-alpha.44) (2026-07-21)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.26
* **@lunora/runtime:** upgraded to 1.0.0-alpha.32

## @lunora/astro [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.42...%40lunora%2Fastro%401.0.0-alpha.43) (2026-07-21)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.31

## @lunora/astro [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.41...%40lunora%2Fastro%401.0.0-alpha.42) (2026-07-21)

## @lunora/astro [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.40...%40lunora%2Fastro%401.0.0-alpha.41) (2026-07-21)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.30

## @lunora/astro [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.39...%40lunora%2Fastro%401.0.0-alpha.40) (2026-07-20)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.25
* **@lunora/runtime:** upgraded to 1.0.0-alpha.29

## @lunora/astro [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.38...%40lunora%2Fastro%401.0.0-alpha.39) (2026-07-19)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.24

## @lunora/astro [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.37...%40lunora%2Fastro%401.0.0-alpha.38) (2026-07-17)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.23
* **@lunora/runtime:** upgraded to 1.0.0-alpha.28

## @lunora/astro [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.36...%40lunora%2Fastro%401.0.0-alpha.37) (2026-07-13)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.22

## @lunora/astro [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.35...%40lunora%2Fastro%401.0.0-alpha.36) (2026-07-13)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.27

## @lunora/astro [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.34...%40lunora%2Fastro%401.0.0-alpha.35) (2026-07-12)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.26

## @lunora/astro [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.33...%40lunora%2Fastro%401.0.0-alpha.34) (2026-07-11)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.25

## @lunora/astro [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.32...%40lunora%2Fastro%401.0.0-alpha.33) (2026-07-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.21
* **@lunora/runtime:** upgraded to 1.0.0-alpha.24

## @lunora/astro [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.31...%40lunora%2Fastro%401.0.0-alpha.32) (2026-07-10)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.23

## @lunora/astro [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.30...%40lunora%2Fastro%401.0.0-alpha.31) (2026-07-08)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.20
* **@lunora/runtime:** upgraded to 1.0.0-alpha.22

## @lunora/astro [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.29...%40lunora%2Fastro%401.0.0-alpha.30) (2026-07-07)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.21

## @lunora/astro [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.28...%40lunora%2Fastro%401.0.0-alpha.29) (2026-07-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.19
* **@lunora/runtime:** upgraded to 1.0.0-alpha.20

## @lunora/astro [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.27...%40lunora%2Fastro%401.0.0-alpha.28) (2026-07-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.18
* **@lunora/runtime:** upgraded to 1.0.0-alpha.19

## @lunora/astro [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.26...%40lunora%2Fastro%401.0.0-alpha.27) (2026-07-03)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.18

## @lunora/astro [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.25...%40lunora%2Fastro%401.0.0-alpha.26) (2026-07-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.17
* **@lunora/runtime:** upgraded to 1.0.0-alpha.17

## @lunora/astro [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.24...%40lunora%2Fastro%401.0.0-alpha.25) (2026-07-03)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.16

## @lunora/astro [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.23...%40lunora%2Fastro%401.0.0-alpha.24) (2026-07-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.16

## @lunora/astro [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.22...%40lunora%2Fastro%401.0.0-alpha.23) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.15
* **@lunora/runtime:** upgraded to 1.0.0-alpha.15

## @lunora/astro [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.21...%40lunora%2Fastro%401.0.0-alpha.22) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.14
* **@lunora/runtime:** upgraded to 1.0.0-alpha.14

## @lunora/astro [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.20...%40lunora%2Fastro%401.0.0-alpha.21) (2026-07-02)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.13

## @lunora/astro [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.19...%40lunora%2Fastro%401.0.0-alpha.20) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.13
* **@lunora/runtime:** upgraded to 1.0.0-alpha.12

## @lunora/astro [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.18...%40lunora%2Fastro%401.0.0-alpha.19) (2026-07-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.12
* **@lunora/runtime:** upgraded to 1.0.0-alpha.11

## @lunora/astro [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.17...%40lunora%2Fastro%401.0.0-alpha.18) (2026-07-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.11

## @lunora/astro [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.16...%40lunora%2Fastro%401.0.0-alpha.17) (2026-07-01)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.10

## @lunora/astro [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.15...%40lunora%2Fastro%401.0.0-alpha.16) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.10

## @lunora/astro [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.14...%40lunora%2Fastro%401.0.0-alpha.15) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.9

## @lunora/astro [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.13...%40lunora%2Fastro%401.0.0-alpha.14) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.8

## @lunora/astro [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.12...%40lunora%2Fastro%401.0.0-alpha.13) (2026-06-30)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.9

## @lunora/astro [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.11...%40lunora%2Fastro%401.0.0-alpha.12) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.7

## @lunora/astro [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.10...%40lunora%2Fastro%401.0.0-alpha.11) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.6

## @lunora/astro [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.9...%40lunora%2Fastro%401.0.0-alpha.10) (2026-06-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.5
* **@lunora/runtime:** upgraded to 1.0.0-alpha.8

## @lunora/astro [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.8...%40lunora%2Fastro%401.0.0-alpha.9) (2026-06-29)

## @lunora/astro [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.7...%40lunora%2Fastro%401.0.0-alpha.8) (2026-06-29)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.4
* **@lunora/runtime:** upgraded to 1.0.0-alpha.7

## @lunora/astro [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fastro%401.0.0-alpha.6...%40lunora%2Fastro%401.0.0-alpha.7) (2026-06-29)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.6

## @lunora/astro [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.5...@lunora/astro@1.0.0-alpha.6) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.3
* **@lunora/runtime:** upgraded to 1.0.0-alpha.5

## @lunora/astro [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.4...@lunora/astro@1.0.0-alpha.5) (2026-06-27)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.4

## @lunora/astro [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.3...@lunora/astro@1.0.0-alpha.4) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.3

## @lunora/astro [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.2...@lunora/astro@1.0.0-alpha.3) (2026-06-25)


### Dependencies

* **@lunora/runtime:** upgraded to 1.0.0-alpha.2

## @lunora/astro [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.1...@lunora/astro@1.0.0-alpha.2) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))

### Code Refactoring

* remove dead code flagged by fallow ([be57eca](https://github.com/anolilab/lunora/commit/be57ecaf4d6f3bc95d7b1a5876305dfb2af80e45))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.2

## @lunora/astro 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.1
* **@lunora/runtime:** upgraded to 1.0.0-alpha.1
