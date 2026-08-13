# Non-JS client SDKs

One hand-written transport per language, plus a generated surface produced by
`lunora sdk generate --lang <id>`.

Browser and Node consumers should use `@lunora/client`, which is hand-written,
richer than anything generated, and not covered here.

## The three layers

| Layer          | Where                                        | Generated?                                     |
| -------------- | -------------------------------------------- | ---------------------------------------------- |
| Models         | `quicktype-core`, per target                 | yes, where the backend can express them        |
| Method surface | `packages/codegen/src/sdk/targets/<lang>.ts` | yes                                            |
| Transport      | `sdks/<lang>/`                               | **no** — hand-written, and COPIED into `--out` |

`packages/codegen/src/sdk/target.ts` documents the conventions every target must
follow, and `packages/codegen/__tests__/sdk-targets.test.ts` enforces them — a
convention that only exists in prose gets violated silently, which is exactly how
three of them were.

## The transport is copied, not installed

`lunora sdk generate` writes the transport into its output directory beside the
generated surface, so the result runs with **no Lunora package installed
anywhere**. This is the same copy-in model as `lunora registry add`, and it is not
a preference: the runtime packages the generated code used to import do not exist.
`lunora` 404s on PyPI, RubyGems, crates.io and pub.dev, `dev.lunora:lunora` 404s
on Maven Central, and `github.com/anolilab/lunora-go` 404s too — so the Go
surface could not resolve its own import in a user's project at all, and only
compiled in CI because the generated package happened to sit inside this repo's
module. Publishing eight registries (Maven Central alone needs a build tool these
transports do not have, plus groupId ownership and signing) is a larger project
than the SDKs.

### Layout per language

Each language gets the arrangement its own toolchain resolves, which is not the
same shape as this repo's. `targets/<lang>.ts` carries the reasoning; the summary:

| Language | Output layout                                              | How a consumer wires it up                                |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| python   | `lunora/` + `lunora_api/`                                  | put `<out>` on `sys.path`, `import lunora_api`            |
| go       | `go.mod` (module `lunorasdk`) + `lunora/` + `lunoraapi/`   | `require lunorasdk v0.0.0` + `replace lunorasdk => <out>` |
| ruby     | `lunora.rb` + `lunora/` + `api.rb` + `models.rb`           | `$LOAD_PATH.unshift(<out>)`, `require "lunora"` / `"api"` |
| rust     | `Cargo.toml` (`lunora-api`) + `src/` + `lunora/`           | `lunora-api = { path = "<out>" }`                         |
| swift    | `Package.swift` + `Sources/Lunora/` + `Sources/LunoraApi/` | `.package(path: "<out>")` + `.product(name:package:)`     |
| java     | `dev/lunora/*.java` + `lunoraapi/Api.java`                 | `javac -sourcepath <out>`                                 |
| kotlin   | `dev/lunora/*.kt` + `lunoraapi/Api.kt`                     | `kotlinc <out> …`                                         |
| dart     | `pubspec.yaml` (`lunora_sdk`) + `lib/`                     | `lunora_sdk: {path: <out>}` in `dependencies`             |

Two of those cost the consumer a line they would not otherwise write. Go needs the
`replace`, because two packages in one module beat one flat package: the transport
exports `Error`, `Map`, `Set`, `Date`, `URL`, `Bytes` and `Client`, so a table
named `error` or a result model named `Map` would be a redeclaration — a schema in
a user's project breaking the SDK's own compile. Swift needs `package:` spelled as
the output DIRECTORY's name, because SwiftPM takes a path dependency's identity
from the last path component and ignores the manifest's `name:`; a bare product
name does not resolve either. Both measured, both recorded in their target file. Dart is the counter-example
worth naming beside Swift, because the two look alike and are not: pub takes a
path dependency's identity from the DEPENDED-ON `pubspec.yaml`'s `name:` field,
not from the directory, so `lunora_sdk` is what a consumer writes no matter where
they generated into. It is also the only target that emits ONE package rather
than two units — `import 'lunora.dart'` inside `lib/` is a file import, not a
module import, so the generated surface and the vendored transport coexist with
no boundary to cross. The price is that nothing under `sdks/dart/lib/` may name
its own package: every import there is relative, because the copy resolves under
whatever name the emitted manifest declares and a `package:lunora/…`
self-import would dangle in every generated SDK.

