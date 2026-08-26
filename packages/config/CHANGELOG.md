## @lunora/config [1.0.0-alpha.158](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.157...@lunora/config@1.0.0-alpha.158) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.127
* **@lunora/seed:** upgraded to 1.0.0-alpha.85
* **@lunora/studio:** upgraded to 1.0.0-alpha.126

## @lunora/config [1.0.0-alpha.157](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.156...@lunora/config@1.0.0-alpha.157) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.126
* **@lunora/container:** upgraded to 1.0.0-alpha.35
* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/seed:** upgraded to 1.0.0-alpha.84
* **@lunora/studio:** upgraded to 1.0.0-alpha.125

## @lunora/config [1.0.0-alpha.156](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.155...@lunora/config@1.0.0-alpha.156) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.125
* **@lunora/container:** upgraded to 1.0.0-alpha.34
* **@lunora/errors:** upgraded to 1.0.0-alpha.23
* **@lunora/seed:** upgraded to 1.0.0-alpha.83
* **@lunora/studio:** upgraded to 1.0.0-alpha.124

## @lunora/config [1.0.0-alpha.155](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.154...@lunora/config@1.0.0-alpha.155) (2026-08-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.124
* **@lunora/seed:** upgraded to 1.0.0-alpha.82
* **@lunora/studio:** upgraded to 1.0.0-alpha.123

## @lunora/config [1.0.0-alpha.154](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.153...@lunora/config@1.0.0-alpha.154) (2026-08-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.123

## @lunora/config [1.0.0-alpha.153](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.152...@lunora/config@1.0.0-alpha.153) (2026-08-25)

### ⚠ BREAKING CHANGES

* **server:** previously-accepted `contains` on non-string filter
columns is no longer honoured. Consistent with the module's allow-list
mechanism (v.object strips undeclared keys), the key is stripped/dropped
rather than rejected with a validation error — the predicate never
reaches the SQL compiler. Alpha branch, no back-compat shim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): redact camelCase and lowercase secret keys

redactSecrets' keyed-value pass matched any identifier key but tested it
against an uppercase-only suffix regex, so exactly the spellings that
appear in request bodies and thrown errors (password, apiToken,
authSecret) fell through unredacted unless the value happened to hit a
prefix or entropy heuristic.

The suffix regex now matches key/password/secret/token as a real word in
SCREAMING_SNAKE, lower snake/bare, or camelCase form, with a boundary so
MONKEY/monkey/donkey (suffix mid-word) no longer match — the old regex
redacted MONKEY=..., a false positive the boundary removes rather than
extends. Camel-hump keys like sortKey are deliberate over-redaction.

The duplicated regex in @lunora/config's .dev.vars scaffolder (and its
test mirror) is kept byte-identical per the existing cross-reference
comment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* docs(server): pin storageRules getUrl sync contract

getUrl is the only synchronous member of the storageRules guarded
surface; the wrapping loop's untyped (unknown) return would let a future
async/await refactor silently turn ctx.storage.getUrl into a Promise for
guarded procedures only. Document the invariant at the declaration and
pin it with a test asserting the wrapped call returns a plain string,
not a thenable. No behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* perf(server): bound presence reads and self-reap

listPresent collected every row a room had ever accumulated (the TTL is
a read-time filter that hides stale rows but never deletes them) and the
sweep is an internal mutation nothing schedules by default, so an app
that skipped wiring a cron degraded as O(live-set x historical-rows) per
TTL window — on the hottest query in the module, re-run for every
subscriber on every heartbeat.

Two local fixes:
- a (roomId, lastSeen) index and a maxMembers option (default 512):
  listPresent now reads newest-first with a hard cap, so cost scales
  with the cap, not with rows ever written; the in-memory sort is gone
  since index order already delivers newest-first.
- the heartbeat opportunistically reaps up to 8 of its room's oldest
  rows per beat, using a cutoff a full max(grace, ttl) window behind the
  visibility cutoff so a row the read filter could still show — or a
  grace-window reconnect could revive — is never deleted. Active rooms
  self-clean; sweep remains as optional bulk hardening.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): unify the secret-key rule in shared/

Four copies of the "does this key name imply a secret" regex existed —
the runtime redactor, the .dev.vars scaffolder, `lunora deploy`'s
required-secret resolver and `lunora doctor` — kept in step only by a
comment. Two had just been updated for camelCase keys and two had not,
so `apiToken` in a .dev.vars was a secret to the runtime and ordinary
config to the CLI.

They are now one definition in shared/secret-key.ts (zero-dep,
bundler-inlined, so no dependency edge between the app runtime and the
CLI/config layer).

The rule also fixes a regression the boundary-based regex introduced:
requiring `^`/`_`/`-` immediately before the suffix silently stopped
matching no-separator compounds the original caught — OPENAI_APIKEY,
APITOKEN, MYPASSWORD, AUTHSECRET — leaving a short or low-entropy secret
under one of those names unredacted in logs and unminted by the
scaffolder. Matching is now a plain case-insensitive suffix, which also
picks up the Title-case and kebab spellings (Api_Key, Auth-Token) the
previous doc claimed to cover.

MONKEY/monkey/donkey stay excluded by an explicit word list rather than
a boundary rule: MONKEY and APIKEY are structurally identical, so no
positional rule can separate them, and the word list is the only honest
way to keep both properties.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): treat enum columns as string filter columns

