"""A minimal, protocol-conformant Lunora client.

Implements the transport documented in ``protocol/README.md``:

- ``query`` / ``mutation`` round-trips over ``POST /_lunora/rpc``.
- Live ``subscribe`` over the WebSocket ``data``/``delta``/``ack``/``error``/
  ``resume``/``settled`` frames.
- ``subscribe_shape`` over the poke (``pokeStart``/``pokePart``/``pokeEnd``) path.
- An async WS token provider mirroring the TS ``WsTokenProvider``.
- ``submit`` — the offline-capable write path: optimistic layers over the live
  subscriptions (``lunora.optimistic``) plus the durable replay queue
  (``lunora.offline``).

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
from collections.abc import Awaitable
from functools import partial
from typing import Any, Callable, Optional, Union

from .offline import (
    OFFLINE_IDENTITY_CHANGED,
    OfflineError,
    OfflineQueue,
    QueuedMutation,
    identity_allows_replay,
    random_id,
)
from .optimistic import (
    OptimisticLocalStore,
    apply_optimistic_layer,
    confirm_all,
    drop_confirmed_layers,
    fold_optimistic,
    rollback_all,
)
from .wire import decode_wire, encode_wire, stable_wire_key

RPC_PATH = "/_lunora/rpc"
WS_PATH = "/_lunora/ws"

# `urllib.request.urlopen`'s own default is no timeout at all — the socket
# blocks forever against a server that accepts and never replies. 30s is
# generous enough for a slow `action` while still being finite; override via
# `LunoraClient(..., timeout=...)` for a longer-running one.
DEFAULT_HTTP_TIMEOUT = 30.0

#: Error codes a replay must NOT treat as the server's final word on a write.
#: The shard was momentarily unreachable, so the same call under the same
#: idempotency key is expected to succeed later; dropping it would lose a durable
#: write to a transient condition. Everything else coded is a verdict — replaying
#: it would only re-trigger the same failure (a poison-message loop).
TRANSIENT_ERROR_CODES = frozenset({"SHARD_ERROR", "SHARD_UNAVAILABLE"})

# A WS token provider: a value, a callable returning a value, or an async callable.
WsToken = Union[str, Callable[[], Union[str, Awaitable[Optional[str]], None]], None]

Callback = Callable[[Any], None]
ErrorCallback = Callable[["SubscriptionError"], None]
Unsubscribe = Callable[[], None]


class LunoraError(Exception):
    """A coded error raised from an RPC ``{ "error": { code, message, data } }`` envelope."""

    def __init__(self, code: str, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class SubscriptionError:
    """A subscription-scoped error frame the server pushed."""

    def __init__(self, message: str, code: Optional[str] = None) -> None:
        self.message = message
        self.code = code

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"SubscriptionError(code={self.code!r}, message={self.message!r})"


# --- Pure framing helpers (no I/O; fixture-tested) --------------------------


def build_rpc_body(function_path: str, args: Any, shard_key: Optional[str] = None) -> dict:
    """Build the ``POST /_lunora/rpc`` JSON body. ``shard_key`` is omitted when ``None``."""

    body: dict[str, Any] = {"args": encode_wire(args if args is not None else {}), "functionPath": function_path}
    if shard_key is not None:
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
        raise LunoraError(err.get("code", "INTERNAL"), err.get("message", "request failed"), data)

    if not 200 <= status <= 299:
        raise LunoraError("INTERNAL", f"HTTP {status} without an error envelope")

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


def _is_transient(error: BaseException) -> bool:
    """Whether a failed replay may be retried rather than dropped.

    A raw exception from the injected poster is the network, not the server: no
    verdict was reached, so the write is still good. A coded error IS a verdict —
    except for the shard-level codes, which say the shard was momentarily
    unreachable and the identical call is expected to succeed later.
    """

    if isinstance(error, LunoraError):
        return error.code in TRANSIENT_ERROR_CODES

    return True


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


class MutationOutcome:
    """What :meth:`LunoraClient.submit` did with a write.

    ``status`` is ``"committed"`` when the write went out and the server answered,
    or ``"queued"`` when the socket was down and it was enqueued for replay.

    This is the deliberate divergence from ``@lunora/client``, whose ``mutation()``
    returns a Promise that stays PENDING until a queued write finally replays.
    A pending promise is a fine thing to hold in a browser event loop and a bad
    thing to hold in a Go goroutine, a Ruby thread or a JVM thread pool, so the
    ports return the outcome immediately and report the eventual verdict through
    ``on_settled`` (per call) or ``LunoraClient.on_mutation_settled`` (per client)
    instead. A caller that must not report success early checks ``status``.
    """

    __slots__ = ("commit_cursor", "mutation_id", "status", "value")

    def __init__(self, status: str, mutation_id: str, value: Any = None, commit_cursor: Optional[int] = None) -> None:
        self.status = status
        self.mutation_id = mutation_id
        self.value = value
        self.commit_cursor = commit_cursor

    @property
    def queued(self) -> bool:
        return self.status == "queued"

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"MutationOutcome(status={self.status!r}, mutation_id={self.mutation_id!r})"


class MutationSettled:
    """The terminal verdict on a queued write, delivered once it replays.

    ``had_awaiter`` is ``False`` for a write restored from durable storage after a
    restart: the caller that submitted it is gone, so this event is the ONLY
    report that write will ever produce.
    """

    __slots__ = ("error", "had_awaiter", "mutation_id", "status", "value")

    def __init__(self, mutation_id: str, status: str, value: Any = None, error: Optional[Exception] = None, had_awaiter: bool = False) -> None:
        self.mutation_id = mutation_id
        self.status = status
        self.value = value
        self.error = error
        self.had_awaiter = had_awaiter

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"MutationSettled(mutation_id={self.mutation_id!r}, status={self.status!r})"


class FlushReport:
    """What one :meth:`LunoraClient.flush_offline_queue` pass achieved."""

    __slots__ = ("committed", "conflicted", "rejected", "requeued")

    def __init__(self) -> None:
        #: Ids the server accepted.
        self.committed: list[str] = []
        #: Ids dropped on a server verdict, an identity change, or a stale precondition.
        self.rejected: list[str] = []
        #: Ids left queued for the next reconnect after a transient failure.
        self.requeued: list[str] = []
        #: Ids dropped because their precondition no longer held.
        self.conflicted: list[str] = []


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
        client_id: str = "python-client",
        http_post: Optional[Callable[[str, dict, bytes], tuple[int, dict]]] = None,
        timeout: float = DEFAULT_HTTP_TIMEOUT,
        offline_queue: Optional[OfflineQueue] = None,
        identity: Optional[str] = None,
    ) -> None:
        self.url = url
        self.ws_url = ws_url if ws_url is not None else _join(_derive_ws_url(url), WS_PATH)
        self.auth_token = auth_token
        self.ws_token = ws_token
        self.client_id = client_id
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

        with self._lock:
            self._closed = True
            self._send = None
            queue = self.offline_queue

        self._report_discarded(queue.clear())

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

    # --- Offline-capable writes ---------------------------------------------

    async def submit(
        self,
        function_path: str,
        args: Any = None,
        shard_key: Optional[str] = None,
        mutation_id: Optional[str] = None,
        optimistic: Optional[Callable[[Any], Any]] = None,
        optimistic_update: Optional[Callable[[OptimisticLocalStore, Any], None]] = None,
        precondition: Optional[Callable[[], bool]] = None,
        on_settled: Optional[Callable[[MutationSettled], None]] = None,
    ) -> MutationOutcome:
        """Write, sending it now or queueing it until the socket is back.

        ``optimistic`` is the single-query shortcut: the transform is layered onto
        the subscription registered under the SAME ``(function_path, args,
        shard_key)`` as this write, mirroring ``@lunora/client``'s per-call
        ``optimistic``. ``optimistic_update`` is the general form — it receives an
        :class:`~lunora.optimistic.OptimisticLocalStore` and may patch any number
        of subscribed queries. Both settle together, against the same commit
        cursor.

        ``precondition`` is re-evaluated just before a QUEUED write replays; a
        ``False`` verdict drops it (the row it edited was deleted meanwhile)
        rather than replaying a write that can only fail.

        Returns as soon as the write is either committed or durably queued — see
        :class:`MutationOutcome` for why this does not block like the browser
        client's promise. ``on_settled`` reports the eventual verdict on a queued
        write.
        """

        if self._closed:
            raise OfflineError("CLIENT_CLOSED", "client is closed")

        write_id = mutation_id if mutation_id is not None else random_id()
        deferred: list = []

        with self._lock:
            confirms, rollbacks = self._apply_optimistic(function_path, args, shard_key, optimistic, optimistic_update, deferred)
            queue_it = self._send is None and (self._was_ever_connected or self.offline_queue.queue_before_first_connect)
            identity = self.identity

        self._drain(deferred)

        if queue_it:
            self._enqueue_write(function_path, args, shard_key, write_id, identity, precondition, confirms, rollbacks, on_settled)

            return MutationOutcome("queued", write_id)

        try:
            value, commit_cursor = await self._rpc_full(function_path, args, shard_key, write_id)
        except Exception:
            settle: list = []
            with self._lock:
                rollback_all(rollbacks, settle)
            self._drain(settle)
            raise

        settle = []
        with self._lock:
            # Confirmed against the write's COMMITTED cursor, so the overlay drops
            # when (or once) a frame at that cursor lands — never on this call's
            # resolve timing, which races the socket broadcast.
            confirm_all(confirms, commit_cursor, settle)
        self._drain(settle)

        return MutationOutcome("committed", write_id, value, commit_cursor)

    def hydrate_offline_queue(self) -> list:
        """Restore writes persisted in a prior session; returns their shard keys.

        Open a socket for each returned shard key (and then flush it) to replay
        them. A restored write has no live caller, so its verdict arrives only
        through :meth:`on_mutation_settled`.
        """

        with self._lock:
            queue = self.offline_queue

        restored, evicted = queue.hydrate()

        for item in queue.items():
            if item.reject is None and item.resolve is None:
                self._attach_hydrated_settlers(item)

        # Restored records that the cap dropped never get settlers of their own,
        # so they are reported directly rather than through one.
        self._report_discarded(evicted)

        return restored

    async def flush_offline_queue(self, shard_key: Optional[str] = None) -> FlushReport:
        """Replay one shard's queued writes, in order, over HTTP.

        Call it when that shard's socket comes back. Each write replays under its
        own idempotency key, so one the server already committed is de-duplicated
        rather than applied twice.

        Classification per write: success confirms its optimistic overlay against
        the ECHOED commit cursor; a coded verdict is terminal (replaying it would
        only re-trigger the same failure); a transient failure — a raw transport
        error, or one of :data:`TRANSIENT_ERROR_CODES` — stops the flush and
        re-queues that write and every unreplayed one, in order, for the next
        attempt.
        """

        report = FlushReport()

        with self._lock:
            queue = self.offline_queue
            current_identity = self.identity

        conflicted = queue.drain_conflict()

        for discarded in conflicted:
            queue.unpersist(discarded.entry.id)
            report.conflicted.append(discarded.entry.id)
            report.rejected.append(discarded.entry.id)

        self._report_discarded(conflicted)

        key = shard_key or ""
        drained = queue.drain(lambda item: (item.shard_key or "") == key)

        if not drained:
            return report

        # Gated against ONE identity snapshot: a flush is a single authenticated
        # burst, so every write in it necessarily runs under one identity.
        sendable: list = []

        for item in drained:
            if identity_allows_replay(item.identity, current_identity):
                sendable.append(item)
                continue

            queue.unpersist(item.id)
            error = OfflineError(OFFLINE_IDENTITY_CHANGED, "offline mutation skipped: auth identity changed before replay")
            self._settle_rejected(item, error)
            report.rejected.append(item.id)

        for index, item in enumerate(sendable):
            try:
                value, commit_cursor = await self._rpc_full(
                    item.function_path,
                    item.args,
                    item.shard_key,
                    item.id,
                    client_id=item.client_id,
                )
            except Exception as error:
                if _is_transient(error):
                    # Nothing after this write may go out ahead of it: replaying
                    # out of order is how a durable queue corrupts the data it was
                    # protecting.
                    queue.requeue(sendable[index:])
                    report.requeued.extend(entry.id for entry in sendable[index:])

                    return report

                queue.unpersist(item.id)
                self._settle_rejected(item, error)
                report.rejected.append(item.id)

                continue

            queue.unpersist(item.id)
            self._settle_committed(item, value, commit_cursor)
            report.committed.append(item.id)

        return report

    # --- Offline/optimistic internals ---------------------------------------

    def _find_subscriptions(self, function_path: str, args: Any, shard_key: Optional[str]) -> list:
        """Live subscriptions registered under exactly this ``(path, args, shard)``.

        A linear scan, unlike ``@lunora/client``'s keyed registry, and
        deliberately: this client does not de-duplicate subscriptions, so several
        can share one triple and all of them must receive the overlay. The scan
        is over a handful of entries on the write path, not the frame path.

        A ``None`` shard key and an empty one are the same shard, so a write fired
        without one matches a subscription registered without one either way.
        """

        args_key = stable_wire_key(args if args is not None else {})
        key = shard_key or ""

        return [sub for sub in self._subs.values() if sub.function_path == function_path and sub.args_key == args_key and (sub.shard_key or "") == key]

    def _apply_optimistic(
        self,
        function_path: str,
        args: Any,
        shard_key: Optional[str],
        optimistic: Optional[Callable[[Any], Any]],
        optimistic_update: Optional[Callable[[OptimisticLocalStore, Any], None]],
        deferred: list,
    ) -> tuple:
        """Register both optimistic APIs' layers. Runs with the lock held."""

        confirms: list = []
        rollbacks: list = []

        if optimistic is not None:
            for sub in self._find_subscriptions(function_path, args, shard_key):
                handle = apply_optimistic_layer(sub, optimistic, deferred)
                if handle is not None:
                    confirms.append(handle.confirm)
                    rollbacks.append(handle.rollback)

        if optimistic_update is not None:
            store = OptimisticLocalStore(
                lambda path, query_args: self._find_subscriptions(path, query_args, shard_key),
                lambda path: [sub for sub in self._subs.values() if sub.function_path == path and (sub.shard_key or "") == (shard_key or "")],
                deferred,
            )

            try:
                optimistic_update(store, args)
            except Exception:
                # Unwind only this callback's own writes, so a throwing update
                # leaves the cache exactly as it found it.
                rollback_all(store.rollbacks, deferred)
            else:
                confirms.extend(store.confirms)
                rollbacks.extend(store.rollbacks)

        return confirms, rollbacks

    def _enqueue_write(
        self,
        function_path: str,
        args: Any,
        shard_key: Optional[str],
        write_id: str,
        identity: Optional[str],
        precondition: Optional[Callable[[], bool]],
        confirms: list,
        rollbacks: list,
        on_settled: Optional[Callable[[MutationSettled], None]],
    ) -> None:
        def on_commit(commit_cursor: Optional[int]) -> None:
            deferred: list = []
            with self._lock:
                confirm_all(confirms, commit_cursor, deferred)
            self._drain(deferred)

        def resolve(value: Any) -> None:
            self._emit_settled(MutationSettled(write_id, "committed", value=value, had_awaiter=True), on_settled)

        def reject(error: Exception) -> None:
            deferred: list = []
            with self._lock:
                rollback_all(rollbacks, deferred)
            self._drain(deferred)
            self._emit_settled(MutationSettled(write_id, "rejected", error=error, had_awaiter=True), on_settled)

        entry = QueuedMutation(
            args=args,
            client_id=self.client_id,
            function_path=function_path,
            # Bound at enqueue time, so the write can only ever replay as whoever
            # made it.
            identity=identity,
            live_awaiter=True,
            mutation_id=write_id,
            on_commit=on_commit,
            precondition=precondition,
            reject=reject,
            resolve=resolve,
            shard_key=shard_key,
        )

        with self._lock:
            queue = self.offline_queue
            # Safe under the lock now that `enqueue` invokes no callback: it
            # returns what the cap evicted instead, and those settle below.
            evicted = queue.enqueue(entry)

        self._report_discarded(evicted)

    def _attach_hydrated_settlers(self, item: QueuedMutation) -> None:
        """Give a restored write the observer-only settlers it lost in the restart."""

        item.live_awaiter = False
        item.resolve = lambda value, mutation_id=item.id: self._emit_settled(MutationSettled(mutation_id, "committed", value=value))
        item.reject = lambda error, mutation_id=item.id: self._emit_settled(MutationSettled(mutation_id, "rejected", error=error))

    def _report_discarded(self, discarded: list) -> None:
        """Settle every write the queue let go of without sending it.

        Runs with the lock RELEASED: a rejection rolls optimistic layers back,
        which re-acquires it. Every discard path funnels through here, so an
        eviction can never drop a durable write in silence — which matters most
        for a hydrated record, whose original caller did not survive the restart.
        """

        for item in discarded:
            self._settle_rejected(item.entry, item.error())

    def _settle_committed(self, item: QueuedMutation, value: Any, commit_cursor: Optional[int]) -> None:
        # The overlay is confirmed BEFORE the caller is told, so the gapless drop
        # is already in place when the confirming frame lands.
        if item.on_commit is not None:
            item.on_commit(commit_cursor)
        if item.resolve is not None:
            item.resolve(value)

    def _settle_rejected(self, item: QueuedMutation, error: Exception) -> None:
        if item.reject is not None:
            item.reject(error)

    def _emit_settled(self, event: MutationSettled, on_settled: Optional[Callable[[MutationSettled], None]] = None) -> None:
        with self._lock:
            listeners = list(self._settled_listeners)

        if on_settled is not None:
            listeners.insert(0, on_settled)

        for listener in listeners:
            # One observer raising must not stop the rest from being told: a
            # write's terminal verdict is the only report a restored write ever
            # produces.
            with contextlib.suppress(Exception):
                listener(event)

    @staticmethod
    def _drain(deferred: list) -> None:
        """Run notifications queued while the lock was held."""

        for call in deferred:
            call()

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
        if shard_key is not None:
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
            return self._advance(frame, "resume")

        if kind == "settled":
            desc = self._advance(frame, "settled")
            if "lastMutationId" in frame:
                desc["lastMutationId"] = frame["lastMutationId"]
            return desc

        if kind == "pokeStart":
            self._poke_buffers[frame["pokeId"]] = {
                "baseCheckpoint": frame.get("baseCheckpoint"),
                "epoch": frame.get("epoch"),
                "parts": {},
            }
            return {"kind": "pokeStart", "pokeId": frame["pokeId"]}

        if kind == "pokePart":
            buf = self._poke_buffers.get(frame["pokeId"])
            if buf is not None:
                buf["parts"].setdefault(frame["shapeId"], []).extend(frame.get("rowsPatch", []))
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
        value = decode_wire(frame["data"]) if has_data else decode_wire(frame.get("delta"))
        displayed = value
        if sub is not None:
            sub.server_base = value
            if "cursor" in frame:
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

    def _advance(self, frame: dict, kind: str) -> dict:
        sub = self._subs.get(frame.get("id"))
        if sub is not None:
            sub.acked = True
            if "cursor" in frame:
                sub.server_cursor = frame["cursor"]
            if "epoch" in frame:
                sub.server_epoch = frame["epoch"]
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
                # The socket is back, so the writes made while it was down go out
                # now, in order, before anything new is submitted.
                await self.flush_offline_queue(shard_key)
                async for raw in socket:
                    if raw == "lunora-pong":
                        continue
                    try:
                        frame = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    self.handle_frame(frame)
                    await flush()
            finally:
                # Writes submitted after this point queue instead of failing.
                self.detach_socket()


def _percent(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


def _urllib_post(url: str, headers: dict, body: bytes, timeout: float = DEFAULT_HTTP_TIMEOUT) -> tuple[int, dict]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # error envelopes still carry a JSON body
        raw = exc.read().decode("utf-8")
        return exc.code, json.loads(raw) if raw else {"error": {"code": "INTERNAL", "message": str(exc)}}
    # A timeout raises `socket.timeout` (`TimeoutError` from 3.10+), which is not
    # an `HTTPError` and so is left to propagate — it is not a server response
    # and must not be dressed up as one.
