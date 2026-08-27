## @lunora/scheduler [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.40...@lunora/scheduler@1.0.0-alpha.41) (2026-08-27)

### Documentation

* repair 404 package links, and document .source() in the hyperdrive readme ([#501](https://github.com/anolilab/lunora/issues/501)) ([d519ac2](https://github.com/anolilab/lunora/commit/d519ac23f2bd8ddf5a10af5db11f141e8728babf))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.19

## @lunora/scheduler [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.39...@lunora/scheduler@1.0.0-alpha.40) (2026-08-27)

### Bug Fixes

* **shard-engine:** reject cursors minted before the tiebreak changed direction ([#503](https://github.com/anolilab/lunora/issues/503)) ([fdc58bc](https://github.com/anolilab/lunora/commit/fdc58bc6acc6c4f794da42e038c6953d2554c0fe))

## @lunora/scheduler [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.38...@lunora/scheduler@1.0.0-alpha.39) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/platform:** upgraded to 1.0.0-alpha.18

## @lunora/scheduler [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.37...@lunora/scheduler@1.0.0-alpha.38) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/scheduler [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.36...@lunora/scheduler@1.0.0-alpha.37) (2026-08-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.17

## @lunora/scheduler [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.35...@lunora/scheduler@1.0.0-alpha.36) (2026-08-24)

### ⚠ BREAKING CHANGES

* **scheduler:** QueueDispatch is now
(job: QueueJob, messageId?: string) => Promise<void> — the consumer
passes the queue message's native id as the second argument.

@lunora/dispatch is added as a devDependency and inlined into dist
by packem, matching @lunora/queue; it is not a published runtime dep.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* fix(scheduler): make the queue job deadline configurable

Routing the workpool through the dispatch runner picked up its 30s
default, which is calibrated for an inline ctx.run inside a handler
that is itself serving something. A workpool is the opposite case —
it exists for jobs that outlive a request (an LLM call, an export, a
payment round-trip), and truncating those at 30s turns a working job
into a retry loop. Worse, an action's dedup read is deliberately
ungated, so the retry can run concurrently with the still-in-flight
first attempt.

httpDispatcher now defaults to a 5 minute deadline and exposes
`timeoutMs` on HttpDispatcherOptions to raise or lower it. The bound
still cuts a hung origin off well short of the platform killing the
whole queue() invocation, which is what this dispatcher did before
with no deadline at all.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

* test(scheduler): assert the job deadline, not its mechanism

The two dispatcher timeout tests stubbed `AbortSignal.timeout` and
asserted the duration it was called with. That reached into how
@lunora/dispatch implements its deadline rather than what this package
depends on, so the tests hang for their full timeout the moment the
runner arms its deadline any other way.

Replaced with one test that gives the dispatcher a short real deadline
and asserts the error it produces: status 503, message naming the
configured duration. That holds regardless of how the runner arms the
clock. The 5-minute default is a constant, and proving it fires would
mean driving the runner's clock from here again.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P2mHUwAGcpzDrv4ZNd8MLG

### Bug Fixes

* **scheduler:** route workpool through the runner ([#454](https://github.com/anolilab/lunora/issues/454)) ([bd330d9](https://github.com/anolilab/lunora/commit/bd330d986bec182a22a05736a3e772f332b5226e))

## @lunora/scheduler [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.34...@lunora/scheduler@1.0.0-alpha.35) (2026-08-23)

### Build System

* migrate to @cloudflare/vitest-plugin v1 ([#470](https://github.com/anolilab/lunora/issues/470)) ([05c4937](https://github.com/anolilab/lunora/commit/05c49371c30d65907eec8719f27a117f9bcaaefc))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.15

## @lunora/scheduler [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.33...%40lunora%2Fscheduler%401.0.0-alpha.34) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14

## @lunora/scheduler [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.32...%40lunora%2Fscheduler%401.0.0-alpha.33) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13

## @lunora/scheduler [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.31...%40lunora%2Fscheduler%401.0.0-alpha.32) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12

## @lunora/scheduler [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.30...%40lunora%2Fscheduler%401.0.0-alpha.31) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11

## @lunora/scheduler [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.29...%40lunora%2Fscheduler%401.0.0-alpha.30) (2026-08-11)

## @lunora/scheduler [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.28...%40lunora%2Fscheduler%401.0.0-alpha.29) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10

## @lunora/scheduler [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.27...%40lunora%2Fscheduler%401.0.0-alpha.28) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/scheduler [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.26...%40lunora%2Fscheduler%401.0.0-alpha.27) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9

## @lunora/scheduler [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.25...%40lunora%2Fscheduler%401.0.0-alpha.26) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/scheduler [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.24...%40lunora%2Fscheduler%401.0.0-alpha.25) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8

## @lunora/scheduler [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.23...%40lunora%2Fscheduler%401.0.0-alpha.24) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7

## @lunora/scheduler [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.22...%40lunora%2Fscheduler%401.0.0-alpha.23) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/scheduler [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.21...%40lunora%2Fscheduler%401.0.0-alpha.22) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/scheduler [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.20...%40lunora%2Fscheduler%401.0.0-alpha.21) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6

## @lunora/scheduler [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.19...%40lunora%2Fscheduler%401.0.0-alpha.20) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5

## @lunora/scheduler [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.18...%40lunora%2Fscheduler%401.0.0-alpha.19) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4

## @lunora/scheduler [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.17...%40lunora%2Fscheduler%401.0.0-alpha.18) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3

## @lunora/scheduler [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.16...%40lunora%2Fscheduler%401.0.0-alpha.17) (2026-08-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.11
* **@lunora/platform:** upgraded to 1.0.0-alpha.2

## @lunora/scheduler [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.15...%40lunora%2Fscheduler%401.0.0-alpha.16) (2026-07-31)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.10

## @lunora/scheduler [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.14...%40lunora%2Fscheduler%401.0.0-alpha.15) (2026-07-31)

## @lunora/scheduler [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.13...%40lunora%2Fscheduler%401.0.0-alpha.14) (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1

## @lunora/scheduler [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.12...%40lunora%2Fscheduler%401.0.0-alpha.13) (2026-07-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.9

## @lunora/scheduler [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.11...%40lunora%2Fscheduler%401.0.0-alpha.12) (2026-07-25)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.8

## @lunora/scheduler [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.10...%40lunora%2Fscheduler%401.0.0-alpha.11) (2026-07-20)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.6

## @lunora/scheduler [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.9...%40lunora%2Fscheduler%401.0.0-alpha.10) (2026-07-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.5

## @lunora/scheduler [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.8...%40lunora%2Fscheduler%401.0.0-alpha.9) (2026-07-13)

## @lunora/scheduler [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.7...%40lunora%2Fscheduler%401.0.0-alpha.8) (2026-07-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.4

## @lunora/scheduler [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.6...%40lunora%2Fscheduler%401.0.0-alpha.7) (2026-07-08)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.3

## @lunora/scheduler [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.5...%40lunora%2Fscheduler%401.0.0-alpha.6) (2026-07-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.2

## @lunora/scheduler [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.4...%40lunora%2Fscheduler%401.0.0-alpha.5) (2026-07-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.1

## @lunora/scheduler [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fscheduler%401.0.0-alpha.3...%40lunora%2Fscheduler%401.0.0-alpha.4) (2026-07-02)

## @lunora/scheduler [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.2...@lunora/scheduler@1.0.0-alpha.3) (2026-06-27)

### Features

* **queue:** add queues, pipelines, secrets bindings + studio queues page ([#30](https://github.com/anolilab/lunora/issues/30)) ([131460c](https://github.com/anolilab/lunora/commit/131460c5826f2ef600fa0ef81248ede91835dd0c)), closes [#29](https://github.com/anolilab/lunora/issues/29) [#31](https://github.com/anolilab/lunora/issues/31) [visulima#714](https://github.com/visulima/visulima/issues/714)

## @lunora/scheduler [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/scheduler@1.0.0-alpha.1...@lunora/scheduler@1.0.0-alpha.2) (2026-06-27)

### Features

* **server:** pin durable objects to a data-residency jurisdiction ([#29](https://github.com/anolilab/lunora/issues/29)) ([0fcdc94](https://github.com/anolilab/lunora/commit/0fcdc94a836ea1b54a0eba78b6926de52aa3a767))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))
* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))

## @lunora/scheduler 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))
