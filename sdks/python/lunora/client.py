"""A minimal, protocol-conformant Lunora client.

Implements the transport documented in ``protocol/README.md``:

- ``query`` / ``mutation`` round-trips over ``POST /_lunora/rpc``.
- Live ``subscribe`` over the WebSocket ``data``/``delta``/``ack``/``error``/
  ``resume``/``settled`` frames.
- ``subscribe_shape`` over the poke (``pokeStart``/``pokePart``/``pokeEnd``) path.
- An async WS token provider mirroring the TS ``WsTokenProvider``.
- ``submit`` — the offline-capable write path: optimistic layers over the live
  subscriptions (``lunora.optimistic``) plus the durable replay queue
  (``lunora.offline``). It lives in ``lunora.submit``; this file keeps the
  socket, the subscription registry and the frame dispatch.

The wire framing (frame builders + the inbound-frame dispatcher) is factored into
pure functions/methods so it is unit-testable against the shared golden fixtures
with no network. The HTTP transport is injectable; the optional live WebSocket
loop uses the ``websockets`` package when present.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import threading
import urllib.request
from collections.abc import AsyncIterator, Awaitable
from functools import partial
from typing import Any, Callable, Optional, Union

from .errors import LunoraError, SubscriptionError
from .offline import OfflineQueue, random_id
from .optimistic import drop_confirmed_layers, fold_optimistic
from .submit import (
    FlushReport,
    MutationOutcome,
    MutationSettled,
    SubmitOptions,
    close_queue,
    flush_queue,
    hydrate_queue,
    submit_write,
)
from .wire import WireFormatError, decode_wire, encode_wire, stable_wire_key

RPC_PATH = "/_lunora/rpc"
RPC_BATCH_PATH = "/_lunora/rpc-batch"
WS_PATH = "/_lunora/ws"

# `urllib.request.urlopen`'s own default is no timeout at all — the socket
# blocks forever against a server that accepts and never replies. 30s is
# generous enough for a slow `action` while still being finite; override via
# `LunoraClient(..., timeout=...)` for a longer-running one.
DEFAULT_HTTP_TIMEOUT = 30.0

# How many un-applied poke buffers to retain before evicting the oldest. A poke
# is only removed at its ``pokeEnd``; a socket that drops mid-poke leaves its
# buffer behind with no ``pokeEnd`` ever coming, so without a bound they
# accumulate for the life of the client — one per reconnect, and one per poke a
# hostile peer opens and never closes. Concurrent in-flight pokes number in the
# low single digits, so this is far above any legitimate working set.
MAX_PENDING_POKES = 64

# A WS token provider: a value, a callable returning a value, or an async callable.
WsToken = Union[str, Callable[[], Union[str, Awaitable[Optional[str]], None]], None]

Callback = Callable[[Any], None]
ErrorCallback = Callable[[SubscriptionError], None]
Unsubscribe = Callable[[], None]


# --- Pure framing helpers (no I/O; fixture-tested) --------------------------


def build_rpc_body(function_path: str, args: Any, shard_key: Optional[str] = None) -> dict:
    """Build the ``POST /_lunora/rpc`` JSON body. ``shard_key`` is omitted when empty.

    Empty means absent, not "the shard named ``''``". The runtime disagrees — it
    takes any string as a named shard and routes ``""`` to its own Durable Object
    (``packages/runtime/src/create-worker.ts``) — while this client treats ``""``
    and ``None`` as one shard everywhere it matches a subscription or drains the
    queue. Sending it would split those two views: a write submitted with ``""``
    would replay against a different shard than the subscription it updated.
    """

    body: dict[str, Any] = {"args": encode_wire(args if args is not None else {}), "functionPath": function_path}
    if shard_key:
        body["shardKey"] = shard_key
    return body


def parse_commit_cursor(body: dict) -> Optional[int]:
    """The CDC cursor a write committed at, echoed on a mutation's response.

    ``None`` when the shard has CDC off (or the call was a read), which is the
    degraded case the optimistic engine falls back to one-shot behaviour for.
    """

    cursor = body.get("commitCursor")

    return cursor if isinstance(cursor, int) and not isinstance(cursor, bool) else None


def parse_rpc_response(body: dict, status: int) -> Any:
    """Return ``decode_wire(result)`` or raise :class:`LunoraError`.

    ``status`` is required — not defaulted — for correctness: ``protocol/README.md``
    §4.2 says a non-2xx response whose body carries no ``error`` envelope is
    surfaced as an ``INTERNAL`` transport error. Without the check, a 502 with
    body ``{"message": "bad gateway"}`` returns ``None`` and no exception — the
    caller believes its mutation committed.
    """

    if "error" in body:
        err = body["error"]
        data = decode_wire(err["data"]) if "data" in err and err["data"] is not None else None
        # A 5xx is the shard or the edge failing under the call, not a verdict on
        # it, so a queued write replayed under the same idempotency key is still
        # good. See `lunora.submit.is_transient`.
        raise LunoraError(err.get("code", "INTERNAL"), err.get("message", "request failed"), data, transient=status >= 500)

    if not 200 <= status <= 299:
        # No envelope at all, so this body never came from a Lunora function: an
        # edge error page, a WAF block, a proxy. Nothing reached the shard, which
        # makes it transport rather than a verdict — the batch path already
        # classified the identical response that way, and a lone queued write
        # must not be dropped for being alone.
        raise LunoraError("INTERNAL", f"HTTP {status} without an error envelope", transient=True)

    return decode_wire(body.get("result"))


def build_connect_frame(client_id: Optional[str], context: Optional[dict] = None) -> dict:
    frame: dict[str, Any] = {"id": "connect", "type": "connect"}
    if client_id is not None:
        frame["clientId"] = client_id
    if context is not None:
        frame["context"] = context
    return frame


def build_subscribe_frame(
    sub_id: str,
    function_path: str,
    args: Any,
    table: Optional[str] = None,
    since_seq: Optional[int] = None,
    since_epoch: Optional[str] = None,
) -> dict:
    query: dict[str, Any] = {
        "args": encode_wire(args if args is not None else {}),
        "functionPath": function_path,
        "table": table if table is not None else function_path,
    }
    if since_seq is not None:
        query["sinceSeq"] = since_seq
    if since_epoch is not None:
        query["sinceEpoch"] = since_epoch
    return {"id": sub_id, "query": query, "type": "subscribe"}


def build_unsubscribe_frame(sub_id: str) -> dict:
    return {"id": sub_id, "type": "unsubscribe"}


def build_shape_subscribe_frame(
    shape_id: str,
    name: str,
    args: Any = None,
    since_checkpoint: Optional[int] = None,
    since_epoch: Optional[str] = None,
) -> dict:
    shape: dict[str, Any] = {"name": name}
    if args is not None:
        shape["args"] = encode_wire(args)
    frame: dict[str, Any] = {"id": shape_id, "shape": shape, "type": "shape_subscribe"}
    if since_checkpoint is not None:
        frame["sinceCheckpoint"] = since_checkpoint
    if since_epoch is not None:
        frame["sinceEpoch"] = since_epoch
    return frame


def _derive_ws_url(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    return url


def _join(base: str, path: str) -> str:
    return (base.removesuffix("/")) + path


# --- Client -----------------------------------------------------------------


class _Subscription:
    def __init__(self, sub_id: str, function_path: str, args: Any, shard_key: Optional[str]) -> None:
        self.id = sub_id
        self.function_path = function_path
        self.args = args
        self.args_key = stable_wire_key(args if args is not None else {})
        self.shard_key = shard_key
        self.acked = False
        self.server_cursor: Optional[int] = None
        self.server_epoch: Optional[str] = None
        #: The authoritative server value, with NO optimistic overlay. Tracks
        #: ``last_value`` exactly while no layer is active, and is what the
        #: layers fold onto when one is.
        self.server_base: Any = None
        #: The DISPLAYED value: ``server_base`` folded through
        #: ``optimistic_layers``.
        self.last_value: Any = None
        #: Active optimistic layers, in application order. Empty for the common
        #: case — no pending optimistic write — where this subscription behaves
        #: exactly as a plain server-value assignment.
        self.optimistic_layers: list = []
        self.callbacks: list[Callback] = []
        self.error_callbacks: list[ErrorCallback] = []


class _ShapeSubscription:
    def __init__(self, shape_id: str, name: str, args: Any, shard_key: Optional[str]) -> None:
        self.id = shape_id
        self.name = name
        self.args = args
        self.shard_key = shard_key
        self.rows: dict[str, Any] = {}
        self.server_cursor: Optional[int] = None
        self.server_epoch: Optional[str] = None
        self.callbacks: list[Callable[[list], None]] = []
        self.error_callbacks: list[ErrorCallback] = []


class LunoraClient:
    def __init__(
        self,
        url: str,
        ws_url: Optional[str] = None,
        auth_token: Optional[str] = None,
        ws_token: WsToken = None,
        client_id: Optional[str] = None,
        http_post: Optional[Callable[[str, dict, bytes], tuple[int, dict]]] = None,
        timeout: float = DEFAULT_HTTP_TIMEOUT,
        offline_queue: Optional[OfflineQueue] = None,
        identity: Optional[str] = None,
    ) -> None:
        self.url = url
        self.ws_url = ws_url if ws_url is not None else _join(_derive_ws_url(url), WS_PATH)
        self.auth_token = auth_token
        self.ws_token = ws_token
        #: Minted PER INSTANCE when not given, from the same helper that mints
        #: mutation ids. It is not cosmetic: the shard namespaces an anonymous
        #: caller's idempotency rows by this value, so a constant shared by every
        #: client in the language means two unauthenticated users submitting the
        #: same caller-supplied ``mutation_id`` collide — the second write
        #: short-circuits to the first user's cached result and never runs.
        #:
        #: Pin one when the offline queue is DURABLE: a write replays under the
        #: id that issued it (the record carries it), and a stable per-device id
        #: keeps a restored write in the same namespace it was submitted in.
        self.client_id = client_id if client_id is not None else f"client-{random_id()}"
        # `timeout` only applies to the default transport: a caller who injects
        # their own `http_post` keeps whatever timeout semantics it already has.
        self._http_post = http_post if http_post is not None else partial(_urllib_post, timeout=timeout)
        #: The durable write queue. Pass one preconfigured (capacity, persistence
        #: adapter, app version) or take the in-memory default.
        self.offline_queue = offline_queue if offline_queue is not None else OfflineQueue()
        #: An opaque, stable, NON-SECRET stamp for whoever is signed in — a user
        #: id, not a bearer token. It is persisted alongside every queued write
        #: and re-checked before the write replays, so a restart cannot push one
        #: user's queued writes as another. ``None`` means signed out, which is
        #: itself an identity a write can be stamped with.
        self.identity = identity
        self._settled_listeners: list[Callable[[MutationSettled], None]] = []
        #: `time.monotonic()` before which a flush is a no-op, set when a replay
        #: came back rate-limited and the envelope named a delay. Monotonic, so a
        #: wall-clock adjustment cannot strand a queue for hours.
        self._flush_not_before = 0.0
        self._was_ever_connected = False
        self._closed = False
        self._subs: dict[str, _Subscription] = {}
        self._shapes: dict[str, _ShapeSubscription] = {}
        self._poke_buffers: dict[str, dict] = {}
        self._next_sub_id = 0
        self._next_shape_id = 0
        self._send: Optional[Callable[[dict], None]] = None
        # Guards the registries, the id counters, the attached sender and the
        # per-subscription cursor/epoch. `subscribe`, `subscribe_shape`,
        # `handle_frame` and `resend_subscriptions` are plain synchronous methods,
        # so a real consumer calls them from different OS threads: the WS read loop
        # dispatches frames while application code subscribes from a request
        # handler or worker pool. A `threading.Lock` is therefore the right tool
        # and an `asyncio.Lock` would be the wrong one — the latter only orders
        # coroutines on a single event loop and cannot be acquired off it.
        #
        # The GIL is not a substitute. It makes each bytecode atomic, not each
        # statement: `self._next_sub_id += 1` followed by a separate read of it is
        # two operations, and a switch in between hands two threads the same id,
        # so the second `self._subs[sub_id] = sub` silently forgets a live
        # subscription. Walking `self._subs` while another thread inserts raises
        # `RuntimeError: dictionary changed size during iteration` outright.
        self._lock = threading.Lock()

    # --- Socket lifecycle ---------------------------------------------------

    def attach_socket(self, send: Callable[[dict], None]) -> None:
        """Register the sender subscription frames go out on; marks the client online.

        Also latches "has connected at least once", which is what the offline
        queue gates on: writes made before the FIRST connect fail fast by default,
        so a misconfigured endpoint surfaces on the first write instead of
        silently accumulating a queue that will never flush. Opt out with
        ``OfflineQueue(queue_before_first_connect=True)``.
        """

        with self._lock:
            self._send = send
            self._was_ever_connected = True

    def detach_socket(self) -> None:
        """Forget the sender; marks the client offline so writes queue."""

        with self._lock:
            self._send = None

    @property
    def online(self) -> bool:
        with self._lock:
            return self._send is not None

    @property
    def pending_mutation_count(self) -> int:
        """How many writes are waiting for the socket."""

        with self._lock:
            return self.offline_queue.size

    def on_mutation_settled(self, listener: Callable[[MutationSettled], None]) -> Callable[[], None]:
        """Observe every queued write's terminal verdict; returns an unsubscribe.

        This is the ONLY report a write restored from durable storage produces —
        its original caller did not survive the restart.
        """

        with self._lock:
            self._settled_listeners.append(listener)

        def remove() -> None:
            with self._lock:
                if listener in self._settled_listeners:
                    self._settled_listeners.remove(listener)

        return remove

    def close(self) -> None:
        """Reject every queued write so no caller waits on a dead client.

        Durable storage is untouched: the next session restores those writes.
        """

        close_queue(self)

    # --- HTTP RPC -----------------------------------------------------------

    async def query(self, function_path: str, args: Any = None, shard_key: Optional[str] = None) -> Any:
        return await self._rpc(function_path, args, shard_key, mutation_id=None)

    async def mutation(self, function_path: str, args: Any = None, shard_key: Optional[str] = None, mutation_id: Optional[str] = None) -> Any:
        """Invoke a mutation over HTTP, right now.

        This is the direct write path and it fails when the deployment is
        unreachable. For a write that should survive a dropped socket — queued,
        replayed in order, optionally with an optimistic overlay — use
        :meth:`submit`.
        """

        return await self._rpc(function_path, args, shard_key, mutation_id=mutation_id)

    async def action(self, function_path: str, args: Any = None, shard_key: Optional[str] = None) -> Any:
        """Invoke an ``action``.

        Same RPC envelope as a mutation, but no ``x-lunora-mutation-id``: an
        action performs external side effects (it is not replayed against the
        shard), so an idempotency key would promise a de-duplication the server
        does not do for it.
        """

        return await self._rpc(function_path, args, shard_key, mutation_id=None)

    async def _rpc(self, function_path: str, args: Any, shard_key: Optional[str], mutation_id: Optional[str]) -> Any:
        value, _ = await self._rpc_full(function_path, args, shard_key, mutation_id)
        return value

    async def _rpc_full(
        self,
        function_path: str,
        args: Any,
        shard_key: Optional[str],
        mutation_id: Optional[str],
        client_id: Optional[str] = None,
    ) -> tuple:
        """One RPC round-trip, returning ``(result, commit_cursor)``.

        The commit cursor is what gates an optimistic overlay's removal, so it
        must survive the call rather than be discarded by ``parse_rpc_response``.
        """

        headers = {"content-type": "application/json"}
        if self.auth_token:
            headers["authorization"] = f"Bearer {self.auth_token}"
        if mutation_id is not None:
            headers["x-lunora-mutation-id"] = mutation_id
            # Rides WITH the idempotency key, never alone. An anonymous caller has
            # no server-minted user id, so the shard namespaces its de-duplication
            # rows by this client id instead; without one every anonymous client
            # shares a single key space and a colliding mutation id suppresses
            # another client's write.
            headers["x-lunora-client-id"] = client_id if client_id is not None else self.client_id
        body = json.dumps(build_rpc_body(function_path, args, shard_key)).encode("utf-8")
        status, parsed = await asyncio.get_event_loop().run_in_executor(None, lambda: self._http_post(_join(self.url, RPC_PATH), headers, body))
        return parse_rpc_response(parsed, status), parse_commit_cursor(parsed)

    async def _rpc_batch(self, calls: list) -> dict:
        """POST one ``/_lunora/rpc-batch`` chunk, returning the parsed body.

        No ``x-lunora-mutation-id`` on the request: a batch is ONE transport hop
        carrying independent calls, so each entry carries its own idempotency key
        and client id in the body. A single outer header would name one write and
        de-duplicate the whole chunk against it.
        """

        headers = {"content-type": "application/json"}
        if self.auth_token:
            headers["authorization"] = f"Bearer {self.auth_token}"
        body = json.dumps({"calls": calls}).encode("utf-8")
        _status, parsed = await asyncio.get_event_loop().run_in_executor(None, lambda: self._http_post(_join(self.url, RPC_BATCH_PATH), headers, body))
        return parsed if isinstance(parsed, dict) else {}

    # --- Offline-capable writes ---------------------------------------------
    #
    # The write path itself lives in `lunora.submit` — it is a third of this
    # client and has its own locking discipline (see that module's docstring).

    async def submit(self, options: SubmitOptions) -> MutationOutcome:
        """Write, sending it now or queueing it until the socket is back.

        See :class:`~lunora.submit.SubmitOptions` for the per-write knobs and
        :func:`~lunora.submit.submit_write` for what each outcome means.
        """

        return await submit_write(self, options)

    def hydrate_offline_queue(self) -> list:
        """Restore writes persisted in a prior session; returns their shard keys."""

        return hydrate_queue(self)

    async def flush_offline_queue(self, shard_key: Optional[str] = None) -> FlushReport:
        """Replay one shard's queued writes, in order, over HTTP."""

        return await flush_queue(self, shard_key)

    # --- WS credential ------------------------------------------------------

    async def resolve_ws_token(self) -> Optional[str]:
        """Resolve the WS ``?token=`` credential fresh (mirrors ``WsTokenProvider``)."""

        token = self.ws_token
        if callable(token):
            result = token()
            if inspect.isawaitable(result):
                result = await result
            return result
        return token

    def ws_url_for(self, shard_key: Optional[str], token: Optional[str]) -> str:
        params = []
        # Empty is absent, matching `build_rpc_body` — see its docstring.
        if shard_key:
            params.append("shard=" + _percent(shard_key))
        if token is not None:
            params.append("token=" + _percent(token))
        if not params:
            return self.ws_url
        sep = "&" if "?" in self.ws_url else "?"
        return self.ws_url + sep + "&".join(params)

    # --- Subscriptions ------------------------------------------------------

    def subscribe(
        self,
        function_path: str,
        args: Any,
        on_data: Callback,
        on_error: Optional[ErrorCallback] = None,
        shard_key: Optional[str] = None,
    ) -> Unsubscribe:
        with self._lock:
            self._next_sub_id += 1
            sub_id = f"sub_{self._next_sub_id}"
            sub = _Subscription(sub_id, function_path, args, shard_key)
            sub.callbacks.append(on_data)
            if on_error is not None:
                sub.error_callbacks.append(on_error)
            self._subs[sub_id] = sub
            sender = self._send
            frame = build_subscribe_frame(sub_id, function_path, args)

        # Sent with the lock released: the sender writes to a socket, and holding
        # the lock across that would serialise every subscriber behind the wire.
        if sender is not None:
            sender(frame)

        def unsubscribe() -> None:
            with self._lock:
                self._subs.pop(sub_id, None)
                sender = self._send
            if sender is not None:
                sender(build_unsubscribe_frame(sub_id))

        return unsubscribe

    def stream(self, function_path: str, args: Any = None, shard_key: Optional[str] = None) -> AsyncIterator:
        """A live query as an async generator, for ``async for`` and the loops built on it.

        Each call opens its OWN subscription — at CALL time, not at first
        ``__anext__``, so a frame arriving before the loop starts is not lost —
        and tears it down when the generator is closed: breaking out of the loop,
        cancelling the task, or calling ``aclose()``. A consumer never holds an
        unsubscribe handle. Use :meth:`subscribe` directly when the value
        outlives one loop.

        A subscription error is raised into the loop rather than delivered as a
        value, which is what stops a caller from mistaking it for data.

        Frames must be dispatched on the running loop (which :meth:`connect`
        does): the buffer is an :class:`asyncio.Queue`, filled from
        :meth:`handle_frame` without a hop.
        """

        values: asyncio.Queue = asyncio.Queue()
        unsubscribe = self.subscribe(function_path, args, values.put_nowait, values.put_nowait, shard_key)

        async def iterate() -> AsyncIterator:
            try:
                while True:
                    value = await values.get()
                    if isinstance(value, SubscriptionError):
                        raise LunoraError(value.code if value.code is not None else "INTERNAL", value.message)
                    yield value
            finally:
                unsubscribe()

        return iterate()

    def subscribe_shape(
        self,
        name: str,
        args: Any,
        on_rows: Callable[[list], None],
        on_error: Optional[ErrorCallback] = None,
        shard_key: Optional[str] = None,
    ) -> Unsubscribe:
        with self._lock:
            self._next_shape_id += 1
            shape_id = f"shape_{self._next_shape_id}"
            shape = _ShapeSubscription(shape_id, name, args, shard_key)
            shape.callbacks.append(on_rows)
            if on_error is not None:
                shape.error_callbacks.append(on_error)
            self._shapes[shape_id] = shape
            sender = self._send
            frame = build_shape_subscribe_frame(shape_id, name, args)

        if sender is not None:
            sender(frame)

        def unsubscribe() -> None:
            with self._lock:
                self._shapes.pop(shape_id, None)
                sender = self._send
            if sender is not None:
                sender({"id": shape_id, "type": "shape_unsubscribe"})

        return unsubscribe

    def resend_subscriptions(self) -> None:
        """Re-subscribe everything after a reconnect, carrying each resume cursor.

        Without this the cursor/epoch tracked on every ``data`` frame would be
        write-only state and a reconnect would silently re-seed from scratch.

        The frames are BUILT under the lock, not merely collected: each one carries
        a cursor :meth:`handle_frame` writes, so snapshotting the subscriptions and
        reading their cursors afterwards resends a torn frame.
        """

        with self._lock:
            sender = self._send
            if sender is None:
                return
            frames = [
                build_subscribe_frame(sub.id, sub.function_path, sub.args, since_seq=sub.server_cursor, since_epoch=sub.server_epoch)
                for sub in self._subs.values()
            ]
            frames += [
                build_shape_subscribe_frame(shape.id, shape.name, shape.args, since_checkpoint=shape.server_cursor, since_epoch=shape.server_epoch)
                for shape in self._shapes.values()
            ]

        for frame in frames:
            sender(frame)

    # --- Inbound frame dispatch (fixture-tested) ---------------------------

    def handle_frame(self, frame: dict) -> dict:
        """Apply one server frame; invoke callbacks. Returns a descriptor for testing."""

        deferred: list[Callable[[], None]] = []
        with self._lock:
            descriptor = self._dispatch(frame, deferred)

        # User callbacks run with the lock released. Holding it would let a callback
        # that subscribes deadlock the read loop, and would run arbitrary
        # application code inside the client's critical section.
        for call in deferred:
            call()

        return descriptor

    def _dispatch(self, frame: dict, deferred: list) -> dict:
        """Apply one frame to the guarded state. Runs with the lock held.

        Anything that calls back into user code is appended to ``deferred`` for
        :meth:`handle_frame` to run once it has released the lock.
        """

        kind = frame.get("type")
        if kind == "ack":
            sub = self._subs.get(frame["id"])
            if sub is not None:
                sub.acked = True
            return {"kind": "ack", "id": frame.get("id")}

        if kind in ("data", "delta"):
            return self._handle_data(frame, deferred)

        if kind == "error":
            return self._handle_error(frame, deferred)

        if kind == "resume":
            return self._advance(frame, "resume", deferred)

        if kind == "settled":
            desc = self._advance(frame, "settled", deferred)
            if "lastMutationId" in frame:
                desc["lastMutationId"] = frame["lastMutationId"]
            return desc

        if kind == "pokeStart":
            # Evict oldest-first at the cap. ``dict`` preserves insertion order,
            # so the first key is the oldest buffer; one that old is no longer
            # going to see its ``pokeEnd``.
            while len(self._poke_buffers) >= MAX_PENDING_POKES:
                self._poke_buffers.pop(next(iter(self._poke_buffers)))
            self._poke_buffers[frame["pokeId"]] = {
                "baseCheckpoint": frame.get("baseCheckpoint"),
                "epoch": frame.get("epoch"),
                "parts": {},
                "resets": set(),
            }
            return {"kind": "pokeStart", "pokeId": frame["pokeId"]}

        if kind == "pokePart":
            buf = self._poke_buffers.get(frame["pokeId"])
            if buf is not None:
                buf["parts"].setdefault(frame["shapeId"], []).extend(frame.get("rowsPatch", []))
                # A shape gets at most one part per poke, but record the flag
                # sticky (never cleared) so a server that splits a seed across
                # parts still replaces the view rather than merging into it.
                if frame.get("reset") is True:
                    buf["resets"].add(frame["shapeId"])
            return {"kind": "pokePart", "pokeId": frame["pokeId"], "shapeId": frame.get("shapeId")}

        if kind == "pokeEnd":
            return self._handle_poke_end(frame, deferred)

        if kind == "complete":
            self._subs.pop(frame.get("id"), None)
            return {"kind": "complete", "id": frame.get("id")}

        return {"kind": "ignored", "type": kind}

    def _handle_data(self, frame: dict, deferred: list) -> dict:
        sub = self._subs.get(frame.get("id"))
        # Minimal delta handling: replace wholesale (the full protocol merges a
        # mutation-delta into the server base; a wholesale replace is a correct
        # fallback and keeps the SDK dependency-free).
        has_data = "data" in frame and frame["data"] is not None
        try:
            value = decode_wire(frame["data"]) if has_data else decode_wire(frame.get("delta"))
        except WireFormatError as error:
            # A malformed payload belongs on the subscription's error callback,
            # not on the socket read loop's stack. Letting it escape here ended
            # the loop — and with it every OTHER subscription on this client —
            # over one bad frame, where the reference and the Java port both
            # surface it and keep reading.
            reported = SubscriptionError(str(error), "INVALID_FRAME")
            if sub is not None:
                deferred.extend(partial(cb, reported) for cb in sub.error_callbacks)
            return {"kind": "error", "id": frame.get("id"), "error": reported}
        displayed = value
        if sub is not None:
            sub.server_base = value
            # Only an integer cursor advances the tracked one. A frame that omits
            # it, or sends an explicit null, must LEAVE it where it was — the
            # tracked cursor is what a write's commit cursor is compared against,
            # so clearing it strands every pending layer.
            if isinstance(frame.get("cursor"), int) and not isinstance(frame["cursor"], bool):
                sub.server_cursor = frame["cursor"]
            if "epoch" in frame:
                sub.server_epoch = frame["epoch"]
            # Drop the overlays this frame has caught up with, then RE-FOLD the
            # rest onto the new authoritative base rather than clobbering them:
            # a still-queued write's predicted value has to survive an unrelated
            # delta on the same query.
            drop_confirmed_layers(sub, sub.server_cursor)
            displayed = fold_optimistic(sub.server_base, sub.optimistic_layers)
            sub.last_value = displayed
            deferred.extend(partial(cb, displayed) for cb in sub.callbacks)
        # ``value`` is the authoritative server value and ``displayed`` is what a
        # subscriber saw; they differ only while an optimistic layer is pending.
        desc = {"kind": "data", "id": frame.get("id"), "value": value, "displayed": displayed}
        if "cursor" in frame:
            desc["cursor"] = frame["cursor"]
        if "epoch" in frame:
            desc["epoch"] = frame["epoch"]
        return desc

    def _handle_error(self, frame: dict, deferred: list) -> dict:
        env = frame.get("error") or {}
        code = env.get("code") if isinstance(env, dict) else None
        message = frame.get("message") or (env.get("message") if isinstance(env, dict) else None) or "subscription error"
        error = SubscriptionError(message, code)
        sub_id = frame.get("id")
        sub = self._subs.get(sub_id) if sub_id is not None else None
        if sub is not None:
            deferred.extend(partial(cb, error) for cb in sub.error_callbacks)
        shape = self._shapes.get(sub_id) if sub_id is not None else None
        if shape is not None:
            deferred.extend(partial(cb, error) for cb in shape.error_callbacks)
        return {"kind": "error", "id": sub_id, "code": code, "message": message}

    def _advance(self, frame: dict, kind: str, deferred: list) -> dict:
        sub = self._subs.get(frame.get("id"))
        if sub is not None:
            sub.acked = True
            if isinstance(frame.get("cursor"), int) and not isinstance(frame["cursor"], bool):
                sub.server_cursor = frame["cursor"]
            if "epoch" in frame:
                sub.server_epoch = frame["epoch"]
            # A resume/settled frame advances the cursor without a value change —
            # but a write whose result was byte-identical for this query still
            # committed at or under this cursor, so its overlay is confirmed.
            # Sweep here too, not just on data frames, or a no-visible-change
            # write leaves its prediction on screen until some unrelated write
            # happens to produce a data frame — indefinitely on a quiet query.
            if drop_confirmed_layers(sub, sub.server_cursor):
                displayed = fold_optimistic(sub.server_base, sub.optimistic_layers)
                sub.last_value = displayed
                deferred.extend(partial(cb, displayed) for cb in sub.callbacks)
        desc = {"kind": kind, "id": frame.get("id")}
        if "cursor" in frame:
            desc["cursor"] = frame["cursor"]
        return desc

    def _handle_poke_end(self, frame: dict, deferred: list) -> dict:
        buf = self._poke_buffers.pop(frame["pokeId"], None)
        touched: list[str] = []
        if buf is not None:
            for shape_id, ops in buf["parts"].items():
                shape = self._shapes.get(shape_id)
                if shape is None:
                    continue
                # A reset part carries the shape's COMPLETE membership, so it
                # replaces the view instead of patching it. Merging it would keep
                # every row that left the shape while this client was away: a
                # (re)seed is inserts-only, so nothing already held can ever be
                # removed by one, and the stale row renders for the life of the
                # client. Not inferable from anything else on the wire — a
                # retention re-seed keeps the epoch, and most live pokes carry no
                # baseCheckpoint either.
                if shape_id in buf["resets"]:
                    shape.rows.clear()
                for op in ops:
                    if op["op"] == "delete":
                        shape.rows.pop(op["key"], None)
                    elif op.get("value") is not None:
                        shape.rows[op["key"]] = decode_wire(op["value"])
                if "checkpoint" in frame:
                    shape.server_cursor = frame["checkpoint"]
                if "epoch" in frame:
                    shape.server_epoch = frame["epoch"]
                rows = list(shape.rows.values())
                deferred.extend(partial(cb, rows) for cb in shape.callbacks)
                touched.append(shape_id)
        return {"kind": "pokeEnd", "pokeId": frame["pokeId"], "shapes": touched}

    # --- Live WebSocket loop (optional; needs the ``websockets`` package) ---

    async def connect_and_run(self, shard_key: Optional[str] = None, context: Optional[dict] = None) -> None:
        """Open the live WS, announce ``connect``, resend subscriptions, and dispatch frames.

        Runs until the socket closes. Requires the ``websockets`` package.
        """

        try:
            import websockets  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("connect_and_run requires the 'websockets' package (pip install websockets)") from exc

        token = await self.resolve_ws_token()
        async with websockets.connect(self.ws_url_for(shard_key, token)) as socket:  # pragma: no cover - live I/O
            queue: list[dict] = []

            def send(frame: dict) -> None:
                queue.append(frame)

            self.attach_socket(send)
            send(build_connect_frame(self.client_id, context))
            self.resend_subscriptions()

            async def flush() -> None:
                while queue:
                    await socket.send(json.dumps(queue.pop(0)))

            try:
                await flush()
                # The socket is back, so the backlog replays now — among itself in
                # submission order. It is NOT ordered against concurrent writes:
                # `attach_socket` above has already cleared the queue-it decision,
                # so a `submit` racing this flush goes straight over HTTP and can
                # land ahead of the backlog still replaying. The reference client
                # has the same window; closing it needs a flushing flag in the
                # queue-it decision, which is a protocol change, not a port fix.
                await self.flush_offline_queue(shard_key)
                async for raw in socket:
                    if raw == "lunora-pong":
                        continue
                    try:
                        frame = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    # `_handle_data` already routes a codec rejection to the
                    # subscription that owns it. This is the backstop for
                    # everything else — a frame shape no branch expects, or a
                    # user callback that raises — because an exception out of
                    # here terminates the read loop and silently stops every
                    # subscription on the client.
                    with contextlib.suppress(Exception):
                        self.handle_frame(frame)
                    await flush()
            finally:
                # Writes submitted after this point queue instead of failing.
                self.detach_socket()