Gating `contains` on `validator.kind` alone judged an enum column —
`v.union(v.literal("open"), v.literal("closed"))`, kind "union" — and a
bare `v.literal("x")` as non-string, so the operator was omitted from
the generated validator. Because `v.object` strips an undeclared key and
an emptied predicate is dropped, `?where[status][contains]=ope` against
an enum column silently returned the UNFILTERED set rather than failing
— a silent widening wherever a list filter is doing the scoping.

A union now counts as string-typed when every member is (v.null()
members are transparent, so a nullable string union qualifies); a mixed
union still refuses, since `contains` would otherwise reach non-string
values.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): name the presence cap for sessions, not members

The bounded `listPresent` read caps SESSION ROWS — one per (roomId,
sessionId), so one per open tab — but the option was called maxMembers
and documented as a member cap, and the multi-tab dedup runs after the
read. A 300-person room at two tabs each is 600 rows, so the 512 default
silently truncated ~90 live, currently-heartbeating users out of "who's
here" where the previous unbounded read was complete.

Renamed to `maxSessions`, documented as a session cap to be sized
against expected tabs, and the default raised to 1024. A non-finite
value now falls back to the default instead of reaching the reader as
`LIMIT NaN` (Math.max(1, Math.floor(NaN)) is NaN).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(server): redact any key ending in a secret suffix

The word list excluding ordinary "-key" words (MONKEY, DONKEY, …) is
gone. It never delivered the property it claimed — turnkey, hokey,
lowkey and smokey all end in "key" and were absent, so the list bought
the appearance of precision and none of it, while being unbounded and
unjustifiable to the next reader.

MONKEY and APIKEY are structurally identical, so the only question is
which way to fail. For a redactor over log and error text, over-
redaction is the safe direction: masking a variable named MONKEY costs
one confusing log line, missing APITOKEN costs the credential. The
JSDoc now states that as the deliberate trade, and the tests assert
MONKEY/monkey/sortKey ARE redacted.

The one consumer that writes rather than logs is safe under over-
matching too: the .dev.vars scaffolder mints a value only where the
example held a placeholder, so an over-match fills a placeholder the
user had to fill anyway and never overwrites a real value.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* test(server): suppress the redaction fixture on the secret scanner

`MYPASSWORD=abc` is an input to a redaction assertion, not a credential, but
the scanner reads the assignment shape and fails the Secrets job. Marked with
`gitleaks:allow` the same way the other redaction and column-name fixtures in
this repo are.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016xX4FTtqmhWH97TomT8uww

### Bug Fixes