### What a consumer must install

Six of eight: nothing.

| Language     | Install                                                            |
| ------------ | ------------------------------------------------------------------ |
| python       | nothing — stdlib only                                              |
| go           | nothing — stdlib only                                              |
| java, kotlin | nothing — JDK only                                                 |
| swift        | nothing — Foundation only                                          |
| dart         | nothing — `dart:convert` / `dart:typed_data` only                  |
| rust         | `serde` (derive) + `serde_json`, declared in the emitted manifests |
| ruby         | `dry-struct` + `dry-types`, and only when models are emitted       |

The two that are not empty are quicktype's, not the transports': the Ruby backend
renders `Dry::Struct` types with no renderer option to avoid them, and Rust models
are `serde` types. Dart's models are quicktype's too and still add nothing — its
backend renders hand-rolled `fromJson`/`toJson` over `dart:convert` rather than
annotations needing a codec package. Cargo resolves Rust's from the emitted `Cargo.toml`, so only
Ruby's is a manual step.

### Which vintage did I get

A copy cannot be upgraded by bumping a version, so the fetch is pinned to the
CLI's own release tag (`@lunora/cli@<version>`) and every output carries a
`lunora-transport.json` recording the ref that was actually used:

```json
{ "cliVersion": "1.0.0-alpha.159", "ref": "@lunora/cli@1.0.0-alpha.159", "versionMatched": true, … }
```

`versionMatched` is the field that matters — it says whether the transport and the
surface above it came from one release. Regenerating with a newer CLI is the
upgrade path. When the tag carries no transport for that language (a language
added since the last release), the CLI falls back to the release branch, warns
loudly naming both refs, and records `versionMatched: false`. `--ref <tag>` pins
explicitly and never falls back; `--from <dir>` copies from a local checkout of
this directory and is what CI uses.

## Capability matrix

This table exists for the same reason `PlatformCapabilities` does (see
`CLAUDE.md`): eight independently hand-written transports drift, and silence is
what lets the next consumer discover a gap at runtime. Update it in the same
change that adds or removes a capability.

| Capability                    | python | go  | ruby | rust | swift | java | kotlin | dart |
| ----------------------------- | ------ | --- | ---- | ---- | ----- | ---- | ------ | ---- |
| Wire codec (all tags)         | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Stable subscription key       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| RPC query / mutation / action | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Live subscriptions            | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Shapes + poke protocol        | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Resume across reconnect       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Typed argument models         | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Typed result models           | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Concurrency-safe client       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     | ✅   |
| Subscription as a Stream      | ❌     | ❌  | ❌   | ❌   | ❌    | ❌   | ❌     | ✅   |
| Built-in HTTP / socket        | ❌     | ❌  | ❌   | ❌   | ❌    | ❌   | ❌     | ❌   |

**Subscription as a Stream, dart.** The one row where a target does something the
others do not, and it is the reason the port exists: `client.watch(path, args)`
and the generated `watchX(args)` return a `Stream`, which a Flutter
`StreamBuilder` consumes with no adapter. The stream subscribes on first listen
and unsubscribes when the last listener cancels, so disposing a widget disposes
the subscription and there is no `dispose()` override to forget. The
callback-shaped `subscribe`/`subscribeX` every sibling has is still there, for a
value whose lifetime is not a widget's.

**Typed models, dart.** Dart is the target where quicktype's default output was
expected to fail the way the JVM backends do and did not. Its backend renames
properties exactly as Java's and Kotlin's do — a wire `2fa` becomes a `the2Fa`
field — but its DEFAULT render (that is, without `just-types`) writes the exact
wire key as a string literal inside `fromJson`/`toJson`, and an enum keeps its
wire value in an `EnumValues` table. Measured against the same adversarial key
set that defeated the JVM backends (`2fa`, `ID`, `URLs`, `some-key`, `user_name`,
`channelId`, and an `image-url` enum); all seven survived, over `dart:convert`
and no other dependency. So `targets/dart.ts` is a normal quicktype target and
there is no third hand-written model emitter.

