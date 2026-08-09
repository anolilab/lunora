# Non-JS client SDKs

One hand-written transport per language, plus a generated surface produced by
`lunora sdk generate --lang <id>`.

Browser and Node consumers should use `@lunora/client`, which is hand-written,
richer than anything generated, and not covered here.

## The three layers

| Layer | Where | Generated? |
| --- | --- | --- |
| Models | `quicktype-core`, per target | yes, where the backend can express them |
| Method surface | `packages/codegen/src/sdk/targets/<lang>.ts` | yes |
| Transport | `sdks/<lang>/` | **no** — hand-written, imported not vendored |

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

| Capability | python | go | ruby | rust | swift | java | kotlin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wire codec (all tags) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stable subscription key | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| RPC query / mutation / action | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Live subscriptions | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Shapes + poke protocol | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Resume across reconnect | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Typed argument models | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Typed result models | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Concurrency-safe client | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Built-in HTTP / socket | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Typed models, JVM.** quicktype's Java and Kotlin backends rename fields (a
wire `channelId` becomes `channelID`) and emit no mapping metadata under
`just-types`, so a generated model cannot be projected back onto the wire.
Sending the wrong key silently is worse than staying untyped, so both take
wire-shaped arguments. `targets/java.ts` records what would unlock this.

**Concurrency.** Only Go's client is safe to share across threads (it holds a
mutex — Go answers a concurrent map read/write with an unrecoverable fatal
error, so this is not optional there). Python's is safe by virtue of the GIL for
the operations it performs. The rest assume single-threaded use, matching how
their ecosystems drive a socket loop; wrap them if you share one.

**HTTP and sockets are injected in every language, deliberately.** The
conformance suites run with no network, and a consumer keeps its own transport,
timeouts, retries and socket library rather than inheriting ours.

## Conformance

Every SDK asserts itself against the golden frames in `protocol/fixtures/`, the
same files the TypeScript client is tested against.
`protocol/conformance-cases.json` lists the cases each suite must exercise —
coverage drifted badly before that list existed, leaving the decode-side bounds
unasserted in two ports for several commits with every gate green.

| Language | Run the suite | Toolchain |
| --- | --- | --- |
| python | `python3 -m unittest discover -s tests -t .` | stdlib only |
| go | `go test ./... -race` | stdlib only |
| ruby | `ruby -Ilib test/test_conformance.rb` | stdlib minitest |
| rust | `cargo test` | `serde_json` |
| swift | `swift test` | Foundation only |
| java | `bash build.sh` | JDK only |
| kotlin | `bash build.sh` | kotlinc + JDK |

CI runs all seven per PR (`sdk-conformance` in `.github/workflows/test.yml`),
and each leg also generates an SDK from a committed fixture and builds the
result — the generated surface hardcodes the runtime's call signatures, and
nothing else pins that coupling.

The Java leg additionally *runs* a generated call. That is not belt-and-braces:
an earlier revision emitted a surface that compiled perfectly and threw on the
first invocation, with the compile-only gate green throughout.
