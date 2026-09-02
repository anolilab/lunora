## @lunora/testing [1.0.0-alpha.139](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.138...@lunora/testing@1.0.0-alpha.139) (2026-09-01)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.80
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/mail:** upgraded to 1.0.0-alpha.58
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.48
* **@lunora/server:** upgraded to 1.0.0-alpha.98
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.51
* **@lunora/do:** upgraded to 1.0.0-alpha.113
* **@lunora/observability:** upgraded to 1.0.0-alpha.52

## @lunora/testing [1.0.0-alpha.138](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.137...@lunora/testing@1.0.0-alpha.138) (2026-09-01)

### ⚠ BREAKING CHANGES

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests (#541)

### Bug Fixes

* **shard-engine:** close round-3 audit findings across the data path, guards, mirrors and tests ([#541](https://github.com/anolilab/lunora/issues/541)) ([dfc2d4d](https://github.com/anolilab/lunora/commit/dfc2d4d07bf8f67214122dc7f14d83a9b1533d07))


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.79
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.47
* **@lunora/server:** upgraded to 1.0.0-alpha.97
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.50
* **@lunora/do:** upgraded to 1.0.0-alpha.112
* **@lunora/observability:** upgraded to 1.0.0-alpha.51

## @lunora/testing [1.0.0-alpha.137](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.136...@lunora/testing@1.0.0-alpha.137) (2026-09-01)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.78
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/mail:** upgraded to 1.0.0-alpha.57
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.96
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.49
* **@lunora/do:** upgraded to 1.0.0-alpha.111
* **@lunora/observability:** upgraded to 1.0.0-alpha.50

## @lunora/testing [1.0.0-alpha.136](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.135...@lunora/testing@1.0.0-alpha.136) (2026-08-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.77
* **@lunora/mail:** upgraded to 1.0.0-alpha.56
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.95
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.48
* **@lunora/do:** upgraded to 1.0.0-alpha.110
* **@lunora/observability:** upgraded to 1.0.0-alpha.49

## @lunora/testing [1.0.0-alpha.135](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.134...@lunora/testing@1.0.0-alpha.135) (2026-08-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.76
* **@lunora/server:** upgraded to 1.0.0-alpha.94

## @lunora/testing [1.0.0-alpha.134](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.133...@lunora/testing@1.0.0-alpha.134) (2026-08-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.75

## @lunora/testing [1.0.0-alpha.133](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.132...@lunora/testing@1.0.0-alpha.133) (2026-08-29)

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

* **@lunora/agent:** upgraded to 1.0.0-alpha.74
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/mail:** upgraded to 1.0.0-alpha.55
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.44
* **@lunora/server:** upgraded to 1.0.0-alpha.93
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.47
* **@lunora/do:** upgraded to 1.0.0-alpha.109
* **@lunora/observability:** upgraded to 1.0.0-alpha.48

## @lunora/testing [1.0.0-alpha.132](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.131...@lunora/testing@1.0.0-alpha.132) (2026-08-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.73
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/mail:** upgraded to 1.0.0-alpha.54
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.43
* **@lunora/server:** upgraded to 1.0.0-alpha.92
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.46
* **@lunora/do:** upgraded to 1.0.0-alpha.108
* **@lunora/observability:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.131](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.130...@lunora/testing@1.0.0-alpha.131) (2026-08-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.72
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.42
* **@lunora/server:** upgraded to 1.0.0-alpha.91
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.45
* **@lunora/do:** upgraded to 1.0.0-alpha.107
* **@lunora/observability:** upgraded to 1.0.0-alpha.46

## @lunora/testing [1.0.0-alpha.130](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.129...@lunora/testing@1.0.0-alpha.130) (2026-08-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.71
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.41
* **@lunora/server:** upgraded to 1.0.0-alpha.90
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.44
* **@lunora/do:** upgraded to 1.0.0-alpha.106
* **@lunora/observability:** upgraded to 1.0.0-alpha.45

## @lunora/testing [1.0.0-alpha.129](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.128...@lunora/testing@1.0.0-alpha.129) (2026-08-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.70
* **@lunora/server:** upgraded to 1.0.0-alpha.89

## @lunora/testing [1.0.0-alpha.128](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.127...@lunora/testing@1.0.0-alpha.128) (2026-08-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.69
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.88
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.43
* **@lunora/do:** upgraded to 1.0.0-alpha.105
* **@lunora/observability:** upgraded to 1.0.0-alpha.44

## @lunora/testing [1.0.0-alpha.127](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.126...@lunora/testing@1.0.0-alpha.127) (2026-08-27)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.42
* **@lunora/do:** upgraded to 1.0.0-alpha.103
* **@lunora/observability:** upgraded to 1.0.0-alpha.43

## @lunora/testing [1.0.0-alpha.126](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.125...@lunora/testing@1.0.0-alpha.126) (2026-08-26)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.41
* **@lunora/do:** upgraded to 1.0.0-alpha.102
* **@lunora/observability:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.125](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.124...@lunora/testing@1.0.0-alpha.125) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.68
* **@lunora/server:** upgraded to 1.0.0-alpha.87
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.40
* **@lunora/do:** upgraded to 1.0.0-alpha.101
* **@lunora/observability:** upgraded to 1.0.0-alpha.41

## @lunora/testing [1.0.0-alpha.124](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.123...@lunora/testing@1.0.0-alpha.124) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.67
* **@lunora/server:** upgraded to 1.0.0-alpha.86

## @lunora/testing [1.0.0-alpha.123](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.122...@lunora/testing@1.0.0-alpha.123) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.66
* **@lunora/server:** upgraded to 1.0.0-alpha.85

## @lunora/testing [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.121...@lunora/testing@1.0.0-alpha.122) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.65
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/mail:** upgraded to 1.0.0-alpha.53
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.39
* **@lunora/server:** upgraded to 1.0.0-alpha.84
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.39
* **@lunora/do:** upgraded to 1.0.0-alpha.100
* **@lunora/observability:** upgraded to 1.0.0-alpha.40

## @lunora/testing [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.120...@lunora/testing@1.0.0-alpha.121) (2026-08-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.64
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/mail:** upgraded to 1.0.0-alpha.52
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.38
* **@lunora/server:** upgraded to 1.0.0-alpha.83
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.38
* **@lunora/do:** upgraded to 1.0.0-alpha.99
* **@lunora/observability:** upgraded to 1.0.0-alpha.39

## @lunora/testing [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.119...@lunora/testing@1.0.0-alpha.120) (2026-08-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.63
* **@lunora/server:** upgraded to 1.0.0-alpha.82
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.37
* **@lunora/do:** upgraded to 1.0.0-alpha.98
* **@lunora/observability:** upgraded to 1.0.0-alpha.38

## @lunora/testing [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.118...@lunora/testing@1.0.0-alpha.119) (2026-08-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.62
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.81
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.36
* **@lunora/do:** upgraded to 1.0.0-alpha.97
* **@lunora/observability:** upgraded to 1.0.0-alpha.37

## @lunora/testing [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.117...@lunora/testing@1.0.0-alpha.118) (2026-08-25)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.35
* **@lunora/do:** upgraded to 1.0.0-alpha.96
* **@lunora/observability:** upgraded to 1.0.0-alpha.36

## @lunora/testing [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.116...@lunora/testing@1.0.0-alpha.117) (2026-08-24)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.61
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.80
* **@lunora/do:** upgraded to 1.0.0-alpha.95

## @lunora/testing [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.115...@lunora/testing@1.0.0-alpha.116) (2026-08-23)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.60
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.79
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.34
* **@lunora/do:** upgraded to 1.0.0-alpha.93
* **@lunora/observability:** upgraded to 1.0.0-alpha.34

## @lunora/testing [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.114...@lunora/testing@1.0.0-alpha.115) (2026-08-21)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.33
* **@lunora/do:** upgraded to 1.0.0-alpha.92
* **@lunora/observability:** upgraded to 1.0.0-alpha.33

## @lunora/testing [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.113...%40lunora%2Ftesting%401.0.0-alpha.114) (2026-08-19)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.32
* **@lunora/do:** upgraded to 1.0.0-alpha.91
* **@lunora/observability:** upgraded to 1.0.0-alpha.32

## @lunora/testing [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.112...%40lunora%2Ftesting%401.0.0-alpha.113) (2026-08-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.59
* **@lunora/mail:** upgraded to 1.0.0-alpha.51
* **@lunora/scheduler:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.78
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.90
* **@lunora/observability:** upgraded to 1.0.0-alpha.31

## @lunora/testing [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.111...%40lunora%2Ftesting%401.0.0-alpha.112) (2026-08-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.58
* **@lunora/server:** upgraded to 1.0.0-alpha.77
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.30
* **@lunora/do:** upgraded to 1.0.0-alpha.89
* **@lunora/observability:** upgraded to 1.0.0-alpha.30

## @lunora/testing [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.110...%40lunora%2Ftesting%401.0.0-alpha.111) (2026-08-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.57
* **@lunora/server:** upgraded to 1.0.0-alpha.76

## @lunora/testing [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.109...%40lunora%2Ftesting%401.0.0-alpha.110) (2026-08-15)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.56
* **@lunora/server:** upgraded to 1.0.0-alpha.75
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.29
* **@lunora/do:** upgraded to 1.0.0-alpha.88
* **@lunora/observability:** upgraded to 1.0.0-alpha.29

## @lunora/testing [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.108...%40lunora%2Ftesting%401.0.0-alpha.109) (2026-08-14)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.55
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/mail:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.74
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.28
* **@lunora/do:** upgraded to 1.0.0-alpha.86
* **@lunora/observability:** upgraded to 1.0.0-alpha.28

## @lunora/testing [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.107...%40lunora%2Ftesting%401.0.0-alpha.108) (2026-08-12)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.54
* **@lunora/mail:** upgraded to 1.0.0-alpha.49
* **@lunora/server:** upgraded to 1.0.0-alpha.73
* **@lunora/do:** upgraded to 1.0.0-alpha.85
* **@lunora/observability:** upgraded to 1.0.0-alpha.27

## @lunora/testing [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.106...%40lunora%2Ftesting%401.0.0-alpha.107) (2026-08-11)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.53
* **@lunora/server:** upgraded to 1.0.0-alpha.72
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.27
* **@lunora/do:** upgraded to 1.0.0-alpha.84
* **@lunora/observability:** upgraded to 1.0.0-alpha.26

## @lunora/testing [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.105...%40lunora%2Ftesting%401.0.0-alpha.106) (2026-08-11)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.83
* **@lunora/observability:** upgraded to 1.0.0-alpha.25

## @lunora/testing [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.104...%40lunora%2Ftesting%401.0.0-alpha.105) (2026-08-11)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.52
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/mail:** upgraded to 1.0.0-alpha.48
* **@lunora/server:** upgraded to 1.0.0-alpha.71
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.25
* **@lunora/do:** upgraded to 1.0.0-alpha.82
* **@lunora/observability:** upgraded to 1.0.0-alpha.24

## @lunora/testing [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.103...%40lunora%2Ftesting%401.0.0-alpha.104) (2026-08-10)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.51
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.81
* **@lunora/observability:** upgraded to 1.0.0-alpha.23

## @lunora/testing [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.102...%40lunora%2Ftesting%401.0.0-alpha.103) (2026-08-10)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.50
* **@lunora/server:** upgraded to 1.0.0-alpha.70
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.80
* **@lunora/observability:** upgraded to 1.0.0-alpha.22

## @lunora/testing [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.101...%40lunora%2Ftesting%401.0.0-alpha.102) (2026-08-09)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.49
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.68
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.20
* **@lunora/do:** upgraded to 1.0.0-alpha.79
* **@lunora/observability:** upgraded to 1.0.0-alpha.20

## @lunora/testing [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.100...%40lunora%2Ftesting%401.0.0-alpha.101) (2026-08-09)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.19
* **@lunora/do:** upgraded to 1.0.0-alpha.77
* **@lunora/observability:** upgraded to 1.0.0-alpha.18

## @lunora/testing [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.99...%40lunora%2Ftesting%401.0.0-alpha.100) (2026-08-09)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.48
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/mail:** upgraded to 1.0.0-alpha.44
* **@lunora/server:** upgraded to 1.0.0-alpha.67
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.18
* **@lunora/do:** upgraded to 1.0.0-alpha.76
* **@lunora/observability:** upgraded to 1.0.0-alpha.17

## @lunora/testing [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.98...%40lunora%2Ftesting%401.0.0-alpha.99) (2026-08-08)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.17
* **@lunora/do:** upgraded to 1.0.0-alpha.75
* **@lunora/observability:** upgraded to 1.0.0-alpha.16

## @lunora/testing [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.97...%40lunora%2Ftesting%401.0.0-alpha.98) (2026-08-08)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.96...%40lunora%2Ftesting%401.0.0-alpha.97) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.66
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.73
* **@lunora/observability:** upgraded to 1.0.0-alpha.15

## @lunora/testing [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.95...%40lunora%2Ftesting%401.0.0-alpha.96) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.65
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.72
* **@lunora/observability:** upgraded to 1.0.0-alpha.14

## @lunora/testing [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.94...%40lunora%2Ftesting%401.0.0-alpha.95) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/mail:** upgraded to 1.0.0-alpha.43
* **@lunora/server:** upgraded to 1.0.0-alpha.64
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.14
* **@lunora/do:** upgraded to 1.0.0-alpha.71
* **@lunora/observability:** upgraded to 1.0.0-alpha.13

## @lunora/testing [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.93...%40lunora%2Ftesting%401.0.0-alpha.94) (2026-08-07)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.43
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/mail:** upgraded to 1.0.0-alpha.42
* **@lunora/server:** upgraded to 1.0.0-alpha.63
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.13
* **@lunora/do:** upgraded to 1.0.0-alpha.70
* **@lunora/observability:** upgraded to 1.0.0-alpha.12

## @lunora/testing [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.92...%40lunora%2Ftesting%401.0.0-alpha.93) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.91...%40lunora%2Ftesting%401.0.0-alpha.92) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.69
* **@lunora/observability:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.90...%40lunora%2Ftesting%401.0.0-alpha.91) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.41
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/mail:** upgraded to 1.0.0-alpha.41
* **@lunora/server:** upgraded to 1.0.0-alpha.62
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.68
* **@lunora/observability:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.89...%40lunora%2Ftesting%401.0.0-alpha.90) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.61