What that output gets WRONG is fixed in the emitter, the way `narrowBareExcept`
fixes Python's swallowed `KeyboardInterrupt`. Two defects, both reachable by no
renderer option and both already familiar from sibling ports:

- **An unset optional list is sent as `[]`.** `field == null ? [] : List<…>` in
  `toJson`, and its mirror in `fromJson`, so `v.optional(v.array(…))` left unset
  arrives as an empty array rather than an absent key — and an absent key decodes
  to `[]` rather than to null. The same class of bug as Rust's `"limit": null`.
- **An unset optional map THROWS.** `Map.from(field!)` for a `v.record()` — a
  null-assertion on a field quicktype just declared nullable — so constructing OR
  serialising a model whose optional record is unset dies with "Null check
  operator used on a null value". Not a divergence: a hard crash on the first
  call, in every generated Dart SDK whose schema carries one.

The `!` is what tells the two cases apart, and it is quicktype's own nullability
marker rather than a guess: a REQUIRED record renders `Map.from(field)` with no
`!` at all. Both repairs are pinned in `packages/codegen/__tests__/sdk-dart.test.ts`
against quicktype's real output, so a version bump that changes the emitted shape
turns that test red instead of silently restoring the crash.

Unset optionals are dropped from the body by `LunoraClient.wireValue`, which is
Dart's counterpart to Swift's `JSONEncoder` omitting a nil — the pruning is
scoped to generated models, where null can only mean "unset", and never applied
to a hand-built argument tree where the caller chose it.

**Typed models, JVM.** The two JVM targets are the only ones whose models are NOT
rendered by quicktype, and the exception is measured rather than stylistic:
quicktype's Java and Kotlin backends rename properties (a wire `channelId` becomes
`channelID`) and emit no mapping metadata under `just-types`, so a model they render
cannot be projected back onto the wire. `acronym-style: original` fixes `channelId`
and still renames 5 of 14 realistic wire keys (`2fa`, `ID`, `URLs`, `some-key`,
`user_name`); Kotlin's `just-types` additionally erases enum wire values outright.
The backends do emit the exact wire name the moment `just-types` is dropped — as a
Jackson, Klaxon or kotlinx annotation, every one of which needs a library on the
classpath, which is the one thing these JDK-only transports do not have.

So `packages/codegen/src/sdk/jvm-models.ts` emits them from the JSON Schema
instead, whose property names ARE the wire names — there is no renamer to fight,
and `toWire()`/`fromWire()` write the schema's own key as a string literal. A local
field identifier is still derived (`2fa` cannot be a Java field, and becomes
`value2fa`), but it is cosmetic and never reaches the wire. Enums keep their value
(`enum class Kind(val wireValue: String)`, and `toValue()`/`forValue()` in Java),
an unset optional is OMITTED rather than sent as null, and Java gets one file per
class because its single-file form is not compilable Java. `targets/java.ts` records
every renderer option that was measured and why the alternative — subclassing
quicktype's `JavaRenderer`/`KotlinRenderer` — was not taken.

**Concurrency.** Go, Ruby, Java, Kotlin, Swift and Python hold a lock over the
subscription registry, the shape views and the id counters, and dispatch frames
and user callbacks after releasing it. Resume frames are BUILT under that lock,
because each one reads a `cursor` the frame handler writes. Every one of those
six has a test that starts a socket reader and four subscriber threads and
asserts on the resulting subscription count — a lost `nextId++` silently forgets
a live subscription, and that is deterministic where waiting for a hash map to
corrupt is not. The Swift leg additionally runs under `--sanitize=thread`; the
Ruby one gives its injected sender a `Thread.pass`, because MRI's 100ms time
slice otherwise lets four CPU-bound threads each run to completion without ever
interleaving, and the case then passes with the lock removed.

