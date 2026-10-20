## @lunora/platform-cloudflare [1.0.0-alpha.101](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.100...@lunora/platform-cloudflare@1.0.0-alpha.101) (2026-10-20)

### Features

* **platform:** enforce socket tag budget on every host ([#1254](https://github.com/anolilab/lunora/issues/1254)) ([867cead](https://github.com/anolilab/lunora/commit/867ceadbe10778d8acbdd9389f51cbfbcd4e8216))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.66
* **@lunora/platform:** upgraded to 1.0.0-alpha.71

## @lunora/platform-cloudflare [1.0.0-alpha.100](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.99...@lunora/platform-cloudflare@1.0.0-alpha.100) (2026-10-19)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.65

## @lunora/platform-cloudflare [1.0.0-alpha.99](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.98...@lunora/platform-cloudflare@1.0.0-alpha.99) (2026-10-19)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.64

## @lunora/platform-cloudflare [1.0.0-alpha.98](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.97...@lunora/platform-cloudflare@1.0.0-alpha.98) (2026-10-19)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.63
* **@lunora/platform:** upgraded to 1.0.0-alpha.70

## @lunora/platform-cloudflare [1.0.0-alpha.97](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.96...@lunora/platform-cloudflare@1.0.0-alpha.97) (2026-10-18)

### ⚠ BREAKING CHANGES

* **server:** SocketHost requires newPair and upgradeResponse.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): keep a route's queued frames when it fails after commit

A route handler whose writes committed and then failed in a deferred step lost
every frame it had queued, though the writes stayed durable. The route path now
absorbs a committed failure the way a room event does: it is logged and the
queued send and broadcast frames still go out. A failure before the commit still
drops them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): find the upgrade marker by a header token

The worker rebuilds every response that is not a 101, so a marker looked up by
object identity was never found, and every Node upgrade through createWorker was
answered with a 200 and closed. The marker now carries a one-time token header,
which the rebuild keeps. An unclaimed marker expires after 30 s and abandons its
pair, so the shard hears the close.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): log a synchronous webSocketMessage throw

A message hook that threw synchronously escaped the socket listener before the
rejection handler existed, so the failure was never logged. The hook now runs
inside an async function, so a synchronous throw and a rejection take the same
log path.

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

* fix(do): drop a route frame that arrives after its close

A frame delivered after a socket's close had been delivered was still dispatched to
the route handler, which then ran after teardown had cleared the socket's identity,
so it saw an empty connection id and anonymous identity. Such a frame is now
refused. The identity a queued event runs under is read when the event is queued,
so a later attachment change cannot reach a handler already in the chain.

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

* fix(do): refuse route sockets under delivery authorization

A defineWebSocket route upgrade was accepted under delivery authorization, and its
mutations ran per frame, while the broadcasts those mutations produce were
dropped. The upgrade is now refused with 501 NOT_IMPLEMENTED, as the other unsupported
delivery modes are, and the frame dispatch refuses any route socket that predates
the mode, close included.

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

* fix(codegen): emit defineWebSocket routes statically in lazy mode

With lazyFunctions on, LUNORA_FUNCTIONS holds only stubs, so the LUNORA_SOCKETS map built
by walking it was empty and every defineWebSocket route was ignored. Discovery now records
each route's literal path and auth on its FunctionIR, and lazy mode emits the map
from those values, as the room registry does. A path that is not a string literal, an
auth that is not a literal boolean, or two routes on one path is a codegen error.

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

* fix(codegen): refuse defineWebSocket routes with delivery authorization

The shard refuses a route upgrade under delivery authorization, so an app that declares
both could never serve the route. Codegen now reports that combination as a build-time
error on every target, as it already does for defineLiveStream.

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>

* docs(errors): regenerate the error code reference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* docs(platform-node): match the typed websockets capability note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): refuse anonymous frames on auth routes

The upgrade checks a route's auth requirement once, when the socket is
accepted. A socket opened on a public route keeps an anonymous attachment
after the route is changed to require a session, and its inbound frames
still reached the route's mutation. Check the requirement again per frame,
so such a socket is refused every frame, as its broadcasts already are.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): forward a live control call to relays once

