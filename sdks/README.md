# Non-JS client SDKs

One hand-written transport per language, plus a generated surface produced by
`lunora sdk generate --lang <id>`.

Browser and Node consumers should use `@lunora/client`, which is hand-written,
richer than anything generated, and not covered here.

## The three layers

| Layer          | Where                                        | Generated?                                   |
| -------------- | -------------------------------------------- | -------------------------------------------- |
| Models         | `quicktype-core`, per target                 | yes, where the backend can express them      |
| Method surface | `packages/codegen/src/sdk/targets/<lang>.ts` | yes                                          |
| Transport      | `sdks/<lang>/`                               | **no** — hand-written, imported not vendored |

The transport is imported rather than copied into a user's project, so a
wire-protocol fix is a runtime version bump instead of a regenerate-everyone
event. `packages/codegen/src/sdk/target.ts` documents the conventions every
target must follow, and `packages/codegen/__tests__/sdk-targets.test.ts`
enforces them — a convention that only exists in prose gets violated silently,
which is exactly how three of them were.

## Capability matrix

This table exists for the same reason `PlatformCapabilities` does (see
`CLAUDE.md`): seven independently hand-written transports drift, and silence is
what lets the next consumer discover a gap at runtime. Update it in the same
change that adds or removes a capability.

| Capability                    | python | go  | ruby | rust | swift | java | kotlin |
| ----------------------------- | ------ | --- | ---- | ---- | ----- | ---- | ------ |
| Wire codec (all tags)         | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     |
| Stable subscription key       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     |
| RPC query / mutation / action | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     |
| Live subscriptions            | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     |
| Shapes + poke protocol        | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     |
| Resume across reconnect       | ✅     | ✅  | ✅   | ✅   | ✅    | ✅   | ✅     |
| Typed argument models         | ✅     | ✅  | ✅   | ✅   | ✅    | ❌   | ❌     |
| Typed result models           | ✅     | ✅  | ✅   | ✅   | ✅    | ❌   | ❌     |
| Concurrency-safe client       | ✅     | ✅  | ❌   | ❌   | ✅    | ✅   | ✅     |
| Built-in HTTP / socket        | ❌     | ❌  | ❌   | ❌   | ❌    | ❌   | ❌     |

**Typed models, JVM.** quicktype's Java and Kotlin backends rename fields (a
wire `channelId` becomes `channelID`) and emit no mapping metadata under
`just-types`, so a generated model cannot be projected back onto the wire.
Sending the wrong key silently is worse than staying untyped, so both take
wire-shaped arguments. `targets/java.ts` records what would unlock this.

**Concurrency.** Go, Java, Kotlin and Swift hold a lock over the subscription
registry, the shape views and the id counters, and dispatch frames and user
callbacks after releasing it. Every one of those four has a test that starts a
socket reader and four subscriber threads and asserts on the resulting
subscription count — a lost `nextId++` silently forgets a live subscription, and
that is deterministic where waiting for a hash map to corrupt is not. The Swift
leg additionally runs under `--sanitize=thread`. Python's client is safe by
virtue of the GIL for the operations it performs. Ruby and Rust assume
single-threaded use; wrap them if you share one.

**HTTP and sockets are injected in every language, deliberately.** The
conformance suites run with no network, and a consumer keeps its own transport,
timeouts, retries and socket library rather than inheriting ours.

## Lint and format

Each transport is held to its own ecosystem's standard tools, run by
`./sdks/lint-all.sh` (same parallel shape as `run-all.sh`; pass language names to
narrow it). CI runs the identical script per leg, so the local check and the gate
cannot drift.

| Language | Format                                | Lint                       | Config             |
| -------- | ------------------------------------- | -------------------------- | ------------------ |
| python   | `ruff format --check`                 | `ruff check`               | `pyproject.toml`   |
| go       | `gofmt -l`                            | `go vet`                   | — (tool defaults)  |
| ruby     | `rubocop` (layout cops)               | `rubocop`                  | `.rubocop.yml`     |
| rust     | `cargo fmt --check`                   | `cargo clippy -D warnings` | `rustfmt.toml`     |
| swift    | `swift format lint --strict`          | same                       | `.swift-format`    |
| java     | `google-java-format --aosp --dry-run` | `javac -Xlint:all -Werror` | — (`--aosp` = 4sp) |
| kotlin   | `ktlint`                              | `ktlint`                   | `.editorconfig`    |

