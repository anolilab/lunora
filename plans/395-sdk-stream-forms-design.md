# Plan 395 design: Stream subscription forms for the non-Dart SDK targets

> Deliverable of plans/395-sdk-stream-forms-spike.md. Design only. Drift check
> at `207be1b63` (HEAD): zero drift under `packages/codegen/src/sdk/`. No
> existing design doc covers this (grep of `plans/` for stream+sdk found only
> unrelated plans: 033 is HTTP response streaming, 052 is a React hook).

## The headline finding that reshapes the plan

The spike's premise was that seven languages need idiomatic stream _runtimes_
designed. They do not: **every one of the seven hand-written transports already
ships a stream primitive next to `subscribe`, with its semantics decided and
documented in-file**:

| Runtime | Primitive                                                                                             | Location                                         |
| ------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Kotlin  | `Client.stream(...) : Stream` — `Sequence<StreamEvent>` over a `LinkedBlockingQueue`, `AutoCloseable` | `sdks/kotlin/src/Client.kt:471-520`              |
| Swift   | `client.stream(...) -> AsyncStream<LunoraStreamEvent>`                                                | `sdks/swift/Sources/Lunora/Client.swift:573-586` |
| Rust    | `client.stream(...) -> (mpsc::Receiver<StreamEvent>, String)` — `Receiver` is an `Iterator`           | `sdks/rust/src/client.rs:609-642`                |
| Python  | `client.stream(...) -> AsyncIterator` (async generator)                                               | `sdks/python/lunora/client.py:507-539`           |
| Go      | `client.Stream(...) (<-chan StreamEvent, Unsubscribe)`                                                | `sdks/go/lunora/client.go:719-750`               |
| Java    | `client.stream(...) : Stream` — blocking `Iterable<StreamEvent>`, `AutoCloseable`                     | `sdks/java/src/dev/lunora/Client.java:614-694`   |
| Ruby    | `client.stream(...) -> [Enumerator, stop]` over a `Thread::Queue`                                     | `sdks/ruby/lib/lunora/client.rb:315-338`         |
| Dart    | `client.watch(...) -> Stream<Object?>` (`Stream.multi`)                                               | `sdks/dart/lib/src/client.dart:447-452`          |

What is missing is only the **generated surface**: every target's
`renderSubscribe` emits the callback form alone (kotlin.ts:136-147, go.ts:98-106,
swift.ts:232-245, rust.ts:199-222, ruby.ts:152-160, python.ts:116-133,
java.ts:226-236 — all under `packages/codegen/src/sdk/targets/`), so the stream
primitive is reachable only by hand-typing the function path — exactly the
bare-string routing the conventions doc forbids the generated surface to
require. The implementation is therefore seven small emitter changes, not seven
runtime designs. No STOP condition fired: every transport's subscribe primitive
works (each also carries `subscribe_shape`/`resend_subscriptions` machinery from
commit `17129fa4b`).

## 1. The convention (phrased for `target.ts:29-47`)