A merge left the relay forwarding block in handleLiveSocketControl twice.
When no relay held the connection, the first fan-out found nothing and the
identical second one asked every relay again, so a subscribe could run on a
second round trip the caller never made. Keep one forwarding attempt.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): bind route sockets to their accepting handler

A route socket recorded only its URL path, and both its frames and its
close resolved that path against the current registrations. After a
deployment reassigned the path, an open socket dispatched its messages and
its onClose to a handler that never accepted it. Record the accepting
function on the attachment, resolve a route socket only through that
function, and fail closed for a socket that predates the record.

The same change fixes the expired-credential drop, which closes a socket
without delivering the close back to webSocketClose. A route's onClose now
runs when the drop starts, and a close the host later delivers does not run
it again.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(runtime): keep route upgrades on the owner shard

With a promoted shard, the worker spread every new WebSocket upgrade across
the shard's relays. A defineWebSocket route's handler runs on the Durable
Object that accepted the socket, so a relay ran the route's mutation
against its own storage instead of the owner's. Route upgrades now stay on
the owner. The shared subscription socket still spreads to relays, and a
route upgrade still carries the shard binding the owner's relay hub uses.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(codegen): carry socket paths into lazy builds

Three gaps made defineWebSocket routes unreachable or unbuildable in lazy
mode. The worker's route set is read off the function stubs, and the lazy
stubs carried a route's lifecycle but not its path, so no upgrade was
forwarded to the shard. Stubs now carry socketPath and auth.

Discovery accepted any string-literal path, including ones the worker could
never match or that sit under the framework prefix. It now applies the
defineWebSocket path rule and refuses others with SOCKET_PATH_INVALID.

The lazy LUNORA_SOCKETS emitter treated two export names of one
defineWebSocket call as two routes and refused the build. Each route now
records the call it came from, so aliases of one call collapse to one entry
while distinct calls on one path still fail.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(client): keep route sockets on relative urls and bounced sockets quiet

Three socket URL and credential fixes in the client.

A relative socket url (a same-origin wsUrl) threw on connect, because the
URL builders parsed it as absolute. They now parse against a placeholder
base and serialise back in the form given.

Credential rotation closed the old socket but left it as the connection's
current socket, so its late frames still reached the route's handler. The
bounce now detaches the socket first and arms the reconnect itself, so a
bounced socket delivers nothing under the old credential.

The scheduled-jobs admin socket goes back to the shard origin, as before,
instead of following a custom wsUrl's path and query.

The connectWebSocket docs no longer describe wsToken as a user credential
for route sockets; a private route needs the session cookie.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): survive a reset and a shutdown during an upgrade

An upgrade waits on the worker's fetch, which can run a route's onOpen. In
that window the raw socket had no 'error' listener, so a client reset (or a
write to a socket it had already reset) was an unhandled error that ended
the process. The socket now has an error listener that destroys it; the
close that follows aborts the fetch and abandons the pair.

close() terminated only upgraded clients. A raw socket still awaiting its
fetch was in neither set, so a fetch that never settled held the server
open. Pending upgrade sockets are now tracked and destroyed on close.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* chore(api): record the route socket fields in the api snapshots

The route-binding and path-validation fixes add an internal socket function
field to the shard attachment, an origin to the codegen function IR, and the
SOCKET_PATH_INVALID error code. Snapshot regenerated with api:update.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): correct the socket test fixture and discovered route type

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(client): keep the host of a protocol-relative socket url

A `wsUrl` such as `//edge.example/_lunora/ws` was serialised as a bare path, so custom route
sockets opened against the page's origin instead of the configured host.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(client): guard a route's onMessage like its other callbacks

A throwing `onMessage`, or a frame `decodeWire` rejects, now goes through the same guard as
`onOpen`/`onClose` and is logged as a route handler failure. Before, it surfaced only as a
generic frame handler error one layer down.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): let socket close handlers finish before disposal