## @lunora/testing [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.88...%40lunora%2Ftesting%401.0.0-alpha.89) (2026-08-04)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.39
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/mail:** upgraded to 1.0.0-alpha.40
* **@lunora/server:** upgraded to 1.0.0-alpha.60
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.67
* **@lunora/observability:** upgraded to 1.0.0-alpha.9

## @lunora/testing [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.87...%40lunora%2Ftesting%401.0.0-alpha.88) (2026-08-04)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.9
* **@lunora/do:** upgraded to 1.0.0-alpha.66
* **@lunora/observability:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.86...%40lunora%2Ftesting%401.0.0-alpha.87) (2026-08-03)


### Dependencies

* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.8
* **@lunora/do:** upgraded to 1.0.0-alpha.65
* **@lunora/observability:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.85...%40lunora%2Ftesting%401.0.0-alpha.86) (2026-08-03)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.38
* **@lunora/server:** upgraded to 1.0.0-alpha.59

## @lunora/testing [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.84...%40lunora%2Ftesting%401.0.0-alpha.85) (2026-08-02)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.58
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.7
* **@lunora/do:** upgraded to 1.0.0-alpha.64
* **@lunora/observability:** upgraded to 1.0.0-alpha.6

## @lunora/testing [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.83...%40lunora%2Ftesting%401.0.0-alpha.84) (2026-08-02)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.57
* **@lunora/do:** upgraded to 1.0.0-alpha.62
* **@lunora/observability:** upgraded to 1.0.0-alpha.5

