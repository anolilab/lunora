## @lunora/astro [1.0.0-alpha.119](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.118...@lunora/astro@1.0.0-alpha.119) (2026-09-06)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.83
* **@lunora/runtime:** upgraded to 1.0.0-alpha.98

## @lunora/astro [1.0.0-alpha.118](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.117...@lunora/astro@1.0.0-alpha.118) (2026-09-06)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.82
* **@lunora/runtime:** upgraded to 1.0.0-alpha.97

## @lunora/astro [1.0.0-alpha.117](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.116...@lunora/astro@1.0.0-alpha.117) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.81
* **@lunora/runtime:** upgraded to 1.0.0-alpha.96

## @lunora/astro [1.0.0-alpha.116](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.115...@lunora/astro@1.0.0-alpha.116) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.80
* **@lunora/runtime:** upgraded to 1.0.0-alpha.95

## @lunora/astro [1.0.0-alpha.115](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.114...@lunora/astro@1.0.0-alpha.115) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.79
* **@lunora/runtime:** upgraded to 1.0.0-alpha.94

## @lunora/astro [1.0.0-alpha.114](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.113...@lunora/astro@1.0.0-alpha.114) (2026-09-05)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.78
* **@lunora/runtime:** upgraded to 1.0.0-alpha.93

## @lunora/astro [1.0.0-alpha.113](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.112...@lunora/astro@1.0.0-alpha.113) (2026-09-04)

### ⚠ BREAKING CHANGES

* `@lunora/config/cloudflare` exports `mergeWranglerEnvironment`,
and `WranglerConfig["placement"]` gains `region` / `host` / `hostname`.

Declined: D6 — `triggers` and `compatibility_date` are both `inheritable` in
wrangler, so the top-level write is correct for every environment that does not
override them, and the bindings reconciler already prints the top-level-only
advisory on the same run. D7 is inert until a second toolchain driver exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(agent,mcp): close the traversal, retry-storm and prototype-lookup gaps

The MCP documentation corpus is exposed twice — as tools and as resources — and only the tool
path applied the URL guard. `lunora_get_doc` normalises the model-supplied `url` and rejects `..`,
`%2e%2e`, `%252e` and backslashes; `resources/read` stripped the `lunora-docs:` prefix and handed
the remainder straight to the index, which appends it to `/llms.mdx` and fetches. Both
`lunora-docs:/../../admin/secrets` and its percent-encoded form resolved to
`https://<docs-origin>/admin/secrets` and returned that page as documentation. The hosted docs
site is unaffected (its index is a slug map); the local server pointed at a self-hosted
`--docs-url` — the internal-host case the guard's own docblock names — is not. `read` now routes
through the tool's `normalizeDocUrl` rather than repeating its checks, so the two callers cannot
drift apart again.

The loop's "invalid input, let the model recover" branch never fired for a batteries-included
tool. A bare `jsonSchema()` carries no validator, and the AI SDK's `safeValidateTypes` returns
success unchanged when `validate == null`, so a wrong-typed model argument was never marked
`invalid`: it reached `execute`, the dispatched function answered 400, and that threw inside the
loop's native `step.do`, which knows nothing of `isDeterministicDispatchFailure` and retried the
same deterministic 400 until the run failed. The tool step now converts a branded deterministic
dispatch failure into a tool-result row the next turn can read, the way `@lunora/workflow`'s
`createRunStep` does; transient failures keep the host's retry. The `codeTool` documentation
claimed each step's input "is validated against that tool's own `inputSchema`" — it now says what
the check actually depends on.

A voice control frame was cast to the closed `VoiceClientFrame` union straight off `JSON.parse`,
and everything the tail did not recognise was treated as a text turn. So `{type:"x",text:…}`
skipped the 4 000-character bound (keyed on `type === "text"`) and reached the model measured only
against the 17 024-character raw-frame limit, while `{"type":"text"}` read `.length` off
`undefined`. Frames are now narrowed by a real predicate and an unknown one is refused before the
thread round-trip and the session-turn counter.

`codeTool` resolved model-supplied names with `in` and bare indexing, both of which walk the
prototype chain: a step naming `constructor`/`toString`/`__proto__` found a truthy non-tool and
died on `tool.execute is not a function` — a TypeError the host retries — instead of the
documented BAD_REQUEST, and `$from: "constructor"` handed a composed tool the `Object`
constructor as an argument. Both now use `Object.hasOwn`, matching `getPath` in the same file.

`approvalTimeout: 0` was accepted and clamped only from above, so `step.waitForEvent` elapsed
immediately and every human-in-the-loop tool was recorded as "approval timed out" and reported to
the model as a user rejection before a client could render the marker. Validated at declaration
time on the resolved milliseconds, so the string form and `NaN` are covered too.
* `defineAgent` now throws on an `approvalTimeout` that resolves to zero or less.
A tool call that fails with a deterministic dispatch error is persisted as a tool-result row and
the run continues, where it previously failed the run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(templates): make every scaffold deployable, and gate on it