def _percent(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse to follow a redirect, so the bearer token is never replayed.

    CPython's default handler copies EVERY request header except ``content-*``
    onto the redirected request — ``authorization: Bearer ...`` included — and
    sends it to whatever host the ``Location`` names. The reference client's
    ``fetch`` drops ``Authorization`` on a cross-origin redirect per the Fetch
    standard, so a WAF challenge page, a misconfigured proxy or an open
    redirect on the real endpoint would harvest the caller's token here and
    nowhere else. An RPC POST has no legitimate 3xx: 301/302/303 also turn the
    POST into a GET, which would drop the call's own body. Refuse, and let the
    status surface as the non-2xx it is.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


#: Module-level so the handler chain is built once; it holds no per-call state.
_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def _urllib_post(url: str, headers: dict, body: bytes, timeout: float = DEFAULT_HTTP_TIMEOUT) -> tuple[int, dict]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # error envelopes still carry a JSON body
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except OSError:
            # A refused redirect or a proxy's challenge page often closes the
            # socket with no body — and resets a POST whose body it never read.
            # The STATUS is what the caller needs; a failed body read must not
            # replace it with a socket error.
            raw = ""
        finally:
            exc.close()

        try:
            return exc.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            # An HTML error page from a proxy, or a refused redirect's empty
            # body. Reported as the status with NO envelope, never a synthesized
            # one: `parse_rpc_response` raises an envelope-less non-2xx as
            # `transient=True` precisely because nothing reached the shard, and
            # a manufactured `INTERNAL` verdict is in neither of `submit`'s
            # replayable code sets — it settles a queued durable write
            # terminally against a body no Lunora function wrote.
            return exc.code, {}
    # A timeout raises `socket.timeout` (`TimeoutError` from 3.10+), which is not
    # an `HTTPError` and so is left to propagate — it is not a server response
    # and must not be dressed up as one.