`NodeHttpServer.close()` resolved once the HTTP server closed, without waiting for the terminated
WebSockets to fire their close events, so a registry closed right after it could dispose a shard's
database while a route's close handler was still writing. `close()` now waits for those events. The
socket host tracks close handlers still running (`drain()`), and the registry disposes a shard only
once they settle.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(client): clear the connect timer of a bounced socket

A credential rotation that bounced a socket still connecting left that attempt's connect timeout
armed. When it fired, it cleared the replacement attempt's timer handle, so the replacement's own
timeout later force-closed a socket that had already opened.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): cancel a refusal body once its client has gone

A refused upgrade's response body was read to the end with `arrayBuffer()`, so a streaming refusal
kept being consumed after the client disconnected. The body is now read through a reader that the
socket's close cancels.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): match a mixed-case Upgrade under delivery authorization

The delivery-authorization branch of `fetch()` compared `Upgrade` to `websocket` exactly, so an
upgrade sending `WebSocket` fell through to a 501. A route socket that sends a frame that is not
valid JSON is now logged before the frame is dropped.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): contain a synchronous throw from a socket handler

A close or message handler registered on `inbound` directly could throw inside a `ws` event or the
upgrade marker timer, where nothing caught it. A close throw is now treated as a rejection, so the
socket is still released, and a message throw is logged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* docs(server): drop the re-export step from the defineWebSocket example

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* perf(do): decide the route topic check once per whisper fan-out

The local whisper fan-out called the route-topic check for every member, though only a route topic
needs it. The prefix test now runs once per fan-out, so an ordinary whisper adds no call per socket.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(do): encode a route frame when socket.send is called

Queued route frames held a structured clone of the payload, which turned a class instance into a
plain object, so the wire encoder never refused it and the client got a lossy copy. The frame is
now encoded at the call: it carries the payload as it was then, and an unencodable value throws
inside the handler, as a room broadcast would.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(platform-node): cap the body relayed for a refused upgrade

A refused upgrade read the response body whole before writing it, so a large or endless body was
buffered per pending connection. At most 64 KiB is relayed now; past that the body is cancelled.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* fix(client): reset a route socket backoff only once it is stable

An accepted route upgrade reset the reconnect backoff at once, but the shard can drop the socket
right after (an expired identity), so such a socket reconnected at the initial delay forever. The
backoff now resets after the socket stays open for the stability window, as the main connection
does. Closing a route socket that throws no longer stops the other teardowns or the reconnect.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

### Features