* **config:** parse .dev.vars like wrangler ([#461](https://github.com/anolilab/lunora/issues/461)) ([258fbb7](https://github.com/anolilab/lunora/commit/258fbb70b3c39aec9d33a5254ef384258acc0cfa))
* **server:** harden validation, presence, filters ([#441](https://github.com/anolilab/lunora/issues/441)) ([ca46d51](https://github.com/anolilab/lunora/commit/ca46d510a3f865df6ed547b4b9521ac625e055a3))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.122
* **@lunora/seed:** upgraded to 1.0.0-alpha.81
* **@lunora/studio:** upgraded to 1.0.0-alpha.122

## @lunora/config [1.0.0-alpha.152](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.151...@lunora/config@1.0.0-alpha.152) (2026-08-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.121
* **@lunora/seed:** upgraded to 1.0.0-alpha.80
* **@lunora/studio:** upgraded to 1.0.0-alpha.120

## @lunora/config [1.0.0-alpha.151](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.150...@lunora/config@1.0.0-alpha.151) (2026-08-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.120
* **@lunora/container:** upgraded to 1.0.0-alpha.33
* **@lunora/seed:** upgraded to 1.0.0-alpha.79

## @lunora/config [1.0.0-alpha.150](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.149...@lunora/config@1.0.0-alpha.150) (2026-08-23)

### Bug Fixes

* **cli:** guard sdk vendoring and imports ([#443](https://github.com/anolilab/lunora/issues/443)) ([981a0fa](https://github.com/anolilab/lunora/commit/981a0fabfd9ffd2d6c1d14604694ea8881f15e78))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.119
* **@lunora/seed:** upgraded to 1.0.0-alpha.78
* **@lunora/studio:** upgraded to 1.0.0-alpha.119

## @lunora/config [1.0.0-alpha.149](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.148...@lunora/config@1.0.0-alpha.149) (2026-08-23)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.118
* **@lunora/studio:** upgraded to 1.0.0-alpha.118

## @lunora/config [1.0.0-alpha.148](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.147...@lunora/config@1.0.0-alpha.148) (2026-08-22)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.117

## @lunora/config [1.0.0-alpha.147](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.146...%40lunora%2Fconfig%401.0.0-alpha.147) (2026-08-19)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.117
* **@lunora/studio:** upgraded to 1.0.0-alpha.116

## @lunora/config [1.0.0-alpha.146](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.145...%40lunora%2Fconfig%401.0.0-alpha.146) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.116
* **@lunora/studio:** upgraded to 1.0.0-alpha.115

## @lunora/config [1.0.0-alpha.145](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.144...%40lunora%2Fconfig%401.0.0-alpha.145) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.115
* **@lunora/seed:** upgraded to 1.0.0-alpha.77
* **@lunora/studio:** upgraded to 1.0.0-alpha.114

## @lunora/config [1.0.0-alpha.144](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.143...%40lunora%2Fconfig%401.0.0-alpha.144) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.114
* **@lunora/container:** upgraded to 1.0.0-alpha.32
* **@lunora/seed:** upgraded to 1.0.0-alpha.76
* **@lunora/studio:** upgraded to 1.0.0-alpha.113

## @lunora/config [1.0.0-alpha.143](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.142...%40lunora%2Fconfig%401.0.0-alpha.143) (2026-08-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.113
* **@lunora/seed:** upgraded to 1.0.0-alpha.75
* **@lunora/studio:** upgraded to 1.0.0-alpha.112

## @lunora/config [1.0.0-alpha.142](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.141...%40lunora%2Fconfig%401.0.0-alpha.142) (2026-08-18)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.111

## @lunora/config [1.0.0-alpha.141](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.140...%40lunora%2Fconfig%401.0.0-alpha.141) (2026-08-15)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.112
* **@lunora/seed:** upgraded to 1.0.0-alpha.74
* **@lunora/studio:** upgraded to 1.0.0-alpha.110

## @lunora/config [1.0.0-alpha.140](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.139...%40lunora%2Fconfig%401.0.0-alpha.140) (2026-08-14)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.111

## @lunora/config [1.0.0-alpha.139](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.138...%40lunora%2Fconfig%401.0.0-alpha.139) (2026-08-14)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.110
* **@lunora/container:** upgraded to 1.0.0-alpha.31
* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/seed:** upgraded to 1.0.0-alpha.73
* **@lunora/studio:** upgraded to 1.0.0-alpha.109

## @lunora/config [1.0.0-alpha.138](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.137...%40lunora%2Fconfig%401.0.0-alpha.138) (2026-08-12)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.109
* **@lunora/seed:** upgraded to 1.0.0-alpha.72
* **@lunora/studio:** upgraded to 1.0.0-alpha.108

## @lunora/config [1.0.0-alpha.137](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.136...%40lunora%2Fconfig%401.0.0-alpha.137) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.108
* **@lunora/seed:** upgraded to 1.0.0-alpha.71
* **@lunora/studio:** upgraded to 1.0.0-alpha.107

## @lunora/config [1.0.0-alpha.136](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.135...%40lunora%2Fconfig%401.0.0-alpha.136) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.107
* **@lunora/studio:** upgraded to 1.0.0-alpha.106

## @lunora/config [1.0.0-alpha.135](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.134...%40lunora%2Fconfig%401.0.0-alpha.135) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.106
* **@lunora/container:** upgraded to 1.0.0-alpha.30
* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/seed:** upgraded to 1.0.0-alpha.70
* **@lunora/studio:** upgraded to 1.0.0-alpha.105

## @lunora/config [1.0.0-alpha.134](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.133...%40lunora%2Fconfig%401.0.0-alpha.134) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.105

## @lunora/config [1.0.0-alpha.133](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.132...%40lunora%2Fconfig%401.0.0-alpha.133) (2026-08-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.104

## @lunora/config [1.0.0-alpha.132](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.131...%40lunora%2Fconfig%401.0.0-alpha.132) (2026-08-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.103
* **@lunora/studio:** upgraded to 1.0.0-alpha.104

## @lunora/config [1.0.0-alpha.131](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.130...%40lunora%2Fconfig%401.0.0-alpha.131) (2026-08-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.102
* **@lunora/seed:** upgraded to 1.0.0-alpha.69
* **@lunora/studio:** upgraded to 1.0.0-alpha.103

## @lunora/config [1.0.0-alpha.130](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.129...%40lunora%2Fconfig%401.0.0-alpha.130) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.101
* **@lunora/container:** upgraded to 1.0.0-alpha.27
* **@lunora/errors:** upgraded to 1.0.0-alpha.18
* **@lunora/seed:** upgraded to 1.0.0-alpha.68
* **@lunora/studio:** upgraded to 1.0.0-alpha.102

## @lunora/config [1.0.0-alpha.129](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.128...%40lunora%2Fconfig%401.0.0-alpha.129) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.100
* **@lunora/studio:** upgraded to 1.0.0-alpha.101

## @lunora/config [1.0.0-alpha.128](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.127...%40lunora%2Fconfig%401.0.0-alpha.128) (2026-08-09)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.99
* **@lunora/container:** upgraded to 1.0.0-alpha.26
* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/seed:** upgraded to 1.0.0-alpha.67
* **@lunora/studio:** upgraded to 1.0.0-alpha.100

## @lunora/config [1.0.0-alpha.127](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.126...%40lunora%2Fconfig%401.0.0-alpha.127) (2026-08-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.98

## @lunora/config [1.0.0-alpha.126](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.125...%40lunora%2Fconfig%401.0.0-alpha.126) (2026-08-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.97

## @lunora/config [1.0.0-alpha.125](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.124...%40lunora%2Fconfig%401.0.0-alpha.125) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.96
* **@lunora/seed:** upgraded to 1.0.0-alpha.66
* **@lunora/studio:** upgraded to 1.0.0-alpha.99

## @lunora/config [1.0.0-alpha.124](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.123...%40lunora%2Fconfig%401.0.0-alpha.124) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.95
* **@lunora/seed:** upgraded to 1.0.0-alpha.65
* **@lunora/studio:** upgraded to 1.0.0-alpha.98

## @lunora/config [1.0.0-alpha.123](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.122...%40lunora%2Fconfig%401.0.0-alpha.123) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.94
* **@lunora/container:** upgraded to 1.0.0-alpha.25
* **@lunora/errors:** upgraded to 1.0.0-alpha.16
* **@lunora/seed:** upgraded to 1.0.0-alpha.64
* **@lunora/studio:** upgraded to 1.0.0-alpha.97

## @lunora/config [1.0.0-alpha.122](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.121...%40lunora%2Fconfig%401.0.0-alpha.122) (2026-08-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.93
* **@lunora/container:** upgraded to 1.0.0-alpha.24
* **@lunora/errors:** upgraded to 1.0.0-alpha.15
* **@lunora/seed:** upgraded to 1.0.0-alpha.63
* **@lunora/studio:** upgraded to 1.0.0-alpha.96

## @lunora/config [1.0.0-alpha.121](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.120...%40lunora%2Fconfig%401.0.0-alpha.121) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.92

## @lunora/config [1.0.0-alpha.120](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.119...%40lunora%2Fconfig%401.0.0-alpha.120) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.91

## @lunora/config [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.118...%40lunora%2Fconfig%401.0.0-alpha.119) (2026-08-04)

## @lunora/config [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.117...%40lunora%2Fconfig%401.0.0-alpha.118) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.90
* **@lunora/container:** upgraded to 1.0.0-alpha.23
* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/seed:** upgraded to 1.0.0-alpha.62
* **@lunora/studio:** upgraded to 1.0.0-alpha.95

## @lunora/config [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.116...%40lunora%2Fconfig%401.0.0-alpha.117) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.89
* **@lunora/seed:** upgraded to 1.0.0-alpha.61
* **@lunora/studio:** upgraded to 1.0.0-alpha.94

## @lunora/config [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.115...%40lunora%2Fconfig%401.0.0-alpha.116) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.88
* **@lunora/container:** upgraded to 1.0.0-alpha.22
* **@lunora/studio:** upgraded to 1.0.0-alpha.93

## @lunora/config [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.114...%40lunora%2Fconfig%401.0.0-alpha.115) (2026-08-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.87
* **@lunora/container:** upgraded to 1.0.0-alpha.21
* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/seed:** upgraded to 1.0.0-alpha.60
* **@lunora/studio:** upgraded to 1.0.0-alpha.92

## @lunora/config [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.113...%40lunora%2Fconfig%401.0.0-alpha.114) (2026-08-04)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.91

## @lunora/config [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.112...%40lunora%2Fconfig%401.0.0-alpha.113) (2026-08-03)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.90

## @lunora/config [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.111...%40lunora%2Fconfig%401.0.0-alpha.112) (2026-08-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.86
* **@lunora/seed:** upgraded to 1.0.0-alpha.59
* **@lunora/studio:** upgraded to 1.0.0-alpha.89

## @lunora/config [1.0.0-alpha.111](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.110...%40lunora%2Fconfig%401.0.0-alpha.111) (2026-08-03)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.88

## @lunora/config [1.0.0-alpha.110](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.109...%40lunora%2Fconfig%401.0.0-alpha.110) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.85
* **@lunora/seed:** upgraded to 1.0.0-alpha.58
* **@lunora/studio:** upgraded to 1.0.0-alpha.87

## @lunora/config [1.0.0-alpha.109](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.108...%40lunora%2Fconfig%401.0.0-alpha.109) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.84

## @lunora/config [1.0.0-alpha.108](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.107...%40lunora%2Fconfig%401.0.0-alpha.108) (2026-08-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.83
* **@lunora/seed:** upgraded to 1.0.0-alpha.57
* **@lunora/studio:** upgraded to 1.0.0-alpha.86

## @lunora/config [1.0.0-alpha.107](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.106...%40lunora%2Fconfig%401.0.0-alpha.107) (2026-07-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.82
* **@lunora/seed:** upgraded to 1.0.0-alpha.56
* **@lunora/studio:** upgraded to 1.0.0-alpha.85

## @lunora/config [1.0.0-alpha.106](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.105...%40lunora%2Fconfig%401.0.0-alpha.106) (2026-07-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.81
* **@lunora/container:** upgraded to 1.0.0-alpha.18
* **@lunora/errors:** upgraded to 1.0.0-alpha.10
* **@lunora/seed:** upgraded to 1.0.0-alpha.55
* **@lunora/studio:** upgraded to 1.0.0-alpha.84

## @lunora/config [1.0.0-alpha.105](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.104...%40lunora%2Fconfig%401.0.0-alpha.105) (2026-07-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.80
* **@lunora/seed:** upgraded to 1.0.0-alpha.54
* **@lunora/studio:** upgraded to 1.0.0-alpha.83

## @lunora/config [1.0.0-alpha.104](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.103...%40lunora%2Fconfig%401.0.0-alpha.104) (2026-07-30)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.82

## @lunora/config [1.0.0-alpha.103](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.102...%40lunora%2Fconfig%401.0.0-alpha.103) (2026-07-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.77
* **@lunora/seed:** upgraded to 1.0.0-alpha.52
* **@lunora/studio:** upgraded to 1.0.0-alpha.81

## @lunora/config [1.0.0-alpha.102](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.101...%40lunora%2Fconfig%401.0.0-alpha.102) (2026-07-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.76
* **@lunora/seed:** upgraded to 1.0.0-alpha.51
* **@lunora/studio:** upgraded to 1.0.0-alpha.80

## @lunora/config [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.100...%40lunora%2Fconfig%401.0.0-alpha.101) (2026-07-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.75
* **@lunora/container:** upgraded to 1.0.0-alpha.17
* **@lunora/errors:** upgraded to 1.0.0-alpha.9
* **@lunora/seed:** upgraded to 1.0.0-alpha.50
* **@lunora/studio:** upgraded to 1.0.0-alpha.79

## @lunora/config [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.99...%40lunora%2Fconfig%401.0.0-alpha.100) (2026-07-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.74
* **@lunora/seed:** upgraded to 1.0.0-alpha.49
* **@lunora/studio:** upgraded to 1.0.0-alpha.78

## @lunora/config [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.98...%40lunora%2Fconfig%401.0.0-alpha.99) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.73
* **@lunora/seed:** upgraded to 1.0.0-alpha.48
* **@lunora/studio:** upgraded to 1.0.0-alpha.77

## @lunora/config [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.97...%40lunora%2Fconfig%401.0.0-alpha.98) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.72
* **@lunora/seed:** upgraded to 1.0.0-alpha.47
* **@lunora/studio:** upgraded to 1.0.0-alpha.76

## @lunora/config [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.96...%40lunora%2Fconfig%401.0.0-alpha.97) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.71
* **@lunora/seed:** upgraded to 1.0.0-alpha.46
* **@lunora/studio:** upgraded to 1.0.0-alpha.75

## @lunora/config [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.95...%40lunora%2Fconfig%401.0.0-alpha.96) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.70
* **@lunora/seed:** upgraded to 1.0.0-alpha.45
* **@lunora/studio:** upgraded to 1.0.0-alpha.74

## @lunora/config [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.94...%40lunora%2Fconfig%401.0.0-alpha.95) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.69
* **@lunora/seed:** upgraded to 1.0.0-alpha.44
* **@lunora/studio:** upgraded to 1.0.0-alpha.73

## @lunora/config [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.93...%40lunora%2Fconfig%401.0.0-alpha.94) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.68
* **@lunora/seed:** upgraded to 1.0.0-alpha.43
* **@lunora/studio:** upgraded to 1.0.0-alpha.72

## @lunora/config [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.92...%40lunora%2Fconfig%401.0.0-alpha.93) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.67
* **@lunora/seed:** upgraded to 1.0.0-alpha.42
* **@lunora/studio:** upgraded to 1.0.0-alpha.71

## @lunora/config [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.91...%40lunora%2Fconfig%401.0.0-alpha.92) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.66
* **@lunora/seed:** upgraded to 1.0.0-alpha.41
* **@lunora/studio:** upgraded to 1.0.0-alpha.70

## @lunora/config [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.90...%40lunora%2Fconfig%401.0.0-alpha.91) (2026-07-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.65
* **@lunora/seed:** upgraded to 1.0.0-alpha.40
* **@lunora/studio:** upgraded to 1.0.0-alpha.69

## @lunora/config [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.89...%40lunora%2Fconfig%401.0.0-alpha.90) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.64
* **@lunora/seed:** upgraded to 1.0.0-alpha.39
* **@lunora/studio:** upgraded to 1.0.0-alpha.68

## @lunora/config [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.88...%40lunora%2Fconfig%401.0.0-alpha.89) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.63
* **@lunora/seed:** upgraded to 1.0.0-alpha.38
* **@lunora/studio:** upgraded to 1.0.0-alpha.67

## @lunora/config [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.87...%40lunora%2Fconfig%401.0.0-alpha.88) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.62
* **@lunora/seed:** upgraded to 1.0.0-alpha.37
* **@lunora/studio:** upgraded to 1.0.0-alpha.66

## @lunora/config [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.86...%40lunora%2Fconfig%401.0.0-alpha.87) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.61
* **@lunora/seed:** upgraded to 1.0.0-alpha.36
* **@lunora/studio:** upgraded to 1.0.0-alpha.65

## @lunora/config [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.85...%40lunora%2Fconfig%401.0.0-alpha.86) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.60
* **@lunora/seed:** upgraded to 1.0.0-alpha.35
* **@lunora/studio:** upgraded to 1.0.0-alpha.64

## @lunora/config [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.84...%40lunora%2Fconfig%401.0.0-alpha.85) (2026-07-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.59
* **@lunora/seed:** upgraded to 1.0.0-alpha.34
* **@lunora/studio:** upgraded to 1.0.0-alpha.63

## @lunora/config [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.83...%40lunora%2Fconfig%401.0.0-alpha.84) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.58
* **@lunora/seed:** upgraded to 1.0.0-alpha.33
* **@lunora/studio:** upgraded to 1.0.0-alpha.62

## @lunora/config [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.82...%40lunora%2Fconfig%401.0.0-alpha.83) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.57
* **@lunora/seed:** upgraded to 1.0.0-alpha.32
* **@lunora/studio:** upgraded to 1.0.0-alpha.61

## @lunora/config [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.81...%40lunora%2Fconfig%401.0.0-alpha.82) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.56
* **@lunora/seed:** upgraded to 1.0.0-alpha.31
* **@lunora/studio:** upgraded to 1.0.0-alpha.60

## @lunora/config [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.80...%40lunora%2Fconfig%401.0.0-alpha.81) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.55

## @lunora/config [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.79...%40lunora%2Fconfig%401.0.0-alpha.80) (2026-07-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.54
* **@lunora/container:** upgraded to 1.0.0-alpha.16
* **@lunora/errors:** upgraded to 1.0.0-alpha.8
* **@lunora/seed:** upgraded to 1.0.0-alpha.30
* **@lunora/studio:** upgraded to 1.0.0-alpha.59

## @lunora/config [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.78...%40lunora%2Fconfig%401.0.0-alpha.79) (2026-07-24)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.53
* **@lunora/container:** upgraded to 1.0.0-alpha.15

## @lunora/config [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.77...%40lunora%2Fconfig%401.0.0-alpha.78) (2026-07-23)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.52
* **@lunora/seed:** upgraded to 1.0.0-alpha.29
* **@lunora/studio:** upgraded to 1.0.0-alpha.58

## @lunora/config [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.76...%40lunora%2Fconfig%401.0.0-alpha.77) (2026-07-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.51

## @lunora/config [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.75...%40lunora%2Fconfig%401.0.0-alpha.76) (2026-07-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.50

## @lunora/config [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.74...%40lunora%2Fconfig%401.0.0-alpha.75) (2026-07-21)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.49

## @lunora/config [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.73...%40lunora%2Fconfig%401.0.0-alpha.74) (2026-07-21)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.57

## @lunora/config [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.72...%40lunora%2Fconfig%401.0.0-alpha.73) (2026-07-21)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.56

## @lunora/config [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.71...%40lunora%2Fconfig%401.0.0-alpha.72) (2026-07-21)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.48
* **@lunora/seed:** upgraded to 1.0.0-alpha.28
* **@lunora/studio:** upgraded to 1.0.0-alpha.55

## @lunora/config [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.70...%40lunora%2Fconfig%401.0.0-alpha.71) (2026-07-20)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.47
* **@lunora/container:** upgraded to 1.0.0-alpha.13
* **@lunora/errors:** upgraded to 1.0.0-alpha.6
* **@lunora/seed:** upgraded to 1.0.0-alpha.27
* **@lunora/studio:** upgraded to 1.0.0-alpha.54

## @lunora/config [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.69...%40lunora%2Fconfig%401.0.0-alpha.70) (2026-07-19)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.46
* **@lunora/seed:** upgraded to 1.0.0-alpha.26
* **@lunora/studio:** upgraded to 1.0.0-alpha.53

## @lunora/config [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.68...%40lunora%2Fconfig%401.0.0-alpha.69) (2026-07-18)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.45
* **@lunora/seed:** upgraded to 1.0.0-alpha.25
* **@lunora/studio:** upgraded to 1.0.0-alpha.52

## @lunora/config [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.67...%40lunora%2Fconfig%401.0.0-alpha.68) (2026-07-17)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.44
* **@lunora/container:** upgraded to 1.0.0-alpha.12
* **@lunora/errors:** upgraded to 1.0.0-alpha.5
* **@lunora/seed:** upgraded to 1.0.0-alpha.24
* **@lunora/studio:** upgraded to 1.0.0-alpha.51

## @lunora/config [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.66...%40lunora%2Fconfig%401.0.0-alpha.67) (2026-07-13)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.50

## @lunora/config [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.65...%40lunora%2Fconfig%401.0.0-alpha.66) (2026-07-13)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.43
* **@lunora/seed:** upgraded to 1.0.0-alpha.23
* **@lunora/studio:** upgraded to 1.0.0-alpha.49

## @lunora/config [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.64...%40lunora%2Fconfig%401.0.0-alpha.65) (2026-07-12)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.42
* **@lunora/container:** upgraded to 1.0.0-alpha.11

## @lunora/config [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.63...%40lunora%2Fconfig%401.0.0-alpha.64) (2026-07-12)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.48

## @lunora/config [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.62...%40lunora%2Fconfig%401.0.0-alpha.63) (2026-07-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.41
* **@lunora/container:** upgraded to 1.0.0-alpha.10

## @lunora/config [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.61...%40lunora%2Fconfig%401.0.0-alpha.62) (2026-07-11)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.40
* **@lunora/container:** upgraded to 1.0.0-alpha.9
* **@lunora/errors:** upgraded to 1.0.0-alpha.4
* **@lunora/seed:** upgraded to 1.0.0-alpha.22
* **@lunora/studio:** upgraded to 1.0.0-alpha.47

## @lunora/config [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.60...%40lunora%2Fconfig%401.0.0-alpha.61) (2026-07-10)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.39
* **@lunora/seed:** upgraded to 1.0.0-alpha.21
* **@lunora/studio:** upgraded to 1.0.0-alpha.46

## @lunora/config [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.59...%40lunora%2Fconfig%401.0.0-alpha.60) (2026-07-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.38
* **@lunora/container:** upgraded to 1.0.0-alpha.8
* **@lunora/errors:** upgraded to 1.0.0-alpha.3
* **@lunora/seed:** upgraded to 1.0.0-alpha.20
* **@lunora/studio:** upgraded to 1.0.0-alpha.45

## @lunora/config [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.58...%40lunora%2Fconfig%401.0.0-alpha.59) (2026-07-08)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.37
* **@lunora/seed:** upgraded to 1.0.0-alpha.19
* **@lunora/studio:** upgraded to 1.0.0-alpha.44

## @lunora/config [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.57...%40lunora%2Fconfig%401.0.0-alpha.58) (2026-07-07)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.36
* **@lunora/seed:** upgraded to 1.0.0-alpha.18
* **@lunora/studio:** upgraded to 1.0.0-alpha.43

## @lunora/config [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.56...%40lunora%2Fconfig%401.0.0-alpha.57) (2026-07-06)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.35
* **@lunora/studio:** upgraded to 1.0.0-alpha.42

## @lunora/config [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.55...%40lunora%2Fconfig%401.0.0-alpha.56) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.34
* **@lunora/container:** upgraded to 1.0.0-alpha.7
* **@lunora/errors:** upgraded to 1.0.0-alpha.2
* **@lunora/seed:** upgraded to 1.0.0-alpha.17
* **@lunora/studio:** upgraded to 1.0.0-alpha.41

## @lunora/config [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.54...%40lunora%2Fconfig%401.0.0-alpha.55) (2026-07-04)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.40

## @lunora/config [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.53...%40lunora%2Fconfig%401.0.0-alpha.54) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.33
* **@lunora/studio:** upgraded to 1.0.0-alpha.39

## @lunora/config [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.52...%40lunora%2Fconfig%401.0.0-alpha.53) (2026-07-04)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.38

## @lunora/config [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.51...%40lunora%2Fconfig%401.0.0-alpha.52) (2026-07-04)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.37

## @lunora/config [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.50...%40lunora%2Fconfig%401.0.0-alpha.51) (2026-07-04)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.36

## @lunora/config [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.49...%40lunora%2Fconfig%401.0.0-alpha.50) (2026-07-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.32
* **@lunora/seed:** upgraded to 1.0.0-alpha.16
* **@lunora/studio:** upgraded to 1.0.0-alpha.35

## @lunora/config [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.48...%40lunora%2Fconfig%401.0.0-alpha.49) (2026-07-03)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.34

## @lunora/config [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.47...%40lunora%2Fconfig%401.0.0-alpha.48) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.30
* **@lunora/seed:** upgraded to 1.0.0-alpha.15
* **@lunora/studio:** upgraded to 1.0.0-alpha.33

## @lunora/config [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.46...%40lunora%2Fconfig%401.0.0-alpha.47) (2026-07-03)

## @lunora/config [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.45...%40lunora%2Fconfig%401.0.0-alpha.46) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.29
* **@lunora/container:** upgraded to 1.0.0-alpha.6
* **@lunora/errors:** upgraded to 1.0.0-alpha.1
* **@lunora/seed:** upgraded to 1.0.0-alpha.14
* **@lunora/studio:** upgraded to 1.0.0-alpha.32

## @lunora/config [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.44...%40lunora%2Fconfig%401.0.0-alpha.45) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.28
* **@lunora/studio:** upgraded to 1.0.0-alpha.31

## @lunora/config [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.43...%40lunora%2Fconfig%401.0.0-alpha.44) (2026-07-03)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.30

## @lunora/config [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.42...%40lunora%2Fconfig%401.0.0-alpha.43) (2026-07-03)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.29

## @lunora/config [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.41...%40lunora%2Fconfig%401.0.0-alpha.42) (2026-07-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.27
* **@lunora/seed:** upgraded to 1.0.0-alpha.13
* **@lunora/studio:** upgraded to 1.0.0-alpha.28

## @lunora/config [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.40...%40lunora%2Fconfig%401.0.0-alpha.41) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.26
* **@lunora/studio:** upgraded to 1.0.0-alpha.27

## @lunora/config [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.39...%40lunora%2Fconfig%401.0.0-alpha.40) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.25
* **@lunora/seed:** upgraded to 1.0.0-alpha.12
* **@lunora/studio:** upgraded to 1.0.0-alpha.26

## @lunora/config [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.38...%40lunora%2Fconfig%401.0.0-alpha.39) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.24
* **@lunora/studio:** upgraded to 1.0.0-alpha.25

## @lunora/config [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.37...%40lunora%2Fconfig%401.0.0-alpha.38) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.23
* **@lunora/seed:** upgraded to 1.0.0-alpha.11
* **@lunora/studio:** upgraded to 1.0.0-alpha.24

## @lunora/config [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.36...%40lunora%2Fconfig%401.0.0-alpha.37) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.22
* **@lunora/seed:** upgraded to 1.0.0-alpha.10
* **@lunora/studio:** upgraded to 1.0.0-alpha.23

## @lunora/config [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.35...%40lunora%2Fconfig%401.0.0-alpha.36) (2026-07-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.21
* **@lunora/seed:** upgraded to 1.0.0-alpha.9
* **@lunora/studio:** upgraded to 1.0.0-alpha.22

## @lunora/config [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.34...%40lunora%2Fconfig%401.0.0-alpha.35) (2026-07-01)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.21

## @lunora/config [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.33...%40lunora%2Fconfig%401.0.0-alpha.34) (2026-07-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.20
* **@lunora/seed:** upgraded to 1.0.0-alpha.8
* **@lunora/studio:** upgraded to 1.0.0-alpha.20

## @lunora/config [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.32...%40lunora%2Fconfig%401.0.0-alpha.33) (2026-06-30)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.19

## @lunora/config [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.31...%40lunora%2Fconfig%401.0.0-alpha.32) (2026-06-30)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.18

## @lunora/config [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.30...%40lunora%2Fconfig%401.0.0-alpha.31) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.19
* **@lunora/studio:** upgraded to 1.0.0-alpha.17

## @lunora/config [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.29...%40lunora%2Fconfig%401.0.0-alpha.30) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.18

## @lunora/config [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.28...%40lunora%2Fconfig%401.0.0-alpha.29) (2026-06-30)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.16

## @lunora/config [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.27...%40lunora%2Fconfig%401.0.0-alpha.28) (2026-06-30)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.15

## @lunora/config [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.26...%40lunora%2Fconfig%401.0.0-alpha.27) (2026-06-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.17
* **@lunora/seed:** upgraded to 1.0.0-alpha.7
* **@lunora/studio:** upgraded to 1.0.0-alpha.14

## @lunora/config [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.25...%40lunora%2Fconfig%401.0.0-alpha.26) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.16
* **@lunora/container:** upgraded to 1.0.0-alpha.5

## @lunora/config [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.24...%40lunora%2Fconfig%401.0.0-alpha.25) (2026-06-29)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.13

## @lunora/config [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.23...%40lunora%2Fconfig%401.0.0-alpha.24) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.15
* **@lunora/studio:** upgraded to 1.0.0-alpha.12

## @lunora/config [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.22...%40lunora%2Fconfig%401.0.0-alpha.23) (2026-06-29)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.11

## @lunora/config [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fconfig%401.0.0-alpha.21...%40lunora%2Fconfig%401.0.0-alpha.22) (2026-06-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.14
* **@lunora/seed:** upgraded to 1.0.0-alpha.6
* **@lunora/studio:** upgraded to 1.0.0-alpha.10

## @lunora/config [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.20...@lunora/config@1.0.0-alpha.21) (2026-06-28)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.9

## @lunora/config [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.19...@lunora/config@1.0.0-alpha.20) (2026-06-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.13

## @lunora/config [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.18...@lunora/config@1.0.0-alpha.19) (2026-06-28)

### Features

* **config:** stream dev container logs to terminal ([#38](https://github.com/anolilab/lunora/issues/38)) ([c34dbc6](https://github.com/anolilab/lunora/commit/c34dbc6f40f9e31ce291dbd31c6c4d9e596b4127))

## @lunora/config [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.17...@lunora/config@1.0.0-alpha.18) (2026-06-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.12
* **@lunora/container:** upgraded to 1.0.0-alpha.4

## @lunora/config [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.16...@lunora/config@1.0.0-alpha.17) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.11
* **@lunora/container:** upgraded to 1.0.0-alpha.3
* **@lunora/seed:** upgraded to 1.0.0-alpha.5
* **@lunora/studio:** upgraded to 1.0.0-alpha.8

## @lunora/config [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.15...@lunora/config@1.0.0-alpha.16) (2026-06-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.10
* **@lunora/container:** upgraded to 1.0.0-alpha.2
* **@lunora/seed:** upgraded to 1.0.0-alpha.4
* **@lunora/studio:** upgraded to 1.0.0-alpha.7

## @lunora/config [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.14...@lunora/config@1.0.0-alpha.15) (2026-06-27)

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.9
* **@lunora/seed:** upgraded to 1.0.0-alpha.3
* **@lunora/studio:** upgraded to 1.0.0-alpha.6

## @lunora/config [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.13...@lunora/config@1.0.0-alpha.14) (2026-06-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.8

## @lunora/config [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.12...@lunora/config@1.0.0-alpha.13) (2026-06-25)

### Features

* **config:** export secret-generation primitives ([3b16361](https://github.com/anolilab/lunora/commit/3b1636139bf704c2b38440f509b5909b1e2e9ad7))

## @lunora/config [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.11...@lunora/config@1.0.0-alpha.12) (2026-06-25)

### Features

* **config:** generate empty dev secrets + admin token on dev ([c4f729f](https://github.com/anolilab/lunora/commit/c4f729f51bc0a68a356e2750ce49cc7a1edbf9a2))

### Tests

* **config:** guard dev .dev.vars admin token end-to-end ([badc524](https://github.com/anolilab/lunora/commit/badc5247fe9070e6be3e7aff0617b303e82bbd8d))

## @lunora/config [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.10...@lunora/config@1.0.0-alpha.11) (2026-06-25)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.5

## @lunora/config [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.9...@lunora/config@1.0.0-alpha.10) (2026-06-25)

### Bug Fixes

* **config:** scaffold LUNORA_ADMIN_TOKEN as a core secret ([6cd2567](https://github.com/anolilab/lunora/commit/6cd25676e4799e7383c52f5e7bbccce7b3b92068))

## @lunora/config [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.8...@lunora/config@1.0.0-alpha.9) (2026-06-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.7

## @lunora/config [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.7...@lunora/config@1.0.0-alpha.8) (2026-06-25)

### Bug Fixes

* **config:** see package schema extensions in schema-info ([9912f53](https://github.com/anolilab/lunora/commit/9912f53de444487cdc1cfd796b47e9c26fa0312e))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.6

## @lunora/config [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.6...@lunora/config@1.0.0-alpha.7) (2026-06-25)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.5

## @lunora/config [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.5...@lunora/config@1.0.0-alpha.6) (2026-06-25)

### Features

* **config:** export BADGE_COLUMN_WIDTH ([c8a6a1e](https://github.com/anolilab/lunora/commit/c8a6a1ed760b62f800e3e174883a620fba3d81bc))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.4
* **@lunora/seed:** upgraded to 1.0.0-alpha.2
* **@lunora/studio:** upgraded to 1.0.0-alpha.4

## @lunora/config [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.4...@lunora/config@1.0.0-alpha.5) (2026-06-25)

### Features

* **config:** add shared tui theme and LunoraReporter ([79a1895](https://github.com/anolilab/lunora/commit/79a1895ac8eac8c1be35776da268c1764d2956ef))

## @lunora/config [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.3...@lunora/config@1.0.0-alpha.4) (2026-06-24)

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.3
* **@lunora/studio:** upgraded to 1.0.0-alpha.3

## @lunora/config [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.2...@lunora/config@1.0.0-alpha.3) (2026-06-22)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.2

## @lunora/config [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.1...@lunora/config@1.0.0-alpha.2) (2026-06-22)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.2

## @lunora/config 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Bug Fixes

* **ci:** green the core pipeline — build, typecheck, lint, docs, netlify, codspeed ([571957a](https://github.com/anolilab/lunora/commit/571957a65b3682160c32f804a16f7b64fd845085))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.1
* **@lunora/container:** upgraded to 1.0.0-alpha.1
* **@lunora/seed:** upgraded to 1.0.0-alpha.1
* **@lunora/studio:** upgraded to 1.0.0-alpha.1
