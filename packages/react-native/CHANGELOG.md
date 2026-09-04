## @lunora/react-native [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.55...@lunora/react-native@1.0.0-alpha.56) (2026-09-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.76
* **@lunora/react:** upgraded to 1.0.0-alpha.82

## @lunora/react-native [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.54...@lunora/react-native@1.0.0-alpha.55) (2026-09-04)


### Dependencies

* **@lunora/react:** upgraded to 1.0.0-alpha.81

## @lunora/react-native [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.53...@lunora/react-native@1.0.0-alpha.54) (2026-09-03)

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
* **@lunora/react:** upgraded to 1.0.0-alpha.79

## @lunora/react-native [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.52...@lunora/react-native@1.0.0-alpha.53) (2026-09-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.73
* **@lunora/react:** upgraded to 1.0.0-alpha.78

## @lunora/react-native [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.51...@lunora/react-native@1.0.0-alpha.52) (2026-09-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.72
* **@lunora/react:** upgraded to 1.0.0-alpha.77

## @lunora/react-native [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.50...@lunora/react-native@1.0.0-alpha.51) (2026-09-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.71
* **@lunora/react:** upgraded to 1.0.0-alpha.76

## @lunora/react-native [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.49...@lunora/react-native@1.0.0-alpha.50) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.70
* **@lunora/react:** upgraded to 1.0.0-alpha.75

## @lunora/react-native [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.48...@lunora/react-native@1.0.0-alpha.49) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.69
* **@lunora/react:** upgraded to 1.0.0-alpha.74

## @lunora/react-native [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.47...@lunora/react-native@1.0.0-alpha.48) (2026-09-01)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.68
* **@lunora/react:** upgraded to 1.0.0-alpha.73

## @lunora/react-native [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.46...@lunora/react-native@1.0.0-alpha.47) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.67
* **@lunora/react:** upgraded to 1.0.0-alpha.72

## @lunora/react-native [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.45...@lunora/react-native@1.0.0-alpha.46) (2026-08-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.66
* **@lunora/react:** upgraded to 1.0.0-alpha.71

## @lunora/react-native [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.44...@lunora/react-native@1.0.0-alpha.45) (2026-08-30)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.65
* **@lunora/react:** upgraded to 1.0.0-alpha.70

## @lunora/react-native [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.43...@lunora/react-native@1.0.0-alpha.44) (2026-08-29)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.64
* **@lunora/react:** upgraded to 1.0.0-alpha.69

## @lunora/react-native [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.42...@lunora/react-native@1.0.0-alpha.43) (2026-08-29)

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
* **@lunora/react:** upgraded to 1.0.0-alpha.68

## @lunora/react-native [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.41...@lunora/react-native@1.0.0-alpha.42) (2026-08-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.62
* **@lunora/react:** upgraded to 1.0.0-alpha.67

## @lunora/react-native [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.40...@lunora/react-native@1.0.0-alpha.41) (2026-08-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.61
* **@lunora/react:** upgraded to 1.0.0-alpha.66

## @lunora/react-native [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.39...@lunora/react-native@1.0.0-alpha.40) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.60
* **@lunora/react:** upgraded to 1.0.0-alpha.65

## @lunora/react-native [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.38...@lunora/react-native@1.0.0-alpha.39) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.59
* **@lunora/react:** upgraded to 1.0.0-alpha.64

## @lunora/react-native [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.37...@lunora/react-native@1.0.0-alpha.38) (2026-08-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.58
* **@lunora/react:** upgraded to 1.0.0-alpha.63

## @lunora/react-native [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.36...@lunora/react-native@1.0.0-alpha.37) (2026-08-24)

### Features