## @lunora/testing [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.82...%40lunora%2Ftesting%401.0.0-alpha.83) (2026-07-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.56
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.61
* **@lunora/observability:** upgraded to 1.0.0-alpha.4

## @lunora/testing [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.81...%40lunora%2Ftesting%401.0.0-alpha.82) (2026-07-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/mail:** upgraded to 1.0.0-alpha.37
* **@lunora/server:** upgraded to 1.0.0-alpha.55
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.60
* **@lunora/observability:** upgraded to 1.0.0-alpha.3

## @lunora/testing [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.80...%40lunora%2Ftesting%401.0.0-alpha.81) (2026-07-31)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.54
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.59
* **@lunora/observability:** upgraded to 1.0.0-alpha.2

## @lunora/testing [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.79...%40lunora%2Ftesting%401.0.0-alpha.80) (2026-07-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.53
* **@lunora/shard-engine:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.58
* **@lunora/observability:** upgraded to 1.0.0-alpha.1

## @lunora/testing [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.78...%40lunora%2Ftesting%401.0.0-alpha.79) (2026-07-30)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.31
* **@lunora/do:** upgraded to 1.0.0-alpha.56
* **@lunora/server:** upgraded to 1.0.0-alpha.52

## @lunora/testing [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.77...%40lunora%2Ftesting%401.0.0-alpha.78) (2026-07-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.55

