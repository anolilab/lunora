## @lunora/config [1.0.0-alpha.193](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.192...@lunora/config@1.0.0-alpha.193) (2026-09-05)

### ⚠ BREAKING CHANGES

* **codegen:** `@lunora/config` no longer exports `ResourceGraph`,
`NamedResource`, `ShardNamespaceResource`, `ProvisionResult` or `DriverContext`,
and `DeployDriver` is now `{ id, name, toolchain? }` — `infer` and `provision`
are gone. `@lunora/bindings/images` no longer exports `DrawOverlay`, and
`TransformOptions` has no `draw` key.


Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

Co-authored-by: Claude Opus 5 (1M context) <noreply@anthropic.com>
* **cli:** `requiredPackagesFor` / `assertRequiredPackages` take a signals
object in place of the trailing `hasVectors` boolean. `ImportSummary.storage`
carries capped `ambiguous`/`unmigrated` samples plus new `ambiguousTotal` /
`unmigratedTotal` counts. `InferredBindings` gains `usesNotify` and `usesR2sql`.
`OfferDeps.resolveAuthUiItem` may now return `undefined`, which callers must read
as a refusal. `verify` and `build` accept `--strict-advisories` /
`--no-strict-advisories`, and `verify` now fails on ERROR-level advisories under
the same CI-on/local-off default as every other caller.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(cli): escape the NUL key separator and type the registry dispatch mocks

The storage-remap dedup key used a raw NUL byte as its separator, which makes git
treat the file as binary — invisible in diff, blame and review — and fails the
`no-nul-bytes` postinstall gate, which turns every CI job red in its setup step
while naming the cause in none of them. `\\u0000` is byte-identical at runtime.