Proposed addition to the "Conventions every target must follow" block in
`packages/codegen/src/sdk/target.ts` (after the "Subscriptions are queries
only" paragraph, which it extends):

> **Every query gets two live members.** The callback form
> (`subscribeX`/`subscribe_x`) and the stream form (`watchX`/`watch_x`), which
> wraps the transport's `stream` primitive so the language's native
> consumption loop — `for await`, `async for`, `for … in`, `each`,
> try-with-resources iteration, `range` — binds a live query without a
> hand-rolled bridge. The member prefix is `watch` in every language (the
> Dart precedent), spelled in the target's member casing. The stream form
> follows the callback form's typing rule: it maps into the declared result
> model only where the callback form already does (today: Dart), and degrades
> to the language's `any`-shaped event elsewhere — untyped results degrade,
> never guess. A target whose language genuinely lacks a canonical
> consumable stream shape may omit the form, stated in its file docblock.

Naming note: the _runtime_ primitive is named `stream` in six transports and
`watch` in Dart; the _generated member_ prefix is `watch` everywhere. `watch`
wins for the generated surface because (a) Dart shipped it first and renaming
Dart's headline member is gratuitous breakage, and (b) `Stream${memberBase}`
would collide with Java's/Kotlin's nested `Stream` class in more reader-facing
positions. The runtimes keep their `stream` spelling — they are hand-written,
not generated, and their names are already published in the vendored copies.

**Reserved names — mandatory in the same change (the plan-388 lesson).**
`assertMethodsGeneratable` (`packages/codegen/src/sdk/spec.ts:623-654`)
reserves collision-checked names in PascalCase, language-neutrally — one map
covers `subscribe_x` and `subscribeX` alike because `toPascalCase` folds both
to `SubscribeX` (spec.ts:640). Plan 388 adds `Watch${memberBase}` for Dart's
sake; **because the guard is language-neutral and runs before any target,
that single reservation already covers every target adopting the `watch`
prefix** — no per-language spec.ts change is needed after 388 lands. The
build-plan rule stays: any target that ever adds a member under a _new_ prefix
must extend the `names` array in `spec.ts` in the same commit (cite plan 388
in that commit body; this bug shipped once already). If plan 388 has not
landed when the first non-Dart target does, that target's PR carries the
`Watch${memberBase}` reservation itself.

## 2. Per-language table

Semantics below are **recorded from the shipped runtimes**, not proposed — the
generated form inherits them by wrapping `client.stream(...)` exactly as
`subscribeX` wraps `client.subscribe(...)` today.

| Lang           | Generated member           | Return type                                                   | Cancellation (does drop unsubscribe?)                                                                                                  | Error delivery                                                                                                 | Buffering                                                                                                            |
| -------------- | -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Dart (shipped) | `watchX(args)`             | `Stream<Model>` (typed via `fromJson`, dart.ts:383-388)       | listener cancel → unsubscribe (`client.dart:449-451`); per-listener subscription                                                       | in-band error channel (`controller.addError`), non-terminating by default (listener's `cancelOnError` decides) | `Stream.multi`, per-listener                                                                                         |
| Swift          | `watchX(args:shardKey:)`   | `AsyncStream<LunoraStreamEvent>` (`.value(Any)` / `.failure`) | yes — `continuation.onTermination` unsubscribes on break/task-cancel (`Client.swift:584`)                                              | in-band `.failure` event, stream does NOT terminate (`AsyncStream`, not throwing — `Client.swift:551-558`)     | unbounded (`Client.swift:570-573`)                                                                                   |
| Kotlin         | `watchX(args, shardKey)`   | `Client.Stream` (`Sequence<StreamEvent>`, `AutoCloseable`)    | no — `close()` required (use-block); drop alone leaks and grows the queue (`Client.kt:462-474`)                                        | in-band `StreamEvent(value, error)`, non-terminating (`Client.kt:447-456`)                                     | unbounded `LinkedBlockingQueue`                                                                                      |
| Python         | `watch_x(args, shard_key)` | `AsyncIterator`                                               | yes — teardown in generator `finally` on break/`aclose()`/task cancel (`client.py:533-537`)                                            | **raises** `LunoraError` into the loop — terminates (`client.py:518-520, 531-532`)                             | unbounded `asyncio.Queue`                                                                                            |
| Rust           | `watch_x(args, shard_key)` | `(mpsc::Receiver<StreamEvent>, String)`                       | no — must call `client.unsubscribe(id)`; dropping the receiver leaves the subscription open by documented design (`client.rs:612-617`) | in-band `StreamEvent::Error`, non-terminating                                                                  | unbounded std `mpsc` (`client.rs:620-622`: std-only, no futures dep)                                                 |
| Go             | `WatchX(args, shardKey)`   | `(<-chan StreamEvent, Unsubscribe)`                           | no — call the returned `Unsubscribe` (defer); it closes the channel (`client.go:711-713, 743-750`)                                     | in-band `StreamEvent{Value, Err}`, non-terminating                                                             | **bounded 64, sends block** — deliberate backpressure, the one divergence, documented (`client.go:714-719, 752-755`) |
| Java           | `watchX(args, shardKey)`   | `Client.Stream` (`Iterable<StreamEvent>`, `AutoCloseable`)    | no — `close()` in try-with-resources; drop alone blocks the iterator forever (`Client.java:607-613`)                                   | in-band `StreamEvent(value, error)` record, non-terminating (`Client.java:598-604`)                            | unbounded `LinkedBlockingQueue`                                                                                      |
| Ruby           | `watch_x(args, shard_key)` | `[Enumerator, stop]`                                          | no — call `stop` (it closes the queue and wakes a blocked `pop`, `client.rb:319-324`)                                                  | **raises** `ApiError` into the loop — terminates (`client.rb:311-312, 331`)                                    | unbounded `Thread::Queue`                                                                                            |

Two deliberate asymmetries to state in the convention rather than sand away:

- **Terminate vs. side-channel.** The async-native runtimes with exceptions in
  their loop protocol (Python, Ruby) raise and terminate; everything else
  delivers a combined value-or-error event and continues. Each file documents
  why ("a subscription error is raised into the loop … which is what stops a
  caller mistaking it for data" — client.py:518; vs. the shared "one queue
  carrying both … what arrived first is delivered first" rationale in
  Kotlin/Java/Swift/Go). Recommendation: keep both, per language, as shipped —
  reconciling them means changing published vendored runtimes for uniformity
  no consumer asked for.
- **Typing.** Only Dart's callback/stream forms map into declared models; every
  other language's `subscribe` already delivers untyped values
  (`onData: ((WireValue) -> Unit)?` in Kotlin, `func(value any)` in Go, etc.).
  The stream forms match their own language's callback form — adding typed
  mapping is a separate (larger) per-language project and out of scope here.

## 3. Ordering

1. **Swift** — `AsyncStream` is consumed directly by SwiftUI
   (`.task { for await … }`) with task-scoped auto-unsubscribe already wired
   (`onTermination`). Highest UI-binding payoff, zero runtime work,
   Dart-equivalent ergonomics. First.
2. **Kotlin** — Compose/Android is the other big UI layer, but with a caveat
   the spike's framing missed: the transport is deliberately JDK-only — "`Flow`
   lives in kotlinx-coroutines, and this transport takes no dependencies
   beyond the JDK" (`Client.kt:466-468`). The generated form therefore wraps
   the blocking `Client.Stream`, which Compose does _not_ consume directly.
   Still second: the member removes the bare-string path, and the
   `callbackFlow` bridge over the generated _callback_ member is 5 lines a
   README can carry (open question 1 covers the Flow upgrade).
3. **Python** — `async for` over the shipped async generator; scripting and
   server-side agents bind live queries in one loop. Third.
4. **Rust** — the `Receiver` is an `Iterator`; `for event in events` is
   idiomatic for the std-only crate. A `futures::Stream` impl would break the
   crate's documented no-dependency stance (`client.rs:620-622`) — don't.
5. **Java** — try-with-resources over the blocking `Iterable` is the blessed
   pre-Loom shape the runtime already chose; nothing better exists without a
   reactive-streams dependency (open question 3).
6. **Go** — borderline "not worth it": the runtime's `(<-chan, Unsubscribe)`
   pair _is_ the idiomatic form and the generated callback member already
   exists; but the wrapper is ~6 emitted lines and removes the bare-string
   path, so emit it for uniformity. Last-but-one.
7. **Ruby** — last. The `[Enumerator, stop]` tuple is awkward, Ruby UI binding
   is not a real consumer, and the callback form serves the realistic uses.
   Emit it only to complete the convention; deprioritize freely.

## 4. Open questions for the maintainer

1. **Kotlin: should the vendored transport take a kotlinx-coroutines dependency
   so the generated form can return `Flow`?** Recommended answer: no, for now.
   The zero-dep stance is documented in-file and server-side Kotlin consumers
   exist; ship the `Client.Stream` form plus a README `callbackFlow` snippet,
   and revisit only if adoption feedback names Compose binding as a blocker.
   (If reversed later, the member name and reservation don't change — only the
   return type.)
2. **Does the callback form stay?** Recommended: yes, everywhere — matching
   Dart, whose docblock states the split's purpose ("for a value whose lifetime
   is not a widget's", dart.ts:359-364). Every runtime's `stream` doc says the
   same ("use `subscribe` directly when the value outlives one loop").
3. **Java: `Flow.Publisher` instead of the blocking `Iterable`?** Recommended:
   no. `java.util.concurrent.Flow` is stdlib but push-based publishers need a
   `SubmissionPublisher` executor and give consumers a worse API than a loop;
   the runtime already rejected it implicitly by shipping the
   `Iterable`+`AutoCloseable` shape, which is also the virtual-threads-era
   idiom. Keep.
4. **Backpressure policy: should the unbounded buffers converge on Go's
   bounded-blocking model?** Recommended: no. Each runtime documents its trade
   in-file (unbounded = dispatcher never blocks; Go's bound = deliberate
   backpressure because its dispatcher runs on a goroutine that may block
   safely). Converging would change shipped, documented behavior for symmetry
   alone. Record the divergence in the convention text instead.
5. **Rust drop semantics: is "dropping the receiver does not unsubscribe"
   acceptable in a generated member?** Recommended: yes, unchanged — it is the
   documented consequence of handing out ids instead of `&mut self`-capturing
   closures (`client.rs:612-617`); the generated docblock must repeat the
   warning verbatim.

## 5. Effort per target and conformance additions

Every implementation touches: the target's `renderSubscribe` (emit the second
member, ~8-12 lines mirroring the existing callback emission), the vendored
transport **not at all** (primitive exists), the language's conformance suite,
and `generated_check/` where the language has a call-through sample
(`bash sdks/generated-check.sh` builds and _calls_ each generated SDK).
Reserved name: covered globally once plan 388's `Watch${memberBase}` lands
(section 1).

| Target | Emitter effort | Conformance additions (`sdks/run-all.sh` suites)                                                                                                                                |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swift  | S              | `Tests/`: stream yields `.value` on data frame, `.failure` on error frame, unsubscribe frame sent on termination (model on the existing subscribe cases in `sdks/swift/Tests/`) |
| Kotlin | S              | `test/ConformanceTest.kt`: generated `watchX` routes the typed function-path constant; close() emits unsubscribe frame                                                          |
| Python | S              | `tests/`: `async for` receives data; error frame raises `LunoraError`; `aclose()` sends unsubscribe                                                                             |
| Rust   | S              | `tests/`: receiver iterates values; unsubscribe(id) ends iteration                                                                                                              |
| Java   | S              | `test/dev/lunora/ConformanceTest.java`: try-with-resources loop; close() wakes blocked `take()`                                                                                 |
| Go     | S              | `lunora/conformance_test.go` (`-count=1` note applies): range over channel; Unsubscribe closes it                                                                               |
| Ruby   | S              | `test/test_conformance.rb`: enumerator yields; error raises `ApiError`; stop closes queue                                                                                       |

All S: the hard half (runtime semantics, threading, buffering, reconnect
resume via `resend_subscriptions`) shipped with the primitives and is already
covered by each runtime's own tests; what each PR adds is the emitted wrapper
plus the wiring assertion that the _generated_ member reaches the primitive
with the right function path. Per the maintenance note in the spike: one
language per PR, each PR runs `bash sdks/run-all.sh <lang>` and
`bash sdks/generated-check.sh`, and the first PR to land carries the
convention-text edit to `target.ts:29-47` (plus the `Watch` reservation if 388
hasn't landed).