## @lunora/testing [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.76...%40lunora%2Ftesting%401.0.0-alpha.77) (2026-07-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.54

## @lunora/testing [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.75...%40lunora%2Ftesting%401.0.0-alpha.76) (2026-07-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.30
* **@lunora/do:** upgraded to 1.0.0-alpha.53
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/mail:** upgraded to 1.0.0-alpha.36
* **@lunora/server:** upgraded to 1.0.0-alpha.51

## @lunora/testing [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.74...%40lunora%2Ftesting%401.0.0-alpha.75) (2026-07-28)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.29
* **@lunora/mail:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.50

## @lunora/testing [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.73...%40lunora%2Ftesting%401.0.0-alpha.74) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.28
* **@lunora/mail:** upgraded to 1.0.0-alpha.34
* **@lunora/server:** upgraded to 1.0.0-alpha.49

## @lunora/testing [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.72...%40lunora%2Ftesting%401.0.0-alpha.73) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.27
* **@lunora/mail:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.48

## @lunora/testing [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.71...%40lunora%2Ftesting%401.0.0-alpha.72) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.26
* **@lunora/do:** upgraded to 1.0.0-alpha.52
* **@lunora/mail:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.70...%40lunora%2Ftesting%401.0.0-alpha.71) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.25
* **@lunora/mail:** upgraded to 1.0.0-alpha.31
* **@lunora/server:** upgraded to 1.0.0-alpha.46