Python's lock is `threading.Lock`, not `asyncio.Lock`: `subscribe`,
`subscribe_shape`, `handle_frame` and `resend_subscriptions` are plain
synchronous methods, so the contention is between real OS threads — the WS read
loop against whatever thread the application subscribes from — and not between
tasks on one event loop. This row previously read "safe by virtue of the GIL",
which was wrong twice over. The GIL makes each bytecode atomic, not each
statement: `self._next_sub_id += 1` followed by a separate read of it lost 830 of
16,000 subscriptions in one unsynchronised run at the stock 5ms switch interval,
and building the reconnect resend by walking `_subs` while another thread
inserted raised `RuntimeError: dictionary changed size during iteration` on 10 of
10 runs. Its test lowers `sys.setswitchinterval` to sample that window often
enough to fail inside one run, which is the CPython counterpart of the Swift
leg's TSan pass — the failures above were measured at the stock interval.

Dart carries no lock either, and for a different reason again: isolates share no
mutable memory, so the socket read loop and the code calling `subscribe` are the
same isolate's event loop, and every method that touches the registry is
synchronous end to end — there is no `await` between reading the id counter and
writing it, and therefore no point for a second event to land in. That is why
this port has no counterpart to the four-thread subscription-count case the other
six run: it would assert nothing the language does not already guarantee.
Reaching one client from two isolates is not supported; give each isolate its
own, as one would with any Dart object.

Rust carries no lock and needs none: every method that touches that state takes
`&mut self`, so two threads reaching it at once is a compile error rather than a
data race, and with no interior mutability, `static` or `unsafe` in the client
that holds totally. Sharing is the caller's `Arc<Mutex<Client>>` — which required
`Client: Send`, so the injected poster, sender and handlers carry a `+ Send`
bound; without it one non-`Send` closure made the whole struct unshareable and no
amount of wrapping helped. Note the difference that follows: the other five
release their lock before invoking your callback and a caller's `Mutex` cannot,
so a Rust handler must not re-lock the client it was called from.

**HTTP and sockets are injected in every language, deliberately.** The
conformance suites run with no network, and a consumer keeps its own transport,
timeouts, retries and socket library rather than inheriting ours.

## Lint and format

Each transport is held to its own ecosystem's standard tools, run by
`./sdks/lint-all.sh` (same parallel shape as `run-all.sh`; pass language names to
narrow it). CI runs the identical script per leg, so the local check and the gate
cannot drift.

| Language | Format                                | Lint                         | Config                  |
| -------- | ------------------------------------- | ---------------------------- | ----------------------- |
| python   | `ruff format --check`                 | `ruff check`                 | `pyproject.toml`        |
| go       | `gofmt -l`                            | `go vet`                     | — (tool defaults)       |
| ruby     | `rubocop` (layout cops)               | `rubocop`                    | `.rubocop.yml`          |
| rust     | `cargo fmt --check`                   | `cargo clippy -D warnings`   | `rustfmt.toml`          |
| swift    | `swift format lint --strict`          | same                         | `.swift-format`         |
| java     | `google-java-format --aosp --dry-run` | `javac -Xlint:all -Werror`   | — (`--aosp` = 4sp)      |
| kotlin   | `ktlint`                              | `ktlint`                     | `.editorconfig`         |
| dart     | `dart format --set-exit-if-changed`   | `dart analyze --fatal-infos` | `analysis_options.yaml` |

Seven of the eight tools are pinned in CI by version or by SHA-256, so a new
release cannot change the rule set under a green PR. Dart's are pinned by the
same mechanism from the other end — its formatter and linter ARE the SDK, so
`dart-lang/setup-dart` pinning an exact SDK version pins both, and that leg needs
no separate install step. swift-format is the exception, and not by choice: it ships no binary on any release and no versioned
package, so the swift leg uses the Swift toolchain's own copy. Its pin is
therefore an assertion — `SWIFT_FORMAT_VERSION` in `lint-all.sh`, checked against
the version the tool reports, which the summary line prints either way
(`PASS swift [swift-format 6.3.0]`). A different minor is a note locally and,
under `SDK_LINT_REQUIRE_TOOLS=1`, a failure naming both versions, so a runner
image whose Swift moves cannot change the rule set quietly. To lint with a build
of your own, pass it and the version to expect from it —
`SWIFT_FORMAT=<path> SWIFT_FORMAT_VERSION=603.0`, since a standalone build of the
release a toolchain calls `6.3.0` reports `603.0.0`, and `swift format` ignores a
`swift-format` on `PATH`.