Every tool is pinned in CI by version or by SHA-256, so a new release cannot
change the rule set under a green PR. A tool missing locally reports `SKIP`, never
`PASS` — not everyone has seven toolchains, and a check that did not run must not
read as one that passed. CI sets `SDK_LINT_REQUIRE_TOOLS=1`, which turns that
`SKIP` into a failure: there the install step just ran, so a missing tool means it
broke, and a gate that skips everything is green for the worst possible reason.

Two settings are deliberate rather than default: the line width is 160
everywhere, matching the repo's Prettier `printWidth`, so two ports read the same
side by side; and Java uses `--aosp` for 4-space indentation for the same reason.
Where a rule is switched off, the config says which behaviour of this code the
rule was wrong about — the wire codec's `case`/`when` tables and its
shortest-round-trip float comparison are the recurring two.

**`generated_check/` is excluded from all of it.** Those trees are
`lunora sdk generate` output committed as samples; the models come from
quicktype, whose style this repo does not own, and any correction there is undone
by the next regeneration. Correctness in generated output is enforced in the
emitter instead — `narrowBareExcept` in `targets/python.ts` is one such fix, for a
bare `except:` that swallowed `KeyboardInterrupt` in every generated Python SDK.

## Conformance

Every SDK asserts itself against the golden frames in `protocol/fixtures/`, the
same files the TypeScript client is tested against.
`protocol/conformance-cases.json` lists the cases each suite must exercise —
coverage drifted badly before that list existed, leaving the decode-side bounds
unasserted in two ports for several commits with every gate green.

**All seven suites read that file at run time and fail if the run did not cover
it**, so adding a name there turns every language red until it is covered. The
evidence is produced by the case executing, never by a suite listing names it
claims to cover, and the mechanism is whatever each runner offers rather than one
shape forced onto all seven:

| Language | Mechanism                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------- |
| python   | each case calls `covers()`; `tests/test_zz_manifest.py` (sorted last by discovery) compares the two sets |
| go       | each case calls `covers()`; `TestMain` compares after `m.Run()` — a `-run`-filtered run is exempt        |
| ruby     | each case calls `ConformanceManifest.covers`; `Minitest.after_run` aborts on a gap                       |
| rust     | no after-all hook in libtest, so the manifest **drives** the run: each name dispatches to its case       |
| swift    | no after-all hook that can fail in XCTest, so likewise — hence `caseX` methods and one dispatching test  |
| java     | each case calls `covers()`; the end of `main` is the after-all hook                                      |
| kotlin   | as java                                                                                                  |

Where the manifest drives the run, a required name with no dispatch arm fails,
which is the same guarantee from the other direction: the only way to go green is
to execute a case under that name.

Run all of them at once with `./sdks/run-all.sh`, which fans the suites out in
parallel — they are seven independent toolchains reading the same read-only
fixtures, so the whole set costs about as long as the slowest compiler rather
than the sum of all seven. Pass language names to narrow it
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

CI runs all seven per PR (`sdk-conformance` in `.github/workflows/test.yml`),
and each leg also generates an SDK from a committed fixture, builds the result,
and then _calls_ it — the generated surface hardcodes the runtime's call
signatures, and nothing else pins that coupling.

Calling is not belt-and-braces. Two languages shipped a revision whose surface
passed its compile-or-parse check and threw on the first invocation: Java could
not encode its own argument model, and Ruby called a `to_dynamic` the models were
not rendered with. A third — Rust — sent `"limit": null` for an unset optional,
which `v.optional()` rejects; the smoke that calls it is what surfaced that, one
build after the same bug was fixed in Ruby.

The smoke programs live beside each transport (`generated_smoke.*`,
`smoke/generated_smoke_test.go`, `generated_check/tests/`,
`Tests/GeneratedCheckTests/`) and each asserts the same thing: that a generated
call reaches the wire as `{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}`.
Run one after generating into that language's `generatedOut` path.