## @lunora/testing [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.69...%40lunora%2Ftesting%401.0.0-alpha.70) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.24
* **@lunora/do:** upgraded to 1.0.0-alpha.51
* **@lunora/mail:** upgraded to 1.0.0-alpha.30
* **@lunora/server:** upgraded to 1.0.0-alpha.45

## @lunora/testing [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.68...%40lunora%2Ftesting%401.0.0-alpha.69) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.23
* **@lunora/do:** upgraded to 1.0.0-alpha.50
* **@lunora/mail:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.44

## @lunora/testing [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.67...%40lunora%2Ftesting%401.0.0-alpha.68) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.22
* **@lunora/mail:** upgraded to 1.0.0-alpha.28
* **@lunora/server:** upgraded to 1.0.0-alpha.43

## @lunora/testing [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.66...%40lunora%2Ftesting%401.0.0-alpha.67) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.21
* **@lunora/mail:** upgraded to 1.0.0-alpha.27
* **@lunora/server:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.65...%40lunora%2Ftesting%401.0.0-alpha.66) (2026-07-27)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.20
* **@lunora/mail:** upgraded to 1.0.0-alpha.26
* **@lunora/server:** upgraded to 1.0.0-alpha.41

## @lunora/testing [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.64...%40lunora%2Ftesting%401.0.0-alpha.65) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.19
* **@lunora/mail:** upgraded to 1.0.0-alpha.25
* **@lunora/server:** upgraded to 1.0.0-alpha.40