The new registry-dispatch test's mocks returned `{ code, items }` where all three
runners return `AddCommandResult` (`bindings`/`code`/`deps`/`skipped`/`written`),
and its toolbox cast named a wider options type than `execute` accepts. Neither
surfaced earlier because the branch's verification skipped `lint:types`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* **cli:** make migrate fail loudly, and close thirteen more command defects ([#608](https://github.com/anolilab/lunora/issues/608)) ([1eb481f](https://github.com/anolilab/lunora/commit/1eb481f96ba00a00975e250212e5198f3065d658))
* **codegen:** gate on the context binding, not the identifier text ([#609](https://github.com/anolilab/lunora/issues/609)) ([c0bc210](https://github.com/anolilab/lunora/commit/c0bc2105833a32d44b71fec7e05ff503ac94d86d))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.158
* **@lunora/container:** upgraded to 1.0.0-alpha.45
* **@lunora/errors:** upgraded to 1.0.0-alpha.32
* **@lunora/seed:** upgraded to 1.0.0-alpha.108
* **@lunora/studio:** upgraded to 1.0.0-alpha.155

## @lunora/config [1.0.0-alpha.192](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.191...@lunora/config@1.0.0-alpha.192) (2026-09-05)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.154

## @lunora/config [1.0.0-alpha.191](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.190...@lunora/config@1.0.0-alpha.191) (2026-09-04)

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

## @lunora/config [1.0.0-alpha.190](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.189...@lunora/config@1.0.0-alpha.190) (2026-09-04)

### ⚠ BREAKING CHANGES

* the KV mutual-exclusion error is raised with code `BAD_REQUEST`
instead of `INTERNAL`, and it now fires from the admin `putValue` path as well as
`createKv`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(vite): materialize the remote wrangler config after bindings are provisioned

`planViteRemoteBindings` ran at plugin-factory time, before any Vite hook. The temp
config it writes is a copy of `wrangler.jsonc` with `"remote": true` injected on each
eligible binding, and Lunora provisions the bindings the project's code implies from
`wranglerValidatorPlugin`'s `config` hook — so the copy was always taken one write too
early. Under `LUNORA_REMOTE` the cloudflare plugin was then pointed at a snapshot that
predated the provisioning, and the dev worker booted without the binding that had just
been written. This is the remote twin of the local defect that moving the reconcile into
`config` closed; that move did not reach this path.

Observed live against a real account on an example app: `vite dev` logged
"inferred bindings -> AI (Workers AI) (written to .../wrangler.jsonc)", the file on disk
gained `"ai": { "binding": "AI" }`, the materialized temp config did not, and a probe
route reported `["DB","LUNORA_ADMIN_TOKEN","SHARD","WORKER_ENV"]`. After the change the
same probe reports `["AI","DB","LUNORA_ADMIN_TOKEN","SHARD","WORKER_ENV"]` and the temp
config carries `"ai": { "binding": "AI", "remote": true }`.

Materialization now happens in the `config` hook, which is registered after the
validator's and therefore runs after it (both are `enforce: "pre"`). The build gate moves
with it, so `vite build` no longer writes a temp config it never uses. Cleanup folds into
the same plugin because the disposer cannot be captured before the plan exists; a
re-entered `config` hook disposes the previous generation rather than orphaning its file.
* `remoteBindingsConfigPlugin` and `remoteBindingsCleanupPlugin` are
replaced by a single `remoteBindingsPlugin(options, planOptions)`, which takes the plan
inputs rather than an already-materialized plan.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(notify): close the register-side takeover and the dead-device blackout

`ctx.push.register()` upserted a subscription with `user_id = ?` in the `DO UPDATE SET` list, so
registering an endpoint already stored for someone else re-owned it. The id is derived from the
endpoint, i.e. a caller-controlled key — the same precondition `unregister` was given an atomic
`deleteOwned` for. Registering a victim's endpoint with garbage keys under your own id took their
device dark (an encryption failure is not a gone signal, so it was never pruned either) and handed
you `unregister` over it. Both stores now refuse a put that would move a row to a different owner —
D1 in the `ON CONFLICT … DO UPDATE`'s own `WHERE`, memory with no await between check and write —
and the legacy-prefix eviction inside `put`, a DELETE on a different primary key the guarded upsert
never sees, is scoped the same way (with the CLAIM predicate, so an anonymous device that signs in
still loses its old row).

FCM dead tokens were never detected as gone. The provider forwards `body.error.message` only, and
FCM HTTP v1 keeps `UNREGISTERED` in `error.details[].errorCode`, which it drops — so the codes
`isGoneError` matched could not arrive and every uninstalled device stayed registered forever, was
re-POSTed on every broadcast, and counted `failed`. Match the `NOT_FOUND` prose the transport
actually emits, still scoped to FCM.

A gone subscription also cost four POSTs and ~2.2 s of backoff before being deleted, because
`retryMiddleware` had no `shouldRetry`; those attempts then fed a circuit breaker whose counter is
closure state shared by every channel, so two dead devices blacked out `chat`/`webhook`/`inApp` for
30 s — and the second device's result became `Circuit open`, which is not a gone signal, so it
survived to repeat it. Permanent failures are no longer retried, and the breaker is per provider and
ignores them; it still opens for five consecutive transient failures.

On the retry path a gone receipt was reported `failed`, so the pruned id went back into `failedIds`
and the narrower retry could only throw `no registered subscription` until the queue dead-lettered
an unsubscribe. It settles as `expired` now, kinded by the id's own prefix, as does an id whose row
is already gone.

Seeded `email` columns used faker's `free_email` default, so generated rows carried deliverable
gmail/hotmail/yahoo addresses; seed a staging database, run any user-driven mail flow, and the app
mails real strangers from its own verified domain. They are built on the RFC 2606 reserved
`example.com` now — goldens regenerated, since an explicit provider also shifts faker's draw.

Also: the mail capture sink logs when it has nowhere to record instead of returning a success-shaped
`uncaptured` in silence; the inbound `verify` gate proceeds only on `true`/`undefined` rather than
on anything but `false`; the queue recipe and `idempotencyKey` docs say that consumer-side dedupe is
the only mechanism, since no transport can reach Resend's `Idempotency-Key` request header; the
studio seed host answers `409 fk-parents-empty` (a code its client already decoded and nothing ever
sent) instead of returning children whose fabricated parents it drops; and `flagshipProvider`
refuses a literal empty `authToken` as the thunk path already did.
* `SubscriptionStore.put` must refuse a put that would move a row to a different
owner, and `ctx.push.register()` now rejects with `FORBIDDEN` for an endpoint registered to another
user. `@lunora/seed` generates `@example.com` addresses, changing every seeded email value.
`handleSeedRequest` returns 409 instead of 200 for a table whose foreign-key parents were not
supplied in `existingIds`.

Test doubles were the reason two of these went unnoticed and are tightened here: the notify mock
engine now wires the real resilience middleware through the same `attachResilience` production
uses (a bare `createNotification` exercised none of it), the mock push provider answers each
provider's real gone phrasing per kind, and `fakeD1` models the `ON CONFLICT … DO UPDATE … WHERE`
refusal and each of the three `DELETE` owner predicates instead of overwriting and deleting
unconditionally.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(workflow): spawn compensations under an id the engine accepts

The Workflows engine validates an instance id on `create` before it does anything
else: at most 100 characters matching `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. `:` is not in
that class, so `ctx.parallel`'s group-saga rollback — spawned as
`<childId>:compensate` — was rejected on every attempt, in every deployment. The
rejection is not a duplicate-instance error, so the durable step burned its whole
retry budget, the catch in `compensateCompleted` logged it and moved on, and the
group failed with the completed branches never rolled back. A `chargeCard` branch
with `compensateWith: "refundCard"` took the money and refunded nothing.

The five unit tests hard-coded the `:compensate` id against a `create` double that
accepted any string, and the workerd smoke never spawns, so nothing caught it. The
double now applies the engine's own id check, and a new test asserts that every id
the package mints from a Cloudflare-shaped parent — children and compensations
alike — satisfies that grammar, so a future suffix carrying a `:` fails there.

Only the suffix is ours to constrain. The parent id it is appended to belongs to
the host, and `@lunora/platform-node` runs this same orchestrator on
`@visulima/workflow`, whose `generateRunId` mints `<definitionId>:<uuid>` and
accepts no override. A test pins that a host-issued parent id the Cloudflare engine
would refuse still fans out and compensates, so the Cloudflare grammar stays in the
assertion that belongs to Cloudflare rather than leaking into the portable path.

Also in this change:

- `ctx.parallel` reads an attached child's terminal `status()` instead of waiting
  for an event that has already been consumed. `instance.restart()` on a parent
  that had fanned out wipes the parent's step cache AND its event map, so the
  re-run spawn steps re-attach to children that already signalled; the joins then
  hibernated for the branch timeout (24 hours by default) and failed the group with
  the finished children's results sitting unread on their handles. The status read
  costs nothing on a first spawn — only the attach path performs it — and also
  recovers a join whose signal was lost for any other reason.

- `isDuplicateInstanceError` no longer misses an `already_exists` spelling. The
  predicate cannot be pinned against a live engine (miniflare never rejects a
  duplicate create at all, so the attach branch is unreachable under workerd), and
  the test now records why along with the separator variants it does defend.
* a group-saga compensation instance is now created as
`<childId>-compensate`, not `<childId>:compensate`. Nothing could observe the old
id — the engine rejected it — but an app that derived the name itself must update.
The `lunora:spawn:*` durable step now memoizes a branch outcome rather than the
child id; a parent already in flight replays the old string and joins as before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix(container): key the readiness gate on the run, not on onStop

`lunoraReadiness` was cleared only in `onStop`, but the base reaches that hook
solely through `syncPendingStoppedEvents` — which `start()` never calls (only
`startAndWaitForPorts`, `stop()` and the alarm loop do), while the monitor callback
that observes a container exit merely records the state. So an explicit `start()`
inside the up-to-three-minute window before the next alarm found the finished run's
settled gate and returned early, skipping BOTH `armHardTimeout` and the `readyOn`
probes: run 2 had no hard timeout at all and was proxied to before it reported
ready. The hard timeout's own SIGTERM lands squarely in that window, so the
runaway-cost backstop disarmed itself on the way out.

The mirror case is why "always re-arm" is not the answer: a no-op `start()` on an
already-running container — an isolate recycled under a live run, or a periodic
"ensure started" call — begins no new run, and re-arming stamped a fresh generation
that orphaned the live schedule row and pushed the total-lifetime cap out
indefinitely.

Both now hang off one synchronous observation taken before anything is started:
the container was not running (a new run — drop the old gate, arm, probe) or it was
(no new run — probe for this isolate, leave the armed schedule alone). Read before
any await, so two concurrent starts of a stopped container still share one gate.
The two sites that drop a failed gate are identity-checked, so a gate failing late
for a run that has since ended cannot discard the current run's.

The existing test called `onStop` by hand between the two starts, encoding exactly
the assumption that does not hold; it now lets the run end the way the base does.
The start double stubs both entry points and flips the container's `running` flag
the way `doStartContainer` does, so a no-op start is distinguishable from a first
start.

Also in this change:

- `startAndWaitForPorts()` resolves the Secrets Store env. It was the only start
  entry that did not, despite being the path `containerFetch` routes through and the
  one an app can call itself; `doStartContainer` reads `this.envVars`, so a container
  started that way booted without its `secretsStore` values. Resolution moves out of
  `containerFetch`, which now performs it only when a start is actually needed.

- `hardTimeout` is documented as what it is. `stop()` sends SIGTERM and does not
  escalate to `destroy()`, so a container that traps or ignores the signal outlives
  its cap; the docs promised it would "never run longer than an hour, busy or not".
  The hook docblock names the escalation an app can add.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* build: regenerate the lockfile against the released manifest versions

`alpha`'s release commits bumped `@lunora/observability` to alpha.56 and
`@lunora/platform-cloudflare` to alpha.32 without updating `pnpm-lock.yaml`, so
every CI job fails in its setup step: the workflows install with
`--frozen-lockfile`, which refuses a lockfile whose specifiers disagree with the
manifests. That turns roughly a dozen checks red at once, including both
required ones, for reasons that look unrelated to the change under review.

Regenerated rather than hand-edited — a text-merged lockfile passes locally and
fails on the merge ref CI actually builds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* test(flags): reword a comment that tripped the secret-entropy rule

The literal env-var reference in the new test's comment reads as a high-entropy
string to `no-secrets`, which fails `lint:eslint` at --max-warnings=0. The
comment says the same thing without spelling the identifier.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* fix: close the id, run-identity and provisioning gaps left open

`ctx.parallel`'s group-saga rollback was still unreachable, gated on length instead of the colon.
The engine's create-time id check tests `id.length > 100` BEFORE the character class, and a branch
id is caller-controlled right up to that ceiling — an explicit `branch(…, { id })`, or a derived
`<parentId>-c<n>` under a long host-issued parent. Adding `-compensate` puts the rollback over it,
`create` rejects, `compensateCompleted` logs and continues, and a completed branch that took payment
is never refunded. An over-long compensation id now folds back under the ceiling, keeping a digest
of the whole child id and the readable suffix. The regression test's short synthetic parent only
ever exercised the character class; it says so now, and a 90-character branch id covers the rest.

`codeTool` and `agent.asTool()` could never be used together. `codeTool` gives each script step a
tool-call id of `${toolCallId}:${step.id}` and takes any tool in its map, so `agentAsTool`'s
`sub-<name>-<toolCallId>` carried a colon into `create`, which rejects it — not as a duplicate, so
it rethrows and the per-step `step.do` burns its retries. The call id is hashed into the instance id
now (the thread key still carries it raw), and the docblock that called this "a note for whoever
changes the shape, not a live hazard" is gone. The agent binding double applies the engine's own id
check, which is what let this pass unnoticed.

The attach path returned a child's outcome straight into the durable step cache while only the event
path bounded it. Both channels cap at 1 MiB, and a step return the host cannot serialise aborts the
instance rather than failing one branch, so the attach path bounds it the same way.

Provisioning was reachable only through `validateWrangler`. `reconcileBindingsSafely` lived in the
wrangler validator's `config` hook, so turning the CHECKS off — an option whose name promises
nothing about writes — took the write back out of `config`, and the Cloudflare plugin parsed
`wrangler.jsonc`, and `remoteBindingsPlugin` copied it, before the binding existed: the exact
missing-`env.DB` boot that hook was moved to fix. It is its own unconditionally registered plugin
now, still `enforce: "pre"` and still ahead of the remote-bindings copy.

A re-entrant Vite `config` pass left `configPath` naming a deleted file: cleanup unlinked temp A, a
new plan wrote temp B, and `withRemoteBindings` read the A still on the options object as a
user-supplied path and returned unchanged. The plugin tracks what it injected, so only a path it did
not write counts as the user's.

The container's `beginStart()` snapshot was a TOCTOU across two awaits — a Secrets Store RPC, and
the base's own pre-start work. A container exiting in that window let a new run start with
`wasRunning === true`, so the hard timeout was never armed and (via `start()`) the readiness probes
were skipped too: run 2 ran uncapped and was proxied to before it reported ready. The snapshot moved
past the secrets resolution, and an `onStop` observed ACROSS the base call now demotes it. What
remains uncovered is an exit inside `start()`'s own base call, which never syncs pending stop
events — documented on `beginStart`, along with the hard timeout being a one-shot signal that
nothing re-sends to a container ignoring SIGTERM.

Docs and comments that overstated a guarantee: the mail queue recipe promised exactly-once for a
mark written after the send and read from an eventually-consistent store; `register()`'s owner guard
hard-fails browser account switching, because `subscribeToPush` reuses the browser's subscription
and every account derives the same id, so the README now makes the sign-out `unregister` part of the
recipe rather than an aside; the half-open breaker lets through every send already in flight, not
"exactly one"; `isPermanentFailure` is channel-less as well as kind-less and now governs retry for
chat/webhook/inApp; the duplicate-instance matcher is unreachable LOCALLY, not in production, which
is why `createOrAttach` exists at all.
* `flagshipProvider({ authToken: "" })` now throws at construction instead of
evaluating flags against their checked-in defaults — a deployment reading an unset secret straight
off `env` fails to boot rather than failing closed in silence. Omit `authToken` for an
unauthenticated endpoint, or pass a thunk. A sub-agent child run's instance id is now
`sub-<name>-<digest>` rather than `sub-<name>-<toolCallId>`, so a run in flight across the upgrade
starts a second child instead of re-attaching.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

* chore(deps): regenerate the lockfile after merging alpha

The merge took the branch's lockfile, which still carried the released-version
specifiers the new root overrides replace.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VUuYamsU1YLmAQhtut9PLZ

### Bug Fixes

* make saga compensation, container restarts and push ownership actually work ([#592](https://github.com/anolilab/lunora/issues/592)) ([6fae07a](https://github.com/anolilab/lunora/commit/6fae07a056a6c93fea1fc11aa88c8d35ee031019))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.157
* **@lunora/container:** upgraded to 1.0.0-alpha.44
* **@lunora/seed:** upgraded to 1.0.0-alpha.107
* **@lunora/studio:** upgraded to 1.0.0-alpha.153

## @lunora/config [1.0.0-alpha.189](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.188...@lunora/config@1.0.0-alpha.189) (2026-09-04)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.156
* **@lunora/seed:** upgraded to 1.0.0-alpha.106
* **@lunora/studio:** upgraded to 1.0.0-alpha.152

## @lunora/config [1.0.0-alpha.188](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.187...@lunora/config@1.0.0-alpha.188) (2026-09-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.154
* **@lunora/container:** upgraded to 1.0.0-alpha.42
* **@lunora/studio:** upgraded to 1.0.0-alpha.150

## @lunora/config [1.0.0-alpha.187](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.186...@lunora/config@1.0.0-alpha.187) (2026-09-03)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.153
* **@lunora/seed:** upgraded to 1.0.0-alpha.104
* **@lunora/studio:** upgraded to 1.0.0-alpha.149

## @lunora/config [1.0.0-alpha.186](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.185...@lunora/config@1.0.0-alpha.186) (2026-09-03)

### Bug Fixes

* audit rounds 14-16 ([#586](https://github.com/anolilab/lunora/issues/586)) ([6a09b74](https://github.com/anolilab/lunora/commit/6a09b746cfc9fb36f451c208b7a1c3eac16e56f4))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.152
* **@lunora/seed:** upgraded to 1.0.0-alpha.103
* **@lunora/studio:** upgraded to 1.0.0-alpha.148

## @lunora/config [1.0.0-alpha.185](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.184...@lunora/config@1.0.0-alpha.185) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.151
* **@lunora/container:** upgraded to 1.0.0-alpha.41
* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/seed:** upgraded to 1.0.0-alpha.102
* **@lunora/studio:** upgraded to 1.0.0-alpha.147

## @lunora/config [1.0.0-alpha.184](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.183...@lunora/config@1.0.0-alpha.184) (2026-09-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.150
* **@lunora/seed:** upgraded to 1.0.0-alpha.101
* **@lunora/studio:** upgraded to 1.0.0-alpha.146

## @lunora/config [1.0.0-alpha.183](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.182...@lunora/config@1.0.0-alpha.183) (2026-09-02)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.149
* **@lunora/container:** upgraded to 1.0.0-alpha.40
* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/seed:** upgraded to 1.0.0-alpha.100
* **@lunora/studio:** upgraded to 1.0.0-alpha.145

## @lunora/config [1.0.0-alpha.182](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.181...@lunora/config@1.0.0-alpha.182) (2026-09-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.148
* **@lunora/container:** upgraded to 1.0.0-alpha.39
* **@lunora/errors:** upgraded to 1.0.0-alpha.28
* **@lunora/seed:** upgraded to 1.0.0-alpha.99
* **@lunora/studio:** upgraded to 1.0.0-alpha.144

## @lunora/config [1.0.0-alpha.181](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.180...@lunora/config@1.0.0-alpha.181) (2026-09-01)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.147
* **@lunora/seed:** upgraded to 1.0.0-alpha.98
* **@lunora/studio:** upgraded to 1.0.0-alpha.143

## @lunora/config [1.0.0-alpha.180](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.179...@lunora/config@1.0.0-alpha.180) (2026-09-01)

### ⚠ BREAKING CHANGES

* `ctx.scheduler.runAfter` and `runAt` resolve the bare job id
instead of `{ id, scheduledFor }`. Four gates — the type, the docs, the
platform contract and the generated surface — already said `Promise<string>`;
only `@lunora/scheduler` resolved an object, and the install is a cast, so
nothing caught the disagreement. `scheduler-host.ts` assembles the platform
contract's `ScheduledJob` from the instant it already computed, so no
information is lost. The one in-repo call site is updated.

`@lunora/ai`'s default model and embedding model were settable only through
options codegen does not thread, so an app could not change either. Both now
read `LUNORA_AI_DEFAULT_MODEL` / `LUNORA_AI_DEFAULT_EMBEDDING_MODEL` from
`env`, the seam codegen does thread, mirroring the existing
`LUNORA_AI_GATEWAY_*` convention; explicit options still win.

`SocketHost.idFor` is kept but its doc no longer claims the engine uses it to
reassociate a rehydrated socket — per-socket state is keyed on the handle
object and durable identity is the engine's own `connectionId`. It is the
conformance suite's identity oracle in 8 legs, which is a real consumer.

* fix(codegen): scan the worker entry so the security lints can fire

Five ERROR-level advisor lints could never fire. `listLunoraSourceFiles`
recurses only `lunora/`, but `createBrowser`, `createPayment` and
`createInboundEmailHandler` are called from the worker entry under `src/`,
so `discoverConfigCalls` found nothing and every lint keyed on it returned
clean regardless of the code. `mail_inbound_dispatch_without_verify`,
`payment_create_without_authorize`, `browser_allow_private_targets`,
`export_sink_misconfigured` and `browser_user_url_without_allowlist`'s
suppression arm are now live.

The fix is a second, explicitly-scoped walk rather than widening the
existing one: `listLunoraSourceFiles` also feeds `refreshCodegenProject`'s
add/remove reconciliation, which drops Project files under `lunoraDirectory`
that vanished from disk, so widening it globally would have changed that set
too. Only `config-calls.ts` and `export-sinks.ts` are switched over.

`apps/playground`'s inbound email handler declares no `verify`, so it now
produces a real ERROR advisory — which is the point, but it will surprise a
gate until it is fixed.

Also inert: the umbrella's `lunorash/flags/flagship` specifier was not in the
flagship provider set, so an app importing through the umbrella got no
binding inference; and `fsTool` never registered the sandbox dispatcher, so
declaring it produced an app whose tool had nothing to dispatch to.

`constraint_validator` is kept — `runAdvisor`, the lint and
`AdvisorTableSample` are all public API and the README's example is a caller
passing its own samples. What was false was the claim that the studio feeds
it: `LintContext.tableSamples` said the studio "reads up to the configured
row cap from each table via readTablePage", which nothing does. Building a
feeder needs a bounded-sample admin read that does not exist, so the docs now
state there is no shipped feeder rather than implying one.

The generated Drizzle schemas were documented nowhere despite
`@lunora/server/drizzle` existing as a published subpath whose own docs point
at them; they now have a section explaining the global/shard split.

* fix(templates): stop scaffolding insecure cookies and a shared rate-limit bucket

`templates/expo` set `AUTH_URL: "http://localhost:8787"` in wrangler's
`vars`, which is baked into the deployed Worker. better-auth derives
`useSecureCookies` from that URL, so every project scaffolded from this
template shipped session cookies without `Secure` in production. The value
moved to `.dev.vars.example`; unset, better-auth resolves per request and the
weak-secret guard throws. The README was actively instructing users to put it
in `vars`.

All 12 non-expo templates keyed their rate limiter
`(ctx) => ctx.auth.userId ?? "anon"`, so every unauthenticated caller shared
one bucket — one client could exhaust it for all of them. Now
`ctx.auth.userId ?? ctx.ip ?? "anon"`, verbatim from the advisor lint that
prescribes it. The hand-rolled inline limiter is replaced by the copy-in
`lunora/ratelimit/schema.ts`, whose `limits` map was previously dead config:
its only key was never read, so tuning it did nothing.

`templates/expo` had no `imports` map, so `lunora registry add` produced
files importing `#lunora/_generated/server.js` that could not resolve.

In examples: `auth-playground`'s document list claimed membership isolation
in a comment while reading every row for an organization the caller merely
named; the index now pins the equality prefix to the session's own ownerId.
A procedure context deliberately carries no raw Headers, so `getActiveMember`
is unreachable from a query — the doc says so and points at the httpAction
recipe rather than implying a check that cannot happen.

`blog`'s cron was documented but never wired: no `crons.ts`, no trigger, and
`scheduled()` was never exported, so it would have fired into nothing even
once declared. Its `drafts.save` patched any id the client sent, which is an
IDOR; it now re-reads and checks the author, returning an indistinguishable
NOT_FOUND. Its bare `Error` throws were becoming redacted 500s rather than
the 401s they read as. The unused `users` table carrying a `passwordHash`
column is gone — shipping a second, empty credential store teaches worse
than losing the `.global()` demo, and the README now points at `team-chat`
for that.

* fix(playground): take the message author from the verified identity

`lunora/mutators.ts` accepted `userId` as an argument and wrote it verbatim
as the author, so any caller could post as any user. It is publicly
dispatchable — codegen registers `mutators:sendMessage` and exposes it on the
`api` proxy — so this was not a local-only path. Fixed with the framework's
existing control, `owner: "userId"` on `defineMutator`, which requires a
verified identity, rejects a mismatched argument, and overwrites the column
before the authoritative impl runs.

The same path also bypassed `messages.send`'s rate limit and its 4096-char
cap by pushing an identical row through a second entry point; both now match.

`apps/studio` read `VITE_LUNORA_ADMIN_TOKEN` unconditionally, so a production
build inlined an admin bearer token into a shipped bundle. The neighbouring
`baseUrl` was already gated on `import.meta.env.PROD`; the token now sits
behind `import.meta.env.DEV`, which is statically false in a production
build, so the variable is never read and cannot be inlined.

The signed-upload content-type check ran only when the URL had pinned one,
so an unpinned URL accepted any content type — the guard is unconditional
now, and the e2e helper forwards `contentType` so it can still mint a usable
pinned PUT.

`seedKv` stays a public action deliberately. Making it internal was
considered and would have stranded it with no caller at all: the internal
gate reads `x-lunora-system`, set only by scheduler/cron/queue dispatch,
while the Studio runner and `lunora run --as` both re-enter through the
ordinary RPC path. It takes no caller input — fixed values at six fixed keys
— so the exposure is resetting demo data. The docstring records why, and
warns that a seeder writing caller-supplied keys must not copy the shape.

Deletes a 443-line throwaway spike the file itself labelled as such.

* docs: make the non-callable examples callable and correct the wrong claims

Nineteen snippets across the concept docs used the object form
`query({ args, handler })`, which is not callable — the same page set's
migration guide says so explicitly. Every one is now the chainable builder
form the code actually exposes.

The Hyperdrive recipes assigned `ctx.sql = …`, which does not work: the
facade is wired by codegen from the app's config, not assigned in a handler.
The caching page hand-rolled 110 lines of cache bookkeeping that
`defineActionCache` does in three.

Corrections where the prose was simply false: the payment integration
claimed 12 tables where it creates 5; the read-replica page described
fallback behaviour the implementation does not have; and the offline-first
page contradicted the `.meta()` documentation this round introduced.

`packages/hyperdrive`'s README documented "Tagged-template queries" and
"Unsafe / raw queries" sections for APIs that do not exist —
`fromPostgresJs()` returns a `SqlClient` whose only member is `query(text,
params)`; `.unsafe()` belongs to the raw postgres.js client it wraps.

`sdks/python`'s `stable_stringify` docstring was the last copy of the
"code-point order" claim; the sort is UTF-16 code-unit order, which its own
`_utf16_sort_key` already implemented correctly.

* fix(examples): sort the expo manifest after adding the imports map

The `imports` map that lets `lunora registry add` resolve
`#lunora/_generated/server.js` was inserted in the wrong position.
Key order is enforced by one CI job that nothing else covers.

* style(client): satisfy the lint rules the new code tripped

Mostly mechanical, but two are real changes rather than suppressions.

The deferred-close WebSocket double added for the teardown regression test
duplicated the shared one except for a single method, which sonarjs
correctly flagged twice. The shared double now takes a `deferClose` flag and
the copy is gone. Verified the test still fails with the teardown fix
reverted, so the consolidation kept its diagnostic power.

The offline-flush barrier chained off `.then()` without returning a value.
It is a sequencing barrier with nothing to pass along, so it is an async
IIFE now — no rule to satisfy, and it reads as what it is.

The stream drain discarded its chunks into an unused binding; it collects
them and asserts the torn-down stream yielded none, which is the property
the test is actually about.

The remaining jsdoc/no-secrets disables follow the convention already used
in `@lunora/advisor` and `@lunora/codegen`: intentional bullet lists, and
back-ticked identifiers in prose that the entropy heuristic reads as
credentials.

* docs(scheduler): correct the three places still destructuring the old return

`runAfter`/`runAt` resolve the bare job id now, so `const { id } = await
ctx.scheduler.runAfter(...)` binds `undefined`. The package README and the
`lunora-setup-scheduler` CLI skill both taught exactly that, and the skill
also stated the old `{ id, scheduledFor }` shape in prose.

These are the siblings of the call site that was already fixed —
`docs/index.mdx` was updated with the signature change and its neighbours
were not.

* style(server): drop the now-redundant casts on the middleware context

`validateArgs` already returns `Record<string, unknown>`, so the two
`parsed as Record<string, unknown>` assertions at the `withCallContext`
call sites became unnecessary once it took `parsed` directly.

* fix(client): model the browser's asynchronous close in the shared socket double

The double dispatched `close` synchronously inside `close()`, which no browser
does. That hid a whole class of teardown-ordering bug from all 148 tests using
it: `teardownConnection` clears `conn.socket` AFTER calling `close()`, so a
same-tick event still found the identity guard satisfied and reached
`handleDisconnect`. The teardown regression test added earlier in this branch
had to opt into deferred close to see its own bug — which left the unfaithful
behaviour as the default for everything else.

Deferred close is now the only behaviour. Flipping it turned four tests red,
and all four were the double's fault rather than the code's: `readyState` must
flip synchronously (a browser sets it before returning from `close()`) while
only the EVENT is deferred. Fixed there; 783 pass.

Verified the teardown regression test still fails with its fix reverted, so
consolidating on one double did not cost it its teeth.

Also from review:

- `resolveRunnableTargetOrThrow` was written twice — once in the CLI, once in
  the Vite plugin — with two hand-written messages that would drift. The
  predicate is a property of the driver registry, not of either tool, so
  `isRunnableTarget`/`runnableTargetIds` now live in `@lunora/config` beside
  `resolveTargetOrThrow`, whose own docblock already argued the Vite plugin
  needs the same guard. Both callers keep their own wording; neither keeps its
  own logic.

- `check-project-json-targets.js` floored only its TOTAL count, so a declared
  workspace group that exists but holds no members passed vacuously while its
  two sibling checks failed. Floored per group, on member directories rather
  than on `project.json` files — not every member has one, by design.

- `WORKER_ENTRY_ROOTS` claimed to mirror `@lunora/config`'s
  `WORKER_ENTRY_FALLBACKS` and does not. Kept separate deliberately — one picks
  THE entry file, the other decides what a security lint may see, and equal
  lists would be wrong for one of the two jobs — but the comment now says that
  instead of inviting the reader to assume equality.

- Two `{@link}` targets are qualified, which removes the need for the
  `jsdoc/no-undefined-types` half of a suppression.

* fix(client): restore follower subscribe, and reset backoff on a frame-less socket

Two regressions this branch introduced, both found by review.

**`crossTabSync` was broken for every follower tab.** `subscribe()` was added
to the leader-only guard on the reasoning that a follower's subscribe "reached
the server only when the leader happened to hold the same
`(fn, args, shardKey)`". That is not an accident — it is the mechanism. The
follower's registration is what puts a `SubscriptionState` in
`this.subscriptions`, and `onSubscriptionData` drops any broadcast whose key it
cannot find there. Guarding it did not make a silent failure loud; it made the
leader's entire broadcast path dead code and threw `NOT_IMPLEMENTED`
synchronously out of every `useQuery`, `useInfiniteQuery`, `@lunora/db`
collection and svelte `query` in every non-leader tab.

`subscribeShape`, `whisper*`, `setConnectionContext` and
`acquireConnectionContext` genuinely have no relay path and keep their throws.

The existing follower tests could not catch this: each calls `subscribe()`
without any other tab announcing leadership, so the client is still inside its
startup claim window and the guard never fires. The new test establishes the
leader FIRST, then subscribes, then asserts the broadcast is delivered —
re-adding the guard turns it red.

**A socket that receives no JSON frame never reset its reconnect backoff.**
Moving the reset off `onOpen` was right (an upgrade is accepted before the
credential is read, so resetting there turns a lapsed token into a storm), but
"first non-error frame" is unreachable for some clients: the server sends no ack
for the `connect` envelope, and the keepalive pong is a plain string answered by
the runtime without waking the DO, so `JSON.parse` rejects it before the reset.
A whisper sender, a presence-only client, or any `ensureSocket` warm-up with no
active subscription therefore doubled its delay on every blip with nothing ever
resetting it, parking a healthy connection at the 30s cap.

Surviving a 5s window is now the second proof of acceptance — a rejected
credential closes 4001 well inside it, and that path clears the timer. The test
covers both directions: a socket held open past the window reconnects at the
initial delay again, and one closed at 100ms does not.

**`apps/playground` could not build.** The worker-entry scan added earlier in
this branch makes `mail_inbound_dispatch_without_verify` fire on an inbound
handler that really does dispatch spoofable mail into a function running with
the admin bearer and RLS off. `vite build` fails unconditionally on an
ERROR-level advisory, and `lint:types` fails under CI only — which is why the
pre-flight gate run reported green. Added the `verify` gate the lint asks for:
DMARC pass, or SPF and DKIM both passing. Fails closed, since a `null` verdict
means the receiving MX stamped no `Authentication-Results` header at all.

* fix(codegen): type the emitted scheduler config so the compiler guards the install

The scheduler return type had drifted from `Promise<string>` across four gates
with nothing failing, and the fix earlier in this branch corrected the type
while leaving the mechanism intact: the emitted config field was
`(env) => unknown`, which forced `as SchedulerLike` at all four use sites and
made the compiler blind to exactly this class of drift. The field now carries
`SchedulerLike`, the casts are gone, and the next disagreement is a build
error. Golden fixtures and all 13 example `_generated` trees regenerated.

Also from review:

- The registry's new auth and target guards threw bare `Error`, which the
  templates commit in this same branch identified as becoming a redacted 500.
  An unauthenticated caller was told the server had faulted. They are coded
  now: `UNAUTHORIZED` for the auth gate, `BAD_REQUEST` for a malformed or
  non-`https:` URL, `FORBIDDEN` for a host outside the allowlist. The
  missing-binding throws stay bare — a misconfigured deployment IS a 500.

- `@lunora/container` telemetry is batched now, so nothing leaves the process
  until a timer elapses or `flush()` drains it. Every emit used to be its own
  POST, so an existing job that exits promptly without flushing went from
  reporting everything to reporting nothing. `flush()` is documented as
  required rather than as an optimisation, including the oldest-first drop at
  the item cap.

- `examples/auth-playground` memoised the init PROMISE, so one failed
  cold-start migration was replayed to every later request for the isolate's
  life with no path back. Cleared on failure so the next request retries.

- The SDK port-discovery gates treated every directory under `sdks/` except
  `smoke` as a port, so a stray `node_modules` or `.venv` would have failed
  both permanently on a difference that is not a missing port. Anchored on the
  README every real port ships. Demonstrated both ways: a stray directory no
  longer trips it, a genuine new port still does.

- `discoverSandboxUsage` drove its scan from `TOOL_FLAGS` but kept a
  hand-written conjunction for the early break; that is the third flag waiting
  to be forgotten, so it reads the table too.

- `registry/tsconfig.json`'s exclusion rationale had grown to a ~1,100-character
  JSON string — unwrappable, unreadable in review, unlintable. Moved to
  `registry/TYPECHECK.md` with a pointer left behind.

- Noted in `withCallContext`'s JSDoc that every builder procedure now receives a
  cloned context, not only those declaring `.meta()`.

* revert(codegen): keep the scheduler config field untyped, and record why

Typing the emitted `scheduler?: (env) => …` field as `SchedulerLike` — so the
compiler would guard the seam the `Promise<string>` drift slipped through —
does not compile. `@lunora/scheduler`'s public `Scheduler.runAfter`/`runAt` are
generic with a REQUIRED `args`, while `SchedulerLike` takes it optional, so a
function needing three parameters is not assignable to one callable with two.
Every app that calls `createScheduler` directly fails, `apps/playground` and
`examples/blog` among them.

So the `as SchedulerLike` cast was not a loose annotation over two agreeing
shapes; it was hiding a real incompatibility between the scheduler package's
public type and what the DO accepts. Reconciling those two signatures is the
fix, and it is an API change to `@lunora/scheduler` rather than a cast removal.

Reverted to `unknown`, with the exact cause written at the field so the next
reader learns why the cast is there instead of rediscovering it. The
`Promise<string>` correction itself stands — that was the actual defect.

Adds `isRunnableTarget` / `runnableTargetIds` to the `@lunora/config` snapshot.

* fix(client): keep the framework-called follower surfaces inert instead of throwing

A second review pass over the fixes the first one prompted. Its highest finding
is the same shape the branch keeps producing: the earlier commit un-guarded
`subscribe` because a follower's registration is what the leader's broadcast is
matched against, and stopped there. `acquireConnectionContext` and
`subscribeShape` are not app-level calls — all five `usePresence` adapters
(react, vue, svelte, solid, angular) call the first from a component effect, and
`@lunora/db`'s shape-backed `createCollection` calls the second from its sync
path. Neither is something an app can opt out of, so the guard threw
`NOT_IMPLEMENTED` out of an effect and unwound the entire tab to an error
boundary. Before this branch presence merely failed to update.

Both are inert on a follower now. The loud throw is kept for `whisper`,
`whisperSubscribe` and `setConnectionContext`, which no first-party package
calls — those are app code, which can handle a failure.

`@lunora/agent`'s inbound handler had the same call-site-vs-layer problem with
a security edge: it built `createInboundEmailHandler` with no `verify` and
`AgentEmailTarget` gave apps no way to add one, while its own header instructs
mappers not to trust `email.from`. A claimed message starts a durable run whose
tools execute RLS-bypassed, so the gate now runs before any mapper — the same
fail-closed DKIM/SPF/DMARC check the playground got. The advisor lint could
never have caught this: it scans user projects, not this repo's sources.

Also from the pass:

- `runnableTargetIds` repeated the predicate `isRunnableTarget` defines, five
  lines below it, in the commit whose purpose was removing that duplication.
  Both moved to `driver-registry.ts`, beside the registry they query rather than
  in the module that reads `lunora.json`, and `isRunnableTarget` answers `false`
  for an unregistered id instead of throwing.
- Three registry JSON files had every em dash rewritten to `—` and their
  arrays exploded by a serializer that was not the repo's Prettier, mangling
  user-facing `description` copy. Restored.
- The emitted `scheduler?:` docblock carried a ~600-character maintainer
  post-mortem into every user's `_generated/shard.ts`. One sentence there now;
  the explanation lives in `emit.ts` where maintainers read it.
- The SDK README marker added last round NARROWED the gate it was meant to
  protect: a new port shipping without a README was invisible to discovery AND
  absent from the list, so no drift fired. Replaced with an explicit ignore
  list — a non-port directory costs one deliberate line, anything else fails.
- `examples/auth-playground` still memoised a rejected promise if `buildAuth`
  threw, one line above the fix for exactly that.
- The browser item echoed the rejected hostname back to the caller, letting an
  authenticated caller enumerate `ALLOWED_RENDER_HOSTS` by probing. Logged
  server-side, generic to the client.
- `clearConnectionTimers` replaces three copies of the same clear block across
  two teardown paths, so a fourth timer cannot be half-remembered.
- Comment trimming where the prior review's "rationale as changelog" note
  applied again, and a `jsdoc/check-indentation` suppression deleted by removing
  the list that needed it.

* perf(server): skip the per-call context clone when no middleware can read it

CodSpeed flagged 15 regressed benchmarks on this branch, all in
`packages/server`, with `N=0: no .use (dispatch floor)` down 21.5% — a
procedure with no middleware at all. That is the tell: `withCallContext`
was cloning the dispatch context on every call, where the previous
`withMeta` cloned only when `.meta()` was declared.

`ctx.args` and `ctx.meta` exist for `.use()` steps to read; a handler already
receives `args` as its own parameter. So a procedure with no middleware and no
meta is handed the dispatch context unchanged.

Measured locally rather than inferred from the instruction-count delta:

  N=0 dispatch floor   3.06M -> 4.37M ops/s   (1.43x)
  empty args           3.06M -> 4.43M ops/s   (1.44x)
  single id arg        2.71M -> 4.04M ops/s   (1.49x)

Procedures that DO declare middleware still pay the clone, and that cost is
real — it is what makes `ctx.args` reach a `.use()` step, which is what fixed
`emailGateMiddleware` and `verifyTurnstileMiddleware` throwing FORBIDDEN on
every call. Prototype delegation would avoid the property copy, but
`@lunora/auth`'s own docs teach `next({ ctx: { ...ctx, … } })`, and a spread
drops inherited properties — so the full clone is required for correctness.

* test(vite): cover the runnable-target guard

Codecov put `packages/vite/src/index.ts` at 66% patch coverage: the guard
that stops `vite build --target node` running the Cloudflare pipeline had no
test at all. Verified the two positive cases fail with the guard reverted.

* ci: keep CodeRabbit under its file cap so it reviews the code at all

CodeRabbit skipped this PR entirely — "116 files, 16 over the limit of 100" —
so a change touching every package got no automated review. The cap counts
files that survive `path_filters`, and 44 of those were markdown.

Excluded two kinds that cost review budget without earning it:

- `**/CHANGELOG.md` — semantic-release writes them; reviewing generated
  release notes is noise.
- `**/docs/**` — the long-form prose docs under `packages/*/docs/` and
  `apps/docs/src/content/`.

That brings the reviewable set to 92. READMEs stay in deliberately: they are
what a user reads first, and a wrong snippet there costs the most — this
branch fixed several.

The trade is explicit. Prose review is worth less than code review, and the
previous setting bought neither: over the cap, CodeRabbit reviews nothing.
* `useFlag`, `useFlags`, `createFlag`, `createFlags` and `flag`/
`flags` no longer take a targeting `context`, and `FlagContext` is no longer
exported. Any call passing one was passing a value the server discarded.

`react-native.api.md` drifts too: it re-exports `@lunora/react` wholesale, so it
carried a `FlagContext` row nothing would think to look for.

* refactor(runtime): stop exporting four symbols nothing outside them uses

Audited as "dead exports". Only one was dead code; the other three have live
in-file callers, so it was the EXPORT that was unused, not the function — and
deleting them would have broken working paths. `readShardKey` is the only thing
that reads `?shardKey=` / `x-lunora-shard-key` for REST dispatch;
`exportShardTable` is what `exportShardRows` delegates to per table;
`hydrateDocsById` is the `IN (...)` hydration that keeps `computeRankPage` off
an N+1. All three are now module-private.

`DEFAULT_LOG_LIMIT` was genuinely dead: a public alias of the module-private
`DEFAULT_LIMIT = 500` that nothing read except one `{@link}`. Deleted, and the
`PipelineLogQuery.limit` doc states the default literally instead of linking a
symbol that no longer exists.

Also removes an unreachable diagnostic in the advisor command. It printed
"advisor evidence unavailable — codegen ran with linting disabled" when
`advisorContext` was undefined, which requires `CodegenOptions.lint` to be set —
and that option is set at 47 call sites, every one of them inside codegen's own
tests. No production caller passes it, so the branch could not run. Deleted
rather than given a `--no-lint` flag to justify it: a user running `lunora
advisor` wants the advisor evidence by definition. The option stays for library
callers.

* fix(codegen): gate `.commitOrdered()` against the target's capability matrix

`commitOrderedTables` was rated in every platform capability matrix and read by
nothing. A host rating it `unsupported` emitted the full `.commitOrdered()`
surface with no diagnostic and silently dropped the ordering guarantee — which
is the only thing that feature is.

Promoted to a real `PlatformSignals` entry, read off the same IR that already
feeds `globalTables`, so an unsupported rating now emits
`platform_unsupported_feature` at codegen time. The test fails without the
signal key wired in.

`@lunora/platform`'s docblock called this "the outstanding case"; it now records
that it was promoted, and that `memoryTables`, `objectStorageBackups` and
`objectStorageCdcArchive` remain unpromoted instances of the same shape — rated
in every matrix, consulted by nothing.

* fix(examples): re-bless the five schema baselines that reported deploy drift

`feedback-board`, `team-chat`, `kanban-board`, `chess` and `tanstack-start` all
call `.extend(ratelimit.extension)` but their committed
`lunora/.lunora-schema.json` had no `ratelimit_buckets`, so `lunora deploy`
reported drift on each. Refreshed through the documented path.

Two of them carried more than the ratelimit drift, and re-blessing accepts it:
`kanban-board` had a required `tasks.status`, `chess` had `games.drawOfferedBy`
and `lobbies.guestId` widening `string -> union`. Both were pre-existing and
breaking; naming them here beats letting them ride in silently.

`--update-schema-baseline` was reported as crashing with "Cannot read properties
of undefined (reading 'filter')". It does not, under any condition that could be
constructed — a refactor wrapped every reconcile step in try/catch, so a
TypeError there now surfaces as a warning rather than killing the command, and
the likely original home (`DeployDriver.provision`) is dead code no CLI path
calls. No speculative fix. What the path did lack was any coverage at all, so it
now has an end-to-end test: capture a baseline, age it into breaking drift,
assert `prepare` blocks, assert the flag re-blesses it. Neutering the flag turns
it red.

The rate-limit copy-in paths taught two names for one thing: `registry/ratelimit`
called its only bucket `default` while all 13 templates and all 9 example
schemas use operation-shaped names. Reconciled on `send`. `lunora init`'s overlay
was a third copy — and was internally inconsistent, emitting `default` while the
`LUNORA_MESSAGES` it writes alongside declared `send`.

`.lunora-schema.json` is now Prettier-ignored. `serializeSchemaSnapshot` writes
2-space and Prettier rewrites it to 4, so every re-bless produced a file that
failed `lint:prettier` until someone ran `--write`. The serializer owns that
format and cannot change: its exact output is the input to `hashSchemaSnapshot`,
which is a schema version's identity in the DO's `__lunora_schema_history`
ledger. Ignoring is safe because that hash is taken from the re-serialized
object, never from the file's bytes.

Docs: `plans/README.md` described a deleted playground prototype as a live spike
deliverable, and `protocol/README.md` documented the wire grammar without the
two fixture-schema additions that now drive all eight SDK suites — `reencoded`
(for shapes that are legitimately not fixed points of `encode(decode(x)) == x`)
and `rejected[]`. Two claims those additions falsified are corrected with them.

### Bug Fixes

* close the round-2 package audit findings across registry, protocol, client and CI ([#539](https://github.com/anolilab/lunora/issues/539)) ([e3dd702](https://github.com/anolilab/lunora/commit/e3dd70282af1aff606fe03a4ebd29c33d0029ce5)), closes [#540](https://github.com/anolilab/lunora/issues/540)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.146
* **@lunora/container:** upgraded to 1.0.0-alpha.38
* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/seed:** upgraded to 1.0.0-alpha.97
* **@lunora/studio:** upgraded to 1.0.0-alpha.142

## @lunora/config [1.0.0-alpha.179](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.178...@lunora/config@1.0.0-alpha.179) (2026-08-31)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.145

## @lunora/config [1.0.0-alpha.178](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.177...@lunora/config@1.0.0-alpha.178) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.144
* **@lunora/seed:** upgraded to 1.0.0-alpha.96
* **@lunora/studio:** upgraded to 1.0.0-alpha.141

## @lunora/config [1.0.0-alpha.177](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.176...@lunora/config@1.0.0-alpha.177) (2026-08-30)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.140

## @lunora/config [1.0.0-alpha.176](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.175...@lunora/config@1.0.0-alpha.176) (2026-08-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.143
* **@lunora/seed:** upgraded to 1.0.0-alpha.95
* **@lunora/studio:** upgraded to 1.0.0-alpha.139

## @lunora/config [1.0.0-alpha.175](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.174...@lunora/config@1.0.0-alpha.175) (2026-08-30)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.142
* **@lunora/seed:** upgraded to 1.0.0-alpha.94

## @lunora/config [1.0.0-alpha.174](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.173...@lunora/config@1.0.0-alpha.174) (2026-08-29)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.141
* **@lunora/studio:** upgraded to 1.0.0-alpha.138

## @lunora/config [1.0.0-alpha.173](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.172...@lunora/config@1.0.0-alpha.173) (2026-08-29)

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

### Features

* **cli:** let dev be a participant — readiness signal + binding manifest ([#523](https://github.com/anolilab/lunora/issues/523)) ([5d2c2ab](https://github.com/anolilab/lunora/commit/5d2c2abc56878f9c884115c41731144f6a41fcca))

### Build System

* ship .mjs everywhere and make packem warnings fatal ([#526](https://github.com/anolilab/lunora/issues/526)) ([b3eaacc](https://github.com/anolilab/lunora/commit/b3eaacc5a31fe4634a5f4a6c59fda6fbbc8315e1))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.140
* **@lunora/container:** upgraded to 1.0.0-alpha.37
* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/seed:** upgraded to 1.0.0-alpha.93
* **@lunora/studio:** upgraded to 1.0.0-alpha.137

## @lunora/config [1.0.0-alpha.172](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.171...@lunora/config@1.0.0-alpha.172) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.139
* **@lunora/studio:** upgraded to 1.0.0-alpha.136

## @lunora/config [1.0.0-alpha.171](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.170...@lunora/config@1.0.0-alpha.171) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.138
* **@lunora/container:** upgraded to 1.0.0-alpha.36
* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/seed:** upgraded to 1.0.0-alpha.92
* **@lunora/studio:** upgraded to 1.0.0-alpha.135

## @lunora/config [1.0.0-alpha.170](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.169...@lunora/config@1.0.0-alpha.170) (2026-08-28)

### Bug Fixes

* **cli,docs:** close three gaps in codegen's contract with the build ([#521](https://github.com/anolilab/lunora/issues/521)) ([b38067a](https://github.com/anolilab/lunora/commit/b38067a82f1931a2e1d9fecd399ad091d25a161c))

## @lunora/config [1.0.0-alpha.169](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.168...@lunora/config@1.0.0-alpha.169) (2026-08-28)

### Bug Fixes

* **codegen:** close eight silent-drop gaps in procedure discovery ([#513](https://github.com/anolilab/lunora/issues/513)) ([e393e49](https://github.com/anolilab/lunora/commit/e393e494c0145ad78e0f2b1e27798ed96e7039a3))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.137
* **@lunora/seed:** upgraded to 1.0.0-alpha.91
* **@lunora/studio:** upgraded to 1.0.0-alpha.134

## @lunora/config [1.0.0-alpha.168](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.167...@lunora/config@1.0.0-alpha.168) (2026-08-28)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.136

## @lunora/config [1.0.0-alpha.167](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.166...@lunora/config@1.0.0-alpha.167) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.135

## @lunora/config [1.0.0-alpha.166](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.165...@lunora/config@1.0.0-alpha.166) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.134
* **@lunora/seed:** upgraded to 1.0.0-alpha.90
* **@lunora/studio:** upgraded to 1.0.0-alpha.133

## @lunora/config [1.0.0-alpha.165](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.164...@lunora/config@1.0.0-alpha.165) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.133
* **@lunora/seed:** upgraded to 1.0.0-alpha.89
* **@lunora/studio:** upgraded to 1.0.0-alpha.132

## @lunora/config [1.0.0-alpha.164](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.163...@lunora/config@1.0.0-alpha.164) (2026-08-27)

### Bug Fixes

* **codegen,cli:** generated output that compiles, refinements that don't abort the run, and a --no-codegen that takes effect ([#500](https://github.com/anolilab/lunora/issues/500)) ([8500289](https://github.com/anolilab/lunora/commit/85002899c3de93d87e0741869115d89199dfca97))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.132

## @lunora/config [1.0.0-alpha.163](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.162...@lunora/config@1.0.0-alpha.163) (2026-08-27)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.131
* **@lunora/seed:** upgraded to 1.0.0-alpha.88
* **@lunora/studio:** upgraded to 1.0.0-alpha.131

## @lunora/config [1.0.0-alpha.162](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.161...@lunora/config@1.0.0-alpha.162) (2026-08-26)


### Dependencies

* **@lunora/studio:** upgraded to 1.0.0-alpha.130

## @lunora/config [1.0.0-alpha.161](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.160...@lunora/config@1.0.0-alpha.161) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.130
* **@lunora/studio:** upgraded to 1.0.0-alpha.129

## @lunora/config [1.0.0-alpha.160](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.159...@lunora/config@1.0.0-alpha.160) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.129
* **@lunora/seed:** upgraded to 1.0.0-alpha.87
* **@lunora/studio:** upgraded to 1.0.0-alpha.128

## @lunora/config [1.0.0-alpha.159](https://github.com/anolilab/lunora/compare/@lunora/config@1.0.0-alpha.158...@lunora/config@1.0.0-alpha.159) (2026-08-26)


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.128
* **@lunora/seed:** upgraded to 1.0.0-alpha.86
* **@lunora/studio:** upgraded to 1.0.0-alpha.127

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