Two dart-specific settings, for the same reason rustfmt needs `--config-path`.
`dart format --language-version=3.6` is passed explicitly rather than left to
discovery: the style is chosen by the SDK constraint in the nearest `pubspec.yaml`,
the smoke lives outside `sdks/dart/` and there is no pubspec above `sdks/smoke/`,
so left alone the smoke would be formatted against the LATEST style while the
transport is formatted against 3.6 — two rule sets inside one leg. Keep it in step
with `sdks/dart/pubspec.yaml`. And `dart analyze --fatal-infos`, because
`dart analyze` exits 0 on an info-level lint by default, which is where most of
`analysis_options.yaml` reports.

A tool missing locally reports `SKIP`, never
`PASS` — not everyone has eight toolchains, and a check that did not run must not
read as one that passed. CI sets `SDK_LINT_REQUIRE_TOOLS=1`, which turns that
`SKIP` into a failure: there the install step just ran, so a missing tool means it
broke, and a gate that skips everything is green for the worst possible reason.

Two settings are deliberate rather than default: the line width is 160
everywhere, matching the repo's Prettier `printWidth`, so two ports read the same
side by side; and Java uses `--aosp` for 4-space indentation for the same reason.
Where a rule is switched off, the config says which behaviour of this code the
rule was wrong about — the wire codec's `case`/`when` tables and its
shortest-round-trip float comparison are the recurring two.

**Generated output is excluded from all of it**, and there is no longer any
committed: the models come from quicktype, whose style this repo does not own, and
any correction there is undone by the next regeneration. Correctness in generated
output is enforced in the emitter instead — `narrowBareExcept` in
`targets/python.ts` is one such fix, for a bare `except:` that swallowed
`KeyboardInterrupt` in every generated Python SDK.

What IS linted here, and lives outside every transport's own tree, is
`sdks/smoke/<lang>/`. Those are the consumer programs `generated-check.sh` builds,
and the only code in this repo written against the vendored layout a user gets —
the closest thing to a worked example, and an example nobody formats rots.

## Conformance

Every SDK asserts itself against the golden frames in `protocol/fixtures/`, the
same files the TypeScript client is tested against.
`protocol/conformance-cases.json` lists the cases each suite must exercise —
coverage drifted badly before that list existed, leaving the decode-side bounds
unasserted in two ports for several commits with every gate green.

**All eight suites read that file at run time and fail if the run did not cover
it**, so adding a name there turns every language red until it is covered. The
evidence is produced by the case executing, never by a suite listing names it
claims to cover, and the mechanism is whatever each runner offers rather than one
shape forced onto all eight:

| Language | Mechanism                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------- |
| python   | each case calls `covers()`; `tests/test_zz_manifest.py` (sorted last by discovery) compares the two sets |
| go       | each case calls `covers()`; `TestMain` compares after `m.Run()` — a `-run`-filtered run is exempt        |
| ruby     | each case calls `ConformanceManifest.covers`; `Minitest.after_run` aborts on a gap                       |
| rust     | no after-all hook in libtest, so the manifest **drives** the run: each name dispatches to its case       |
| swift    | no after-all hook that can fail in XCTest, so likewise — hence `caseX` methods and one dispatching test  |
| java     | each case calls `covers()`; the end of `main` is the after-all hook                                      |
| kotlin   | as java                                                                                                  |
| dart     | each case calls `covers()`; the end of `main` is the after-all hook, as java                             |

Where the manifest drives the run, a required name with no dispatch arm fails,
which is the same guarantee from the other direction: the only way to go green is
to execute a case under that name.

Run all of them at once with `./sdks/run-all.sh`, which fans the suites out in
parallel — they are eight independent toolchains reading the same read-only
fixtures, so the whole set costs about as long as the slowest compiler rather
than the sum of all eight. Pass language names to narrow it
(`./sdks/run-all.sh go rust`). Or one at a time:

| Language | Run the suite                                                           | Toolchain           |
| -------- | ----------------------------------------------------------------------- | ------------------- |
| python   | `python3 -m unittest discover -s tests -t .`                            | stdlib only         |
| go       | `go test ./... -race -count=1`                                          | stdlib only         |
| ruby     | `ruby -Ilib -e 'Dir["test/test_*.rb"].each { \|f\| require "./#{f}" }'` | stdlib minitest     |
| rust     | `cargo test`                                                            | `serde_json`        |
| swift    | `swift test`                                                            | Foundation only     |
| java     | `PATH="$JDK_BIN:$PATH" bash build.sh`                                   | JDK only, see below |
| kotlin   | `PATH="$JDK_BIN:$PATH" bash build.sh`                                   | kotlinc + JDK       |
| dart     | `dart pub get --offline && dart run test/conformance.dart`              | Dart SDK only       |

**The JVM legs need a real JDK on `PATH`.** On macOS `/usr/bin/java` is Apple's
stub, which reports "No Java runtime present" and does not run anything, so
`bash build.sh` on its own fails there. `run-all.sh` and `lint-all.sh` prepend the
Homebrew JDK for you; running `build.sh` directly does not, hence the prefix
above — with Homebrew that is:

```bash
export JDK_BIN=/opt/homebrew/opt/openjdk/bin
```

**Only the full run is held to the manifest.** The ruby command above loads every
`test/test_*.rb` (a single file records coverage but is not held to a list it
cannot cover), and the go check exempts a `-run`-filtered run for the same
reason.

**`-count=1` on the go leg is load-bearing.** Everything these suites assert
against — `protocol/fixtures/*.json` and `protocol/conformance-cases.json` — lives
outside the Go module, so the test cache cannot see those files change and replays
a PASS recorded before the edit. Without it, editing a fixture or the manifest
leaves the go leg green without having run.

CI runs all eight per PR (`sdk-conformance` in `.github/workflows/test.yml`),
and each leg also runs `./sdks/generated-check.sh <lang>` — the generated surface
hardcodes the runtime's call signatures, and nothing else pins that coupling.

## The generated-SDK check

```bash
./sdks/generated-check.sh            # all eight, sequentially
./sdks/generated-check.sh go rust    # a subset
```

It needs a built CLI (`pnpm exec vis run build --query "project=cli"`) and then,
per language: generates an SDK into `mktemp -d`, assembles the consumer project a
real user writes, compiles it, and runs a call.

**The scratch directory is the point, not tidiness.** Since the transport is
copied, the promise is "this output runs with nothing installed" — and that cannot
be tested anywhere `sdks/<lang>` is resolvable. Inside the checkout Python finds
`sdks/python/lunora` on `sys.path`, Go finds a sibling package in the same module,
Swift finds a target in the same package; a pass there would prove nothing. So the
output goes outside the repo and each consumer project wires it up the documented
way and no other.

**Calling is not belt-and-braces.** Two languages shipped a revision whose surface
passed its compile-or-parse check and threw on the first invocation: Java could
not encode its own argument model, and Ruby called a `to_dynamic` the models were
not rendered with. A third — Rust — sent `"limit": null` for an unset optional,
which `v.optional()` rejects; the smoke that calls it is what surfaced that, one
build after the same bug was fixed in Ruby.

The smoke programs are `sdks/smoke/<lang>/`, and each asserts the same thing: that
a generated call reaches the wire as
`{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}` — note the absent
`limit`, which is what makes this assertion catch the unset-optional bug at all. They sit outside
every transport's tree because that is what they are — consumer code, importing
`lunorasdk/lunoraapi` and `import LunoraApi`, which resolve only against generated
output. `--from sdks` is passed for them, because the default fetch is the CLI's
release tag and seven of the eight transports do not exist at any released tag
yet.

The dart leg runs `dart analyze` in BOTH the generated package and the consumer,
and the first is the one that matters: `dart analyze` only reports on the package
it runs in, so from the consumer it type-checks the smoke's use of the surface
and stays silent about the surface itself — measured, not assumed. Run inside the
generated package it is the counterpart of `swift build`, and it covers
quicktype's models too.