## @lunora/testing [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.63...%40lunora%2Ftesting%401.0.0-alpha.64) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.24
* **@lunora/server:** upgraded to 1.0.0-alpha.39

## @lunora/testing [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.62...%40lunora%2Ftesting%401.0.0-alpha.63) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.17
* **@lunora/mail:** upgraded to 1.0.0-alpha.23
* **@lunora/server:** upgraded to 1.0.0-alpha.38

## @lunora/testing [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.61...%40lunora%2Ftesting%401.0.0-alpha.62) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.16
* **@lunora/do:** upgraded to 1.0.0-alpha.49
* **@lunora/mail:** upgraded to 1.0.0-alpha.22
* **@lunora/server:** upgraded to 1.0.0-alpha.37

## @lunora/testing [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.60...%40lunora%2Ftesting%401.0.0-alpha.61) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.15
* **@lunora/do:** upgraded to 1.0.0-alpha.48
* **@lunora/mail:** upgraded to 1.0.0-alpha.21
* **@lunora/server:** upgraded to 1.0.0-alpha.36

## @lunora/testing [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.59...%40lunora%2Ftesting%401.0.0-alpha.60) (2026-07-26)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.14
* **@lunora/mail:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.35

## @lunora/testing [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.58...%40lunora%2Ftesting%401.0.0-alpha.59) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.13
* **@lunora/mail:** upgraded to 1.0.0-alpha.19
* **@lunora/server:** upgraded to 1.0.0-alpha.34

## @lunora/testing [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.57...%40lunora%2Ftesting%401.0.0-alpha.58) (2026-07-25)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.47

## @lunora/testing [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.56...%40lunora%2Ftesting%401.0.0-alpha.57) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.12
* **@lunora/do:** upgraded to 1.0.0-alpha.46
* **@lunora/server:** upgraded to 1.0.0-alpha.33

## @lunora/testing [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.55...%40lunora%2Ftesting%401.0.0-alpha.56) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.11
* **@lunora/do:** upgraded to 1.0.0-alpha.45
* **@lunora/server:** upgraded to 1.0.0-alpha.32

## @lunora/testing [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.54...%40lunora%2Ftesting%401.0.0-alpha.55) (2026-07-25)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.10
* **@lunora/do:** upgraded to 1.0.0-alpha.44
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/mail:** upgraded to 1.0.0-alpha.18
* **@lunora/server:** upgraded to 1.0.0-alpha.31

## @lunora/testing [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.53...%40lunora%2Ftesting%401.0.0-alpha.54) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.43

## @lunora/testing [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.52...%40lunora%2Ftesting%401.0.0-alpha.53) (2026-07-24)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.42

## @lunora/testing [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.51...%40lunora%2Ftesting%401.0.0-alpha.52) (2026-07-23)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.30