Three templates could not be deployed at all from a fresh scaffold. None of it was visible to
any gate, because the template smoke matrix builds and typechecks but never tried to deploy.

analog: `main` pointed at Nitro's `cloudflare-module` output, which is a single
`export default createHandler(...)` — it re-exports nothing, and nitropack 2.13.4 has no hook that
appends named exports to it (`exports.cloudflare.ts` was fiction; zero hits across its `dist/`).
`wrangler deploy` rejected every scaffold with "Durable Objects … not exported in your entrypoint
file: ShardDO". Replaced with a root `worker.ts` wrapper re-exporting Nitro's handler plus
`ShardDO`, the shape the Nuxt template already uses, and deleted `exports.cloudflare.ts`.

astro: the composed entry was `src/worker.ts`, which `lunora deploy` treats as a SvelteKit-shaped
entry and passes to wrangler POSITIONALLY. The @astrojs/cloudflare adapter writes a deploy redirect
carrying `no_bundle: true`, so that positional was uploaded as the worker verbatim — 1.4 KiB of
untranspiled TypeScript, exit 0, binding table printed. Renamed to `src/server.ts` (matching
solid-v2), so the positional never fires and wrangler ships the adapter-built
`dist/server/entry.mjs` (17 modules) it was always meant to.

nuxt + analog: no `assets` binding. Nitro's Cloudflare runtime serves client assets only via
`env.ASSETS`, so SSR HTML rendered and every `/_nuxt/*` and `/assets/*` request 404'd. Bound each
preset's own `output.publicDir`.

next: `lunora verify|deploy|dev` probe the root `wrangler.jsonc` and require the SHARD binding, but
the root config was the OpenNext SSR worker, so a fresh scaffold failed `lunora verify`. Swapped the
two: the Lunora worker takes `wrangler.jsonc`, the SSR worker becomes `wrangler.opennext.jsonc`,
and every OpenNext command is passed `--config` (build, preview and deploy all accept it).

@lunora/astro only recognised `withLunora(` as the composition seam, so the scaffold's
`.buildFrameworkWorker(host)` — what every class-B template uses — warned "subscriptions will
silently 404" on every build of a correctly composed worker.
* the astro template's composed entry is `src/server.ts`, and `@lunora/astro`'s
default `serverEntry` follows it. The next template's `wrangler.lunora.jsonc` is now the root
`wrangler.jsonc` and its OpenNext config is `wrangler.opennext.jsonc`.

The gate: `scripts/template-build-smoke.sh` now runs each template's own deploy path as a
credential-free dry run and checks four things, because each defect above needs a different one —
the exit code catches analog, the emitted bundle catches astro (a `.ts` file in a worker bundle
means the entry was never transpiled), and the printed binding table catches the missing assets.
Templates that pass `validateWrangler: false` to the Vite plugin keep it; they are gated here at the
deploy boundary instead. Also fixes stale template docs: the nuxt and astro READMEs documented
loader files that do not exist, and the init picker called both single-worker templates "a
standalone Lunora worker".

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(sdks): pin the codec behaviours the fixtures never asserted

The case list was not known to be complete, and where it was silent the ports
drifted silently. Enumerating the reference codec branch by branch — every tag,
every payload guard, every re-encode — against the fixtures turned up 58 behaviours
with no case that would fail if a port got them wrong, four of which were already
wrong in every port.

`sdks/README.md` now carries the derived coverage matrix: one row per reference
behaviour, the case that pins it, and for the five that stay unpinned the
measurement that says why.

Found by adding the cases first and recording which ports went red:

- A `set` never de-duplicated. The reference decodes into a real `Set`, so its
  items collapse under SameValueZero like map keys do; all eight carried both
  copies and re-encoded a set the reference cannot emit. Same identity helper,
  now applied to both.
- A duplicate map key replaced the stored KEY as well as its value.
  `Map.prototype.set` keeps the key it holds, so `[[0,"a"],[-0,"b"]]` re-encodes
  with the `0` it first held. Invisible until a signed zero collapsed onto an
  unsigned one; wrong in all eight.
- SameValueZero holds -0 equal to 0, and every port's number formatting kept the
  sign, so a signed zero was its own map key and its own set item.
- A `bigint` digit string was carried verbatim in rust and swift, where the
  reference canonicalises through `BigInt().toString()` — `"007"` re-encoded as
  `"007"`, and the two ends keyed one subscription two ways.
