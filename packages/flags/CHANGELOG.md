## @lunora/flags [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/flags@1.0.0-alpha.34...@lunora/flags@1.0.0-alpha.35) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24

## @lunora/flags [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/flags@1.0.0-alpha.33...@lunora/flags@1.0.0-alpha.34) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/flags [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/flags@1.0.0-alpha.32...@lunora/flags@1.0.0-alpha.33) (2026-08-24)

### ⚠ BREAKING CHANGES

* **flags:** createFlags(options) is now
createFlags(definition, env, options); callers must pass the
defineFlags(...) result and the Worker env as identity keys.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(flags): bind each definition to its own openfeature domain

Keying the client memo by (definition, env) was not enough on its own:
every binding still went into the single global "lunora" OpenFeature
domain, so a second definition's setProviderAndWait replaced the first's
provider in the registry and the first's cached client silently began
evaluating the second's values. The memo hid the collision rather than
preventing it, and a module-scalar warning apologised for it.

Each (definition, env) pair now owns its OpenFeature domain: the first —
the only case a real app hits, one flags.ts and one env per isolate —
keeps the stable "lunora" name so an external OpenFeature.getClient
("lunora") still reads the app's provider; additional pairs get
"lunora-2", "lunora-3", … The domain is allocated once per pair and
survives a failed bind, so a provider whose initialize throws retries on
the same domain instead of stranding readers on a dead one. The
lastBoundDefinition scalar and its console.warn are gone.

createFlags also stopped taking config it was already handed: hooks,
logger, and the provider factory are read from the definition, and the
options bag shrank to the genuinely per-request extras — the
config.flags override (undefined falls back to the definition) and the
targeting-key thunk. Both codegen emission sites emit the smaller call.
* **flags:** CreateFlagsOptions no longer accepts `hooks` or
`logger` (read from the definition), and `provider` is now an optional
override returning `Provider | undefined` instead of a required factory.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(flags): give a binding-less env a stable memo identity

Generated workers build their env as `this.env ?? {}`, so when `this.env`
is nullish every context build yields a FRESH object. Keyed on that, each
request missed the client cache, allocated another `lunora-N` domain and
ran `setProviderAndWait` again — and OpenFeature's registry holds a
strong reference to every provider by domain name, so the WeakMap being
weak would not release them: unbounded growth on the nullish path.

An env carrying no bindings is indistinguishable to any provider factory,
so they now share one `EMPTY_ENV` key and bind exactly once.

Also record on `DEFAULT_DOMAIN` that which pair wins the unsuffixed
"lunora" name is allocation-order dependent — "first definition wins"
would be equally order-dependent, so the constraint is documented rather
than papered over, with the note that code needing a specific client
should be handed it instead of looking it up by domain.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **flags:** key the flags memo per definition ([#463](https://github.com/anolilab/lunora/issues/463)) ([ad76ea9](https://github.com/anolilab/lunora/commit/ad76ea984a77d52801370e0194d7339c6a241cf5))

## @lunora/flags [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.31...%40lunora%2Fflags%401.0.0-alpha.32) (2026-08-18)

## @lunora/flags [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.30...%40lunora%2Fflags%401.0.0-alpha.31) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22

## @lunora/flags [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.29...%40lunora%2Fflags%401.0.0-alpha.30) (2026-08-12)

## @lunora/flags [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.28...%40lunora%2Fflags%401.0.0-alpha.29) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21

## @lunora/flags [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.27...%40lunora%2Fflags%401.0.0-alpha.28) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/flags [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.26...%40lunora%2Fflags%401.0.0-alpha.27) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19

## @lunora/flags [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.25...%40lunora%2Fflags%401.0.0-alpha.26) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/flags [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.24...%40lunora%2Fflags%401.0.0-alpha.25) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17

## @lunora/flags [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.23...%40lunora%2Fflags%401.0.0-alpha.24) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/flags [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.22...%40lunora%2Fflags%401.0.0-alpha.23) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/flags [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.21...%40lunora%2Fflags%401.0.0-alpha.22) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14

## @lunora/flags [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.20...%40lunora%2Fflags%401.0.0-alpha.21) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13

## @lunora/flags [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.19...%40lunora%2Fflags%401.0.0-alpha.20) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12

## @lunora/flags [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.18...%40lunora%2Fflags%401.0.0-alpha.19) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11

## @lunora/flags [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.17...%40lunora%2Fflags%401.0.0-alpha.18) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/flags [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.16...%40lunora%2Fflags%401.0.0-alpha.17) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/flags [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.15...%40lunora%2Fflags%401.0.0-alpha.16) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/flags [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.14...%40lunora%2Fflags%401.0.0-alpha.15) (2026-07-22)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.7

## @lunora/flags [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.13...%40lunora%2Fflags%401.0.0-alpha.14) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/flags [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.12...%40lunora%2Fflags%401.0.0-alpha.13) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/flags [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.11...%40lunora%2Fflags%401.0.0-alpha.12) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/flags [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.10...%40lunora%2Fflags%401.0.0-alpha.11) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/flags [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.9...%40lunora%2Fflags%401.0.0-alpha.10) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/flags [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.8...%40lunora%2Fflags%401.0.0-alpha.9) (2026-07-04)

## @lunora/flags [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.7...%40lunora%2Fflags%401.0.0-alpha.8) (2026-07-04)

## @lunora/flags [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.6...%40lunora%2Fflags%401.0.0-alpha.7) (2026-07-04)

## @lunora/flags [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.5...%40lunora%2Fflags%401.0.0-alpha.6) (2026-07-04)

## @lunora/flags [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.4...%40lunora%2Fflags%401.0.0-alpha.5) (2026-07-04)

## @lunora/flags [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.3...%40lunora%2Fflags%401.0.0-alpha.4) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/flags [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.2...%40lunora%2Fflags%401.0.0-alpha.3) (2026-07-02)

## @lunora/flags [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fflags%401.0.0-alpha.1...%40lunora%2Fflags%401.0.0-alpha.2) (2026-07-02)

## @lunora/flags 1.0.0-alpha.1 (2026-06-29)