## @lunora/testing [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.50...%40lunora%2Ftesting%401.0.0-alpha.51) (2026-07-22)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.49...%40lunora%2Ftesting%401.0.0-alpha.50) (2026-07-22)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.48...%40lunora%2Ftesting%401.0.0-alpha.49) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.37

## @lunora/testing [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.47...%40lunora%2Ftesting%401.0.0-alpha.48) (2026-07-21)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.36

## @lunora/testing [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.46...%40lunora%2Ftesting%401.0.0-alpha.47) (2026-07-21)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.6
* **@lunora/do:** upgraded to 1.0.0-alpha.35
* **@lunora/server:** upgraded to 1.0.0-alpha.29

## @lunora/testing [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.45...%40lunora%2Ftesting%401.0.0-alpha.46) (2026-07-20)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.5
* **@lunora/do:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/mail:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.28

## @lunora/testing [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.44...%40lunora%2Ftesting%401.0.0-alpha.45) (2026-07-19)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.4
* **@lunora/do:** upgraded to 1.0.0-alpha.33
* **@lunora/server:** upgraded to 1.0.0-alpha.27

## @lunora/testing [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.43...%40lunora%2Ftesting%401.0.0-alpha.44) (2026-07-18)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.3
* **@lunora/do:** upgraded to 1.0.0-alpha.32
* **@lunora/server:** upgraded to 1.0.0-alpha.26

## @lunora/testing [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.42...%40lunora%2Ftesting%401.0.0-alpha.43) (2026-07-17)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.2
* **@lunora/do:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/mail:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.25

## @lunora/testing [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.41...%40lunora%2Ftesting%401.0.0-alpha.42) (2026-07-13)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.30

## @lunora/testing [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.40...%40lunora%2Ftesting%401.0.0-alpha.41) (2026-07-13)


### Dependencies

* **@lunora/agent:** upgraded to 1.0.0-alpha.1
* **@lunora/do:** upgraded to 1.0.0-alpha.29
* **@lunora/server:** upgraded to 1.0.0-alpha.24

## @lunora/testing [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.39...%40lunora%2Ftesting%401.0.0-alpha.40) (2026-07-12)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.28

## @lunora/testing [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.38...%40lunora%2Ftesting%401.0.0-alpha.39) (2026-07-11)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/mail:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.23

## @lunora/testing [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.37...%40lunora%2Ftesting%401.0.0-alpha.38) (2026-07-10)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.22

## @lunora/testing [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.36...%40lunora%2Ftesting%401.0.0-alpha.37) (2026-07-08)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/mail:** upgraded to 1.0.0-alpha.13
* **@lunora/server:** upgraded to 1.0.0-alpha.21

## @lunora/testing [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.35...%40lunora%2Ftesting%401.0.0-alpha.36) (2026-07-08)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.20

## @lunora/testing [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.34...%40lunora%2Ftesting%401.0.0-alpha.35) (2026-07-07)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.18

## @lunora/testing [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.33...%40lunora%2Ftesting%401.0.0-alpha.34) (2026-07-04)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/mail:** upgraded to 1.0.0-alpha.12
* **@lunora/server:** upgraded to 1.0.0-alpha.17

## @lunora/testing [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.32...%40lunora%2Ftesting%401.0.0-alpha.33) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.31...%40lunora%2Ftesting%401.0.0-alpha.32) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.30...%40lunora%2Ftesting%401.0.0-alpha.31) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.9

## @lunora/testing [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.29...%40lunora%2Ftesting%401.0.0-alpha.30) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.28...%40lunora%2Ftesting%401.0.0-alpha.29) (2026-07-04)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.27...%40lunora%2Ftesting%401.0.0-alpha.28) (2026-07-04)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.16

## @lunora/testing [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.26...%40lunora%2Ftesting%401.0.0-alpha.27) (2026-07-03)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.15

## @lunora/testing [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.25...%40lunora%2Ftesting%401.0.0-alpha.26) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.22
* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/mail:** upgraded to 1.0.0-alpha.6
* **@lunora/server:** upgraded to 1.0.0-alpha.14