- rust narrowed a negative zero to i64 while building the encoded tree, so the
  stable key spelled it `0`. `stableStringify` reads that tree and has its own
  `-0` branch, so the narrowing handed `{ "a": -0.0 }` the cache key of
  `{ "a": 0 }`. It now stays f64, which spells `-0.0` on the wire where the
  reference spells `0` — the same number to every JSON reader, and the lesser of
  the two divergences the value model forces.

New cases that every port already satisfied are kept as regression pins and named
as such in the matrix: the eight untested typed-array constructors (their tables
were complete, which the paired misalignment rejections prove), the unknown-tag
re-escape, and twenty-one payload-slot rejections.

Deliberately not pinned, each measured: a lone surrogate in a stable key (ruby's
JSON parser rejects the fixture file outright, go's substitutes U+FFFD — neither
can carry the input, and neither can reach the value on a real wire); an `Error`
`name`/`message` that is not a string, where the reference is JS-accidentally
lenient; and `Error` own props carrying `__proto__`, which the reference's encode
side drops through the prototype setter its decode side guards against — a defect
to fix there rather than freeze into eight languages.

Two capability rows added for gaps the manifest may not hold, since it can only
require behaviour every port has: no port merges a row `delta` into a cached list
(all eight replace the value with the row-change envelope), and none handles the
`chunk` or `whisper` frames.

Executed cases, before -> after: python 98 -> 98, go 168 -> 226, ruby 77 -> 77,
rust 9 -> 9, swift 11 -> 11, java 331 -> 389, kotlin 336 -> 394, dart 82 -> 82.
The counters that did not move report suites, not fixture rows; the fixtures grew
from 62 to 108 wire cases and from 12 to 24 stable-key cases in every leg.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(protocol): guard __proto__ in the error branch of encodeWire

`encodeWire`'s `Error` branch built its props object with a plain
`properties[key] = …`, while its own plain-object branch and both decode
branches route `"__proto__"` through `Object.defineProperty`. For that one key
the assignment fires the prototype SETTER instead of creating an own property,
so `["$lunora.wire$","error","E","m",{"__proto__":{"p":1}}]` — which `decodeWire`
correctly reconstructs with `__proto__` as an own data property — re-encoded as
`{}`. The field was silently dropped on every re-encode, and the props object
itself came back wearing a wire-supplied prototype, which `JSON.stringify` hides.

The branch now uses the same `UNSAFE_KEY` guard as its three siblings, so the
one spelling is consistent across all four sites that rebuild a wire object. It
was the only unguarded write left in the file.

`protocol/fixtures/wire-codec.json` gains `error-proto-key`, the `error`-tag twin
of the existing `proto-key` case. All eight non-JS ports already passed it
unchanged — `__proto__` is an ordinary map key everywhere but JS — so this was a
reference-only defect, and the fixture now pins correct behaviour rather than the
bug. `packages/client/__tests__/wire-codec.test.ts` adds the pollution axis the
JSON round trip cannot see: the encoded props object must still have
`Object.prototype`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(cli,config,astro,d1): close nine scaffold, dev and parsing defects

`lunora init` followed a symlinked target. `cwd/<name>` was probed with `existsSync`, which
resolves the link, so a link pointing at an empty directory passed the emptiness check and
became the scaffold target: writes landed outside `cwd`, and the reset path — which empties a
pre-existing target back out — would delete files there the run never wrote. The target is now
probed with `lstat` and a symlink is refused. Every scaffold path routes through that one gate.

A scaffold that threw mid-copy left its partial writes behind. `copyTemplate` writes
sequentially, so an fs failure lands after earlier files are already on disk, and
`runInitCommand` rethrew with the target still there — the retry, with the cause fixed, was then
refused with "target directory not empty". The throw path now resets, and the copy marks the
target complete the moment it finishes, so a failure in the reporting that follows cannot delete
a project that was fully written.

The interactive checklist announced "Project initialized!" as soon as the copy task finished,
which is before the empty-template check can fail the run — an empty remote template printed
success and then exited 1. The header is now a neutral statement of what the tasks did; the one
success line still comes after the check.

`lunora dev --remote` snapshotted `wrangler.jsonc` into the temp config wrangler is spawned with
BEFORE provisioning the bindings the project's code implies, so the worker ran with a config one
binding short. Provisioning — and the target resolve — now happen ahead of the plan, which also
closes the window that could orphan the temp config.

`tuiTasks` waited unconditionally for the task chain to settle on its error path. The Ctrl-C
listener attaches in a layout effect while the chain starts in a passive one, so an interrupt in
between ended the app with nothing left to settle and the CLI hung forever. The wait is now
armed by the chain actually starting, and still covers an in-flight task.