* **auth:** upgrade better-auth to 1.7.1 and gate MCP on its OAuth ([#472](https://github.com/anolilab/lunora/issues/472)) ([7f17a35](https://github.com/anolilab/lunora/commit/7f17a35ba36d85163dd099e464a560b874190049))

## @lunora/react-native [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.35...@lunora/react-native@1.0.0-alpha.36) (2026-08-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.56
* **@lunora/react:** upgraded to 1.0.0-alpha.61

## @lunora/react-native [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.34...@lunora/react-native@1.0.0-alpha.35) (2026-08-23)

### Bug Fixes

* **client:** keep durable caches lossless ([#440](https://github.com/anolilab/lunora/issues/440)) ([ba18c62](https://github.com/anolilab/lunora/commit/ba18c62c0f00333e0ae7384c18c4dcbff2caba20))


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.55
* **@lunora/react:** upgraded to 1.0.0-alpha.60

## @lunora/react-native [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/react-native@1.0.0-alpha.33...@lunora/react-native@1.0.0-alpha.34) (2026-08-22)


### Dependencies

* **@lunora/react:** upgraded to 1.0.0-alpha.59

## @lunora/react-native [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.32...%40lunora%2Freact-native%401.0.0-alpha.33) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.54
* **@lunora/react:** upgraded to 1.0.0-alpha.58

## @lunora/react-native [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.31...%40lunora%2Freact-native%401.0.0-alpha.32) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.53
* **@lunora/react:** upgraded to 1.0.0-alpha.57

## @lunora/react-native [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.30...%40lunora%2Freact-native%401.0.0-alpha.31) (2026-08-18)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.52
* **@lunora/react:** upgraded to 1.0.0-alpha.56

## @lunora/react-native [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.29...%40lunora%2Freact-native%401.0.0-alpha.30) (2026-08-14)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.51
* **@lunora/react:** upgraded to 1.0.0-alpha.55

## @lunora/react-native [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.28...%40lunora%2Freact-native%401.0.0-alpha.29) (2026-08-12)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.50
* **@lunora/react:** upgraded to 1.0.0-alpha.54

## @lunora/react-native [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.27...%40lunora%2Freact-native%401.0.0-alpha.28) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.49
* **@lunora/react:** upgraded to 1.0.0-alpha.53

## @lunora/react-native [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.26...%40lunora%2Freact-native%401.0.0-alpha.27) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.48
* **@lunora/react:** upgraded to 1.0.0-alpha.52

## @lunora/react-native [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.25...%40lunora%2Freact-native%401.0.0-alpha.26) (2026-08-11)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.47
* **@lunora/react:** upgraded to 1.0.0-alpha.51

## @lunora/react-native [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.24...%40lunora%2Freact-native%401.0.0-alpha.25) (2026-08-10)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.46
* **@lunora/react:** upgraded to 1.0.0-alpha.50

## @lunora/react-native [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.23...%40lunora%2Freact-native%401.0.0-alpha.24) (2026-08-09)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.45
* **@lunora/react:** upgraded to 1.0.0-alpha.49

## @lunora/react-native [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.22...%40lunora%2Freact-native%401.0.0-alpha.23) (2026-08-09)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.44
* **@lunora/react:** upgraded to 1.0.0-alpha.48

## @lunora/react-native [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.21...%40lunora%2Freact-native%401.0.0-alpha.22) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.43
* **@lunora/react:** upgraded to 1.0.0-alpha.47

## @lunora/react-native [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.20...%40lunora%2Freact-native%401.0.0-alpha.21) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.42
* **@lunora/react:** upgraded to 1.0.0-alpha.46

## @lunora/react-native [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.19...%40lunora%2Freact-native%401.0.0-alpha.20) (2026-08-07)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.41
* **@lunora/react:** upgraded to 1.0.0-alpha.45

## @lunora/react-native [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.18...%40lunora%2Freact-native%401.0.0-alpha.19) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.40
* **@lunora/react:** upgraded to 1.0.0-alpha.44

## @lunora/react-native [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.17...%40lunora%2Freact-native%401.0.0-alpha.18) (2026-08-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.38
* **@lunora/react:** upgraded to 1.0.0-alpha.42

## @lunora/react-native [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.16...%40lunora%2Freact-native%401.0.0-alpha.17) (2026-08-03)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.37
* **@lunora/react:** upgraded to 1.0.0-alpha.41

## @lunora/react-native [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.15...%40lunora%2Freact-native%401.0.0-alpha.16) (2026-08-02)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.36
* **@lunora/react:** upgraded to 1.0.0-alpha.40

## @lunora/react-native [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.14...%40lunora%2Freact-native%401.0.0-alpha.15) (2026-07-31)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.35
* **@lunora/react:** upgraded to 1.0.0-alpha.39

## @lunora/react-native [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.13...%40lunora%2Freact-native%401.0.0-alpha.14) (2026-07-31)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.34
* **@lunora/react:** upgraded to 1.0.0-alpha.38

## @lunora/react-native [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.12...%40lunora%2Freact-native%401.0.0-alpha.13) (2026-07-28)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.32
* **@lunora/react:** upgraded to 1.0.0-alpha.36

## @lunora/react-native [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.11...%40lunora%2Freact-native%401.0.0-alpha.12) (2026-07-27)

## @lunora/react-native [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.10...%40lunora%2Freact-native%401.0.0-alpha.11) (2026-07-26)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.31
* **@lunora/react:** upgraded to 1.0.0-alpha.35

## @lunora/react-native [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.9...%40lunora%2Freact-native%401.0.0-alpha.10) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.30
* **@lunora/react:** upgraded to 1.0.0-alpha.34

## @lunora/react-native [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.8...%40lunora%2Freact-native%401.0.0-alpha.9) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.29
* **@lunora/react:** upgraded to 1.0.0-alpha.33

## @lunora/react-native [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.7...%40lunora%2Freact-native%401.0.0-alpha.8) (2026-07-25)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.28
* **@lunora/react:** upgraded to 1.0.0-alpha.32

## @lunora/react-native [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.6...%40lunora%2Freact-native%401.0.0-alpha.7) (2026-07-23)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.27
* **@lunora/react:** upgraded to 1.0.0-alpha.31

## @lunora/react-native [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.5...%40lunora%2Freact-native%401.0.0-alpha.6) (2026-07-21)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.26
* **@lunora/react:** upgraded to 1.0.0-alpha.30

## @lunora/react-native [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.4...%40lunora%2Freact-native%401.0.0-alpha.5) (2026-07-20)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.25
* **@lunora/react:** upgraded to 1.0.0-alpha.29

## @lunora/react-native [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.3...%40lunora%2Freact-native%401.0.0-alpha.4) (2026-07-19)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.24
* **@lunora/react:** upgraded to 1.0.0-alpha.28

## @lunora/react-native [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.2...%40lunora%2Freact-native%401.0.0-alpha.3) (2026-07-17)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.23
* **@lunora/react:** upgraded to 1.0.0-alpha.27

## @lunora/react-native [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Freact-native%401.0.0-alpha.1...%40lunora%2Freact-native%401.0.0-alpha.2) (2026-07-13)


### Dependencies

* **@lunora/react:** upgraded to 1.0.0-alpha.25

## @lunora/react-native 1.0.0-alpha.1 (2026-07-12)


### Dependencies

* **@lunora/react:** upgraded to 1.0.0-alpha.24