## @lunora/testing [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.24...%40lunora%2Ftesting%401.0.0-alpha.25) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.21

## @lunora/testing [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.23...%40lunora%2Ftesting%401.0.0-alpha.24) (2026-07-03)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.20
* **@lunora/server:** upgraded to 1.0.0-alpha.13

## @lunora/testing [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.22...%40lunora%2Ftesting%401.0.0-alpha.23) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.19

## @lunora/testing [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.21...%40lunora%2Ftesting%401.0.0-alpha.22) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.18
* **@lunora/mail:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.12

## @lunora/testing [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.20...%40lunora%2Ftesting%401.0.0-alpha.21) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.17

## @lunora/testing [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.19...%40lunora%2Ftesting%401.0.0-alpha.20) (2026-07-02)


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.18...%40lunora%2Ftesting%401.0.0-alpha.19) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.16
* **@lunora/server:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.17...%40lunora%2Ftesting%401.0.0-alpha.18) (2026-07-02)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.15
* **@lunora/server:** upgraded to 1.0.0-alpha.9

## @lunora/testing [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.16...%40lunora%2Ftesting%401.0.0-alpha.17) (2026-07-01)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.14
* **@lunora/server:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.15...%40lunora%2Ftesting%401.0.0-alpha.16) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.13

## @lunora/testing [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.14...%40lunora%2Ftesting%401.0.0-alpha.15) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.12

## @lunora/testing [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.13...%40lunora%2Ftesting%401.0.0-alpha.14) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.11

## @lunora/testing [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.12...%40lunora%2Ftesting%401.0.0-alpha.13) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.10

## @lunora/testing [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.11...%40lunora%2Ftesting%401.0.0-alpha.12) (2026-06-30)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.9
* **@lunora/server:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.10...%40lunora%2Ftesting%401.0.0-alpha.11) (2026-06-29)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.8

## @lunora/testing [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Ftesting%401.0.0-alpha.9...%40lunora%2Ftesting%401.0.0-alpha.10) (2026-06-29)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.4
* **@lunora/server:** upgraded to 1.0.0-alpha.6

## @lunora/testing [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.8...@lunora/testing@1.0.0-alpha.9) (2026-06-28)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.7

## @lunora/testing [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.7...@lunora/testing@1.0.0-alpha.8) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.6
* **@lunora/mail:** upgraded to 1.0.0-alpha.3
* **@lunora/server:** upgraded to 1.0.0-alpha.5

## @lunora/testing [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.6...@lunora/testing@1.0.0-alpha.7) (2026-06-27)


### Dependencies

* **@lunora/mail:** upgraded to 1.0.0-alpha.2
* **@lunora/server:** upgraded to 1.0.0-alpha.4

## @lunora/testing [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.5...@lunora/testing@1.0.0-alpha.6) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Documentation

* document ctx.now across server, testing, and the docs site ([04db307](https://github.com/anolilab/lunora/commit/04db30703beee17a322ff5dd6251f8f954232dcb))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.5
* **@lunora/server:** upgraded to 1.0.0-alpha.3

## @lunora/testing [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.4...@lunora/testing@1.0.0-alpha.5) (2026-06-25)

### Features

* **testing:** expose ctx.now on harness ctx ([1038d55](https://github.com/anolilab/lunora/commit/1038d557a3b007b36657504479098b97003ca68d))


### Dependencies

* **@lunora/server:** upgraded to 1.0.0-alpha.2

## @lunora/testing [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.3...@lunora/testing@1.0.0-alpha.4) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.4

## @lunora/testing [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.2...@lunora/testing@1.0.0-alpha.3) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.3

## @lunora/testing [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/testing@1.0.0-alpha.1...@lunora/testing@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.2

## @lunora/testing 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/do:** upgraded to 1.0.0-alpha.1
* **@lunora/mail:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.1