The deploy preflight dereferenced `d1_databases` entries after only an `Array.isArray` check, so
`"d1_databases": [null]` threw a TypeError out of a gate instead of letting the validator report
the malformed config. Nullish entries are dropped at the one normalisation boundary the gates
read through.

`reconcileDurableObjects` replayed the `migrations` list without normalising it, so a stray
`null` record, rename entry or class name threw out of a step that runs on every dev-server
start. It now reuses the validator's own `objectBindingEntries` / `stringEntries`, which already
fold the identical hand-edited list.

`@lunora/astro`'s composition check scanned raw source, so a commented-out or quoted
`withLunora(...)` suppressed the "`/_lunora/*` will be unrouted" warning for an entry that
composed nothing. Comments and string literals are blanked before the probe runs; a template
literal's interpolations are kept, because those are real code.

The `CREATE TRIGGER` probe in `@lunora/d1` allowed only whitespace between the keywords, so
`CREATE /* comment */ TRIGGER` — which SQLite accepts — stopped reading as a trigger and its
body's first `;` was rejected as a second statement.

Reviewed and declined: `containers` stays in `NON_INHERITABLE_KEYS`. wrangler's own config
resolver registers it through `notInheritable(...)` with a `void 0` default, and warns that the
key "is not inherited by environments" — so resolving it to `undefined` for an environment that
omits it is exactly what wrangler does.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: stop replays, transports and gates from dropping work silently

Six defects that all share a shape: something that looked handled was quietly discarded.

`step.do` memoizes BY NAME, and the tool step's name (`tool:<name>:<id>`) did not change when
its memoized value became an outcome envelope. A run parked across that deploy — approval
hibernation, a long multi-turn — resumes and is handed the OLD raw output back, which the new
code read as an envelope: the tool row persisted as `"undefined"` (poisoning every later turn
AND every later run on the thread) or, for a string/number/null memo, threw `Cannot use 'in'
operator`. The outcome now travels behind a wrapper key, and anything arriving without it is
read as the raw output it was. A distinct wrapper rather than probing the value: `{ ok: true }`
is an ordinary tool result, and a bare probe unwraps it to `true`.

The same tool path persisted a deterministic failure's text raw while the success path capped
it. `outcome.failed` is a server-supplied, unbounded message on a row re-rendered into every
later turn, so it is capped identically now.

The Python client synthesized an `INTERNAL` error envelope for an unreadable error body. That
routes through `parse_rpc_response` as a coded VERDICT, and `INTERNAL` is in neither
`TRANSIENT_ERROR_CODES` nor `RATE_LIMIT_ERROR_CODES` — so the offline queue settled the write
terminally. A 302 from a load balancer or a WAF's HTML page on a 4xx dropped a queued durable
write. Returning the status with no envelope restores the transport branch (`transient=True`)
that the other seven ports take. The redirect refusal itself is unchanged.

`mergeWranglerEnvironment` was exported without its return type, so a consumer could call it
but not name its result. `WranglerEnvironmentMerge` is exported now, and the CLI's composed
worker entry imports `COMPOSED_WORKER_ENTRY` instead of repeating the literal a docblock asked
it to keep in sync by hand.

`.gitignore` appends land BELOW what the file already had and git takes the last match, so
adding `.dev.vars.*` under an existing `!.dev.vars.example` re-ignored a file the templates
ship. Both writers — `lunora deploy`'s secret guard and the `lunora init` overlay — now
re-state their negations after the additions.

The template smoke matrix's TypeScript-in-bundle gate ran `find` on a directory it never
checked existed. `find` exits 1 there, `pipefail` carries it through `head`, and because both
call sites are `if ! run_deploy_dryrun …` — which suppresses errexit — the gate passed
VACUOUSLY on the one run where no bundle was emitted. It now fails with a reason.
* `@lunora/astro`'s `lunora()` integration defaults `serverEntry` to
`src/server.ts`, not `src/worker.ts`. A project on the old name and no explicit `serverEntry`
warned "not found" on every build; it now gets a warning naming the rename, why the old path
is unsafe for Astro (`lunora deploy` passes it to wrangler positionally, and the adapter
redirect's `no_bundle` then uploads it untranspiled), and the option that keeps the old name.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* make every template deployable, and close the SDK, deploy and adapter gaps ([#591](https://github.com/anolilab/lunora/issues/591)) ([2630283](https://github.com/anolilab/lunora/commit/26302835bdd4b02dccbed5e8e6e7b8705ff4f155))

## @lunora/astro [1.0.0-alpha.112](https://github.com/anolilab/lunora/compare/@lunora/astro@1.0.0-alpha.111...@lunora/astro@1.0.0-alpha.112) (2026-09-04)


### Dependencies

* **@lunora/client:** upgraded to 1.0.0-alpha.76
* **@lunora/runtime:** upgraded to 1.0.0-alpha.92

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