* **server:** typed custom WebSocket routes (defineWebSocket) ([#1219](https://github.com/anolilab/lunora/issues/1219)) ([47705c1](https://github.com/anolilab/lunora/commit/47705c19e8bd9600d133ad6b9874e9ef61fcd685))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.62
* **@lunora/platform:** upgraded to 1.0.0-alpha.69

## @lunora/platform-cloudflare [1.0.0-alpha.96](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.95...@lunora/platform-cloudflare@1.0.0-alpha.96) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.61

## @lunora/platform-cloudflare [1.0.0-alpha.95](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.94...@lunora/platform-cloudflare@1.0.0-alpha.95) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.60
* **@lunora/platform:** upgraded to 1.0.0-alpha.68

## @lunora/platform-cloudflare [1.0.0-alpha.94](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.93...@lunora/platform-cloudflare@1.0.0-alpha.94) (2026-10-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.67

## @lunora/platform-cloudflare [1.0.0-alpha.93](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.92...@lunora/platform-cloudflare@1.0.0-alpha.93) (2026-10-18)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.59

## @lunora/platform-cloudflare [1.0.0-alpha.92](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.91...@lunora/platform-cloudflare@1.0.0-alpha.92) (2026-10-17)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.58

## @lunora/platform-cloudflare [1.0.0-alpha.91](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.90...@lunora/platform-cloudflare@1.0.0-alpha.91) (2026-10-17)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.66

## @lunora/platform-cloudflare [1.0.0-alpha.90](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.89...@lunora/platform-cloudflare@1.0.0-alpha.90) (2026-10-16)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.57
* **@lunora/platform:** upgraded to 1.0.0-alpha.65

## @lunora/platform-cloudflare [1.0.0-alpha.89](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.88...@lunora/platform-cloudflare@1.0.0-alpha.89) (2026-10-15)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.56

## @lunora/platform-cloudflare [1.0.0-alpha.88](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.87...@lunora/platform-cloudflare@1.0.0-alpha.88) (2026-10-15)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.55

## @lunora/platform-cloudflare [1.0.0-alpha.87](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.86...@lunora/platform-cloudflare@1.0.0-alpha.87) (2026-10-14)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.64

## @lunora/platform-cloudflare [1.0.0-alpha.86](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.85...@lunora/platform-cloudflare@1.0.0-alpha.86) (2026-10-14)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.63

## @lunora/platform-cloudflare [1.0.0-alpha.85](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.84...@lunora/platform-cloudflare@1.0.0-alpha.85) (2026-10-14)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.62

## @lunora/platform-cloudflare [1.0.0-alpha.84](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.83...@lunora/platform-cloudflare@1.0.0-alpha.84) (2026-10-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.54

## @lunora/platform-cloudflare [1.0.0-alpha.83](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.82...@lunora/platform-cloudflare@1.0.0-alpha.83) (2026-10-13)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.61

## @lunora/platform-cloudflare [1.0.0-alpha.82](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.81...@lunora/platform-cloudflare@1.0.0-alpha.82) (2026-10-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.53

## @lunora/platform-cloudflare [1.0.0-alpha.81](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.80...@lunora/platform-cloudflare@1.0.0-alpha.81) (2026-10-12)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.60

## @lunora/platform-cloudflare [1.0.0-alpha.80](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.79...@lunora/platform-cloudflare@1.0.0-alpha.80) (2026-10-12)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.59

## @lunora/platform-cloudflare [1.0.0-alpha.79](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.78...@lunora/platform-cloudflare@1.0.0-alpha.79) (2026-10-08)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.58

## @lunora/platform-cloudflare [1.0.0-alpha.78](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.77...@lunora/platform-cloudflare@1.0.0-alpha.78) (2026-10-08)

### Bug Fixes

* **notify:** errors range, per-message urgency, channel secrets, SW hang ([#1043](https://github.com/anolilab/lunora/issues/1043)) ([f0e6b1c](https://github.com/anolilab/lunora/commit/f0e6b1cea73d9f5f05b793a1ebf79306e159c148))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.52

## @lunora/platform-cloudflare [1.0.0-alpha.77](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.76...@lunora/platform-cloudflare@1.0.0-alpha.77) (2026-10-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.51

## @lunora/platform-cloudflare [1.0.0-alpha.76](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.75...@lunora/platform-cloudflare@1.0.0-alpha.76) (2026-10-06)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.57

## @lunora/platform-cloudflare [1.0.0-alpha.75](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.74...@lunora/platform-cloudflare@1.0.0-alpha.75) (2026-10-06)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.56

## @lunora/platform-cloudflare [1.0.0-alpha.74](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.73...@lunora/platform-cloudflare@1.0.0-alpha.74) (2026-10-03)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.55

## @lunora/platform-cloudflare [1.0.0-alpha.73](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.72...@lunora/platform-cloudflare@1.0.0-alpha.73) (2026-10-03)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.54

## @lunora/platform-cloudflare [1.0.0-alpha.72](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.71...@lunora/platform-cloudflare@1.0.0-alpha.72) (2026-10-03)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.53

## @lunora/platform-cloudflare [1.0.0-alpha.71](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.70...@lunora/platform-cloudflare@1.0.0-alpha.71) (2026-10-03)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.50
* **@lunora/platform:** upgraded to 1.0.0-alpha.52

## @lunora/platform-cloudflare [1.0.0-alpha.70](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.69...@lunora/platform-cloudflare@1.0.0-alpha.70) (2026-10-03)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.51

## @lunora/platform-cloudflare [1.0.0-alpha.69](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.68...@lunora/platform-cloudflare@1.0.0-alpha.69) (2026-10-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.49
* **@lunora/platform:** upgraded to 1.0.0-alpha.50

## @lunora/platform-cloudflare [1.0.0-alpha.68](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.67...@lunora/platform-cloudflare@1.0.0-alpha.68) (2026-10-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.49

## @lunora/platform-cloudflare [1.0.0-alpha.67](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.66...@lunora/platform-cloudflare@1.0.0-alpha.67) (2026-10-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.48

## @lunora/platform-cloudflare [1.0.0-alpha.66](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.65...@lunora/platform-cloudflare@1.0.0-alpha.66) (2026-10-01)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.47

## @lunora/platform-cloudflare [1.0.0-alpha.65](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.64...@lunora/platform-cloudflare@1.0.0-alpha.65) (2026-09-30)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.48
* **@lunora/platform:** upgraded to 1.0.0-alpha.46

## @lunora/platform-cloudflare [1.0.0-alpha.64](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.63...@lunora/platform-cloudflare@1.0.0-alpha.64) (2026-09-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.45

## @lunora/platform-cloudflare [1.0.0-alpha.63](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.62...@lunora/platform-cloudflare@1.0.0-alpha.63) (2026-09-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.44

## @lunora/platform-cloudflare [1.0.0-alpha.62](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.61...@lunora/platform-cloudflare@1.0.0-alpha.62) (2026-09-29)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.43

## @lunora/platform-cloudflare [1.0.0-alpha.61](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.60...@lunora/platform-cloudflare@1.0.0-alpha.61) (2026-09-28)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.42

## @lunora/platform-cloudflare [1.0.0-alpha.60](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.59...@lunora/platform-cloudflare@1.0.0-alpha.60) (2026-09-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.47

## @lunora/platform-cloudflare [1.0.0-alpha.59](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.58...@lunora/platform-cloudflare@1.0.0-alpha.59) (2026-09-27)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.46

## @lunora/platform-cloudflare [1.0.0-alpha.58](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.57...@lunora/platform-cloudflare@1.0.0-alpha.58) (2026-09-27)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.45

## @lunora/platform-cloudflare [1.0.0-alpha.57](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.56...@lunora/platform-cloudflare@1.0.0-alpha.57) (2026-09-26)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.41

## @lunora/platform-cloudflare [1.0.0-alpha.56](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.55...@lunora/platform-cloudflare@1.0.0-alpha.56) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.44
* **@lunora/platform:** upgraded to 1.0.0-alpha.40

## @lunora/platform-cloudflare [1.0.0-alpha.55](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.54...@lunora/platform-cloudflare@1.0.0-alpha.55) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.43

## @lunora/platform-cloudflare [1.0.0-alpha.54](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.53...@lunora/platform-cloudflare@1.0.0-alpha.54) (2026-09-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.42

## @lunora/platform-cloudflare [1.0.0-alpha.53](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.52...@lunora/platform-cloudflare@1.0.0-alpha.53) (2026-09-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.39

## @lunora/platform-cloudflare [1.0.0-alpha.52](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.51...@lunora/platform-cloudflare@1.0.0-alpha.52) (2026-09-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.38

## @lunora/platform-cloudflare [1.0.0-alpha.51](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.50...@lunora/platform-cloudflare@1.0.0-alpha.51) (2026-09-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.37

## @lunora/platform-cloudflare [1.0.0-alpha.50](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.49...@lunora/platform-cloudflare@1.0.0-alpha.50) (2026-09-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.36

## @lunora/platform-cloudflare [1.0.0-alpha.49](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.48...@lunora/platform-cloudflare@1.0.0-alpha.49) (2026-09-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.34

## @lunora/platform-cloudflare [1.0.0-alpha.48](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.47...@lunora/platform-cloudflare@1.0.0-alpha.48) (2026-09-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.41

## @lunora/platform-cloudflare [1.0.0-alpha.47](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.46...@lunora/platform-cloudflare@1.0.0-alpha.47) (2026-09-24)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.40

## @lunora/platform-cloudflare [1.0.0-alpha.46](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.45...@lunora/platform-cloudflare@1.0.0-alpha.46) (2026-09-23)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.33

## @lunora/platform-cloudflare [1.0.0-alpha.45](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.44...@lunora/platform-cloudflare@1.0.0-alpha.45) (2026-09-13)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.39

## @lunora/platform-cloudflare [1.0.0-alpha.44](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.43...@lunora/platform-cloudflare@1.0.0-alpha.44) (2026-09-13)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.38

## @lunora/platform-cloudflare [1.0.0-alpha.43](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.42...@lunora/platform-cloudflare@1.0.0-alpha.43) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.37

## @lunora/platform-cloudflare [1.0.0-alpha.42](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.41...@lunora/platform-cloudflare@1.0.0-alpha.42) (2026-09-12)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.32

## @lunora/platform-cloudflare [1.0.0-alpha.41](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.40...@lunora/platform-cloudflare@1.0.0-alpha.41) (2026-09-12)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.31

## @lunora/platform-cloudflare [1.0.0-alpha.40](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.39...@lunora/platform-cloudflare@1.0.0-alpha.40) (2026-09-12)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.36
* **@lunora/platform:** upgraded to 1.0.0-alpha.30

## @lunora/platform-cloudflare [1.0.0-alpha.39](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.38...@lunora/platform-cloudflare@1.0.0-alpha.39) (2026-09-10)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.29

## @lunora/platform-cloudflare [1.0.0-alpha.38](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.37...@lunora/platform-cloudflare@1.0.0-alpha.38) (2026-09-08)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.28

## @lunora/platform-cloudflare [1.0.0-alpha.37](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.36...@lunora/platform-cloudflare@1.0.0-alpha.37) (2026-09-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.35

## @lunora/platform-cloudflare [1.0.0-alpha.36](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.35...@lunora/platform-cloudflare@1.0.0-alpha.36) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.34

## @lunora/platform-cloudflare [1.0.0-alpha.35](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.34...@lunora/platform-cloudflare@1.0.0-alpha.35) (2026-09-06)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.33

## @lunora/platform-cloudflare [1.0.0-alpha.34](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.33...@lunora/platform-cloudflare@1.0.0-alpha.34) (2026-09-05)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.27

## @lunora/platform-cloudflare [1.0.0-alpha.33](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.32...@lunora/platform-cloudflare@1.0.0-alpha.33) (2026-09-05)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.32

## @lunora/platform-cloudflare [1.0.0-alpha.32](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.31...@lunora/platform-cloudflare@1.0.0-alpha.32) (2026-09-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.31
* **@lunora/platform:** upgraded to 1.0.0-alpha.26

## @lunora/platform-cloudflare [1.0.0-alpha.31](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.30...@lunora/platform-cloudflare@1.0.0-alpha.31) (2026-09-03)

### ⚠ BREAKING CHANGES

* 34 public API changes across mail, storage, payment, replica,
studio, workflow, agent, codegen, cli and the shard runtime. The full list is in

### Bug Fixes

* audit rounds 7-11 ([#579](https://github.com/anolilab/lunora/issues/579)) ([224a42a](https://github.com/anolilab/lunora/commit/224a42a741f524e0110da55917c79fd08c90a885))


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.30
* **@lunora/platform:** upgraded to 1.0.0-alpha.25

## @lunora/platform-cloudflare [1.0.0-alpha.30](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.29...@lunora/platform-cloudflare@1.0.0-alpha.30) (2026-09-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.29
* **@lunora/platform:** upgraded to 1.0.0-alpha.24

## @lunora/platform-cloudflare [1.0.0-alpha.29](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.28...@lunora/platform-cloudflare@1.0.0-alpha.29) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.28

## @lunora/platform-cloudflare [1.0.0-alpha.28](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.27...@lunora/platform-cloudflare@1.0.0-alpha.28) (2026-09-01)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.27
* **@lunora/platform:** upgraded to 1.0.0-alpha.23

## @lunora/platform-cloudflare [1.0.0-alpha.27](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.26...@lunora/platform-cloudflare@1.0.0-alpha.27) (2026-08-31)

### Bug Fixes

* close the silent-success class across all 55 packages ([#536](https://github.com/anolilab/lunora/issues/536)) ([dad6b74](https://github.com/anolilab/lunora/commit/dad6b74b79dd336b13f0b922a6ab32d3345c9657))


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.22

## @lunora/platform-cloudflare [1.0.0-alpha.26](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.25...@lunora/platform-cloudflare@1.0.0-alpha.26) (2026-08-29)

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

* **@lunora/errors:** upgraded to 1.0.0-alpha.26
* **@lunora/platform:** upgraded to 1.0.0-alpha.21

## @lunora/platform-cloudflare [1.0.0-alpha.25](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.24...@lunora/platform-cloudflare@1.0.0-alpha.25) (2026-08-28)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.25
* **@lunora/platform:** upgraded to 1.0.0-alpha.20

## @lunora/platform-cloudflare [1.0.0-alpha.24](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.23...@lunora/platform-cloudflare@1.0.0-alpha.24) (2026-08-27)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.19

## @lunora/platform-cloudflare [1.0.0-alpha.23](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.22...@lunora/platform-cloudflare@1.0.0-alpha.23) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.24
* **@lunora/platform:** upgraded to 1.0.0-alpha.18

## @lunora/platform-cloudflare [1.0.0-alpha.22](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.21...@lunora/platform-cloudflare@1.0.0-alpha.22) (2026-08-26)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.23

## @lunora/platform-cloudflare [1.0.0-alpha.21](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.20...@lunora/platform-cloudflare@1.0.0-alpha.21) (2026-08-25)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.17

## @lunora/platform-cloudflare [1.0.0-alpha.20](https://github.com/anolilab/lunora/compare/@lunora/platform-cloudflare@1.0.0-alpha.19...@lunora/platform-cloudflare@1.0.0-alpha.20) (2026-08-23)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.15

## @lunora/platform-cloudflare [1.0.0-alpha.19](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.18...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.19) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.14

## @lunora/platform-cloudflare [1.0.0-alpha.18](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.17...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.18) (2026-08-18)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.13

## @lunora/platform-cloudflare [1.0.0-alpha.17](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.16...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.17) (2026-08-15)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.12

## @lunora/platform-cloudflare [1.0.0-alpha.16](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.15...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.16) (2026-08-14)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.22
* **@lunora/platform:** upgraded to 1.0.0-alpha.11

## @lunora/platform-cloudflare [1.0.0-alpha.15](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.14...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.15) (2026-08-11)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.21
* **@lunora/platform:** upgraded to 1.0.0-alpha.10

## @lunora/platform-cloudflare [1.0.0-alpha.14](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.13...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.14) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.20

## @lunora/platform-cloudflare [1.0.0-alpha.13](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.12...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.13) (2026-08-10)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.19
* **@lunora/platform:** upgraded to 1.0.0-alpha.9

## @lunora/platform-cloudflare [1.0.0-alpha.12](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.11...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.12) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.18

## @lunora/platform-cloudflare [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.10...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.11) (2026-08-09)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.17
* **@lunora/platform:** upgraded to 1.0.0-alpha.8

## @lunora/platform-cloudflare [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.9...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.10) (2026-08-07)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.7

## @lunora/platform-cloudflare [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.8...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.9) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.16

## @lunora/platform-cloudflare [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.7...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.8) (2026-08-07)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.15

## @lunora/platform-cloudflare [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.6...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.7) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.14
* **@lunora/platform:** upgraded to 1.0.0-alpha.6

## @lunora/platform-cloudflare [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.5...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.6) (2026-08-04)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.13
* **@lunora/platform:** upgraded to 1.0.0-alpha.5

## @lunora/platform-cloudflare [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.4...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.5) (2026-08-02)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.4

## @lunora/platform-cloudflare [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.3...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.4) (2026-08-02)

## @lunora/platform-cloudflare [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.2...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.3) (2026-08-02)


### Dependencies

* **@lunora/errors:** upgraded to 1.0.0-alpha.12
* **@lunora/platform:** upgraded to 1.0.0-alpha.3

## @lunora/platform-cloudflare [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/%40lunora%2Fplatform-cloudflare%401.0.0-alpha.1...%40lunora%2Fplatform-cloudflare%401.0.0-alpha.2) (2026-08-01)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.2

## @lunora/platform-cloudflare 1.0.0-alpha.1 (2026-07-30)


### Dependencies

* **@lunora/platform:** upgraded to 1.0.0-alpha.1
