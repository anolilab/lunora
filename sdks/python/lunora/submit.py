"""The offline-capable write path: ``submit``, the flush, and how a write settles.

Split out of ``client.py`` — which was over a thousand lines — and shaped like
the Go and Rust ports' ``submit.go`` / ``submit.rs``: the client owns the socket,
the subscription registry and the frame dispatch; this module owns everything
that happens to a WRITE.

Two rules run through all of it, and both exist because the client's
``threading.Lock`` is NOT reentrant:

1. **The queue is only ever mutated with the client's lock held.** ``drain``
   partitions the item list and then reassigns it, so a concurrent ``enqueue``
   between the two silently loses a write ``submit`` already reported as
   ``queued``.
2. **No consumer code runs inside that critical section.** A ``precondition``
   predicate, an ``optimistic_update`` callback and every settle notification run
   with the lock released, so a callback that touches the client it was handed
   cannot deadlock the thread that called it.

Which means the shape here is always: take the lock, mutate the queue, release
it, then run callbacks and I/O — never one round trip with the lock held.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .errors import LunoraError
from .offline import (
    CLIENT_CLOSED,
    OFFLINE_IDENTITY_CHANGED,
    OFFLINE_WRITE_UNENCODABLE,
    OfflineError,
    QueuedMutation,
    identity_allows_replay,
    random_id,
)
from .optimistic import (
    OptimisticLocalStore,
    apply_optimistic_layer,
    confirm_all,
    rollback_all,
)
from .wire import encode_wire, stable_wire_key

#: Error codes a replay must NOT treat as the server's final word on a write.
#: The shard was momentarily unreachable, so the same call under the same
#: idempotency key is expected to succeed later; dropping it would lose a durable
#: write to a transient condition. Everything else coded is a verdict — replaying
#: it would only re-trigger the same failure (a poison-message loop).
TRANSIENT_ERROR_CODES = frozenset({"SHARD_ERROR", "SHARD_UNAVAILABLE"})

Transform = Callable[[Any], Any]


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
    report that write will ever produce. It is read from the entry's own
    ``live_awaiter`` field at the settle site rather than restated by each caller,
    so the two cannot desync.
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
        #: Ids dropped on a server verdict, an identity change, an unencodable
        #: payload, or a stale precondition.
        self.rejected: list[str] = []
        #: Ids left queued for the next reconnect after a transient failure.
        self.requeued: list[str] = []
        #: Ids dropped because their precondition no longer held.
        self.conflicted: list[str] = []


@dataclass
class SubmitOptions:
    """One write's parameters.

    An object rather than a parameter list because the same values are threaded
    through the optimistic install, the enqueue and the settle: adding an option
    was a three-signature edit here where the ports that pass an options struct
    made it a one-field one.
    """

    function_path: str
    args: Any = None
    #: ``None`` routes to the default shard. An empty string means the same shard.
    shard_key: Optional[str] = None
    #: The idempotency key; minted when ``None``.
    mutation_id: Optional[str] = None
    #: The single-query shortcut: the transform is layered onto every
    #: subscription registered under the SAME ``(function_path, args, shard_key)``
    #: as this write, mirroring ``@lunora/client``'s per-call ``optimistic``.
    #:
    #: It must be PURE. A layer re-runs on every server frame, and that fold
    #: happens inside the client's critical section, so a transform that calls
    #: back into the client deadlocks the socket read loop.
    optimistic: Optional[Transform] = None
    #: The general form: it receives an
    #: :class:`~lunora.optimistic.OptimisticLocalStore` and may patch any number
    #: of subscribed queries. Runs with the client's lock RELEASED, so it may
    #: safely read the client back. Settles together with ``optimistic``, against
    #: the same commit cursor.
    optimistic_update: Optional[Callable[[OptimisticLocalStore, Any], None]] = None
    #: Re-evaluated just before a QUEUED write replays; ``False`` drops it rather
    #: than replaying a write that can only fail.
    precondition: Optional[Callable[[], bool]] = None
    #: Reports the eventual verdict on a queued write.
    on_settled: Optional[Callable[[MutationSettled], None]] = None


def is_transient(error: BaseException) -> bool:
    """Whether a failed replay may be retried rather than dropped.

    A raw exception from the injected poster is the network, not the server: no
    verdict was reached, so the write is still good. A coded error IS a verdict —
    except for the shard-level codes, which say the shard was momentarily
    unreachable and the identical call is expected to succeed later.

    A write whose args cannot be encoded at all never reaches this function: it
    is settled terminally before the replay loop, because a codec failure carries
    no code and would otherwise be re-queued forever.
    """

    if isinstance(error, LunoraError):
        return error.code in TRANSIENT_ERROR_CODES

    return True


async def submit_write(client: Any, options: SubmitOptions) -> MutationOutcome:
    """Write, sending it now or queueing it until the socket is back.

    ``precondition`` is re-evaluated just before a QUEUED write replays; a
    ``False`` verdict drops it (the row it edited was deleted meanwhile) rather
    than replaying a write that can only fail.

    Returns as soon as the write is either committed or durably queued — see
    :class:`MutationOutcome` for why this does not block like the browser
    client's promise. ``on_settled`` reports the eventual verdict on a queued
    write.
    """

    write_id = options.mutation_id if options.mutation_id is not None else random_id()
    # The consumer's callback runs FIRST and unlocked: what comes back is data.
    overrides = _record_optimistic(client, options)
    deferred: list = []
    entry: Optional[QueuedMutation] = None
    evicted: list = []

    # ONE critical section for the offline decision and the enqueue. Splitting
    # them lets the socket attach and a whole flush run in between, leaving the
    # write in a queue nothing will drain until the next disconnect — after
    # `submit` has already answered "queued".
    with client._lock:
        # Checked HERE rather than on the way in, so a close cannot land between
        # the check and the enqueue and strand the write in a queue that was just
        # emptied: nothing flushes a closed client, so the caller would be told
        # "queued", never settled, and its overlay never rolled back.
        if client._closed:
            raise OfflineError(CLIENT_CLOSED, "client is closed")

        confirms, rollbacks = _install_layers(client, options, overrides, deferred)
        queue_it = client._send is None and (client._was_ever_connected or client.offline_queue.queue_before_first_connect)

        if queue_it:
            entry = _build_entry(client, options, write_id, confirms, rollbacks)
            # Safe under the lock because `enqueue` invokes no callback: it
            # returns what the cap evicted instead, and those settle below.
            evicted = client.offline_queue.enqueue(entry)

    run_deferred(deferred)

    if entry is not None:
        report_discarded(client, evicted)

        return MutationOutcome("queued", write_id)

    try:
        value, commit_cursor = await client._rpc_full(options.function_path, options.args, options.shard_key, write_id)
    except Exception:
        settle: list = []
        with client._lock:
            rollback_all(rollbacks, settle)
        run_deferred(settle)
        raise

    settle = []
    with client._lock:
        # Confirmed against the write's COMMITTED cursor, so the overlay drops
        # when (or once) a frame at that cursor lands — never on this call's
        # resolve timing, which races the socket broadcast.
        confirm_all(confirms, commit_cursor, settle)
    run_deferred(settle)

    return MutationOutcome("committed", write_id, value, commit_cursor)


def hydrate_queue(client: Any) -> list:
    """Restore writes persisted in a prior session; returns their shard keys.

    Open a socket for each returned shard key (and then flush it) to replay them.
    A restored write has no live caller, so its verdict — including an eviction
    right here, if the store held more than the cap — arrives only through
    :meth:`LunoraClient.on_mutation_settled`.
    """

    with client._lock:
        restored, evicted = client.offline_queue.hydrate()

    report_discarded(client, evicted)

    return restored


async def flush_queue(client: Any, shard_key: Optional[str] = None) -> FlushReport:
    """Replay one shard's queued writes, in order, over HTTP.

    Call it when that shard's socket comes back. Each write replays under its own
    idempotency key, so one the server already committed is de-duplicated rather
    than applied twice.

    Classification per write: success confirms its optimistic overlay against the
    ECHOED commit cursor; a coded verdict is terminal (replaying it would only
    re-trigger the same failure); a transient failure — a raw transport error, or
    one of :data:`TRANSIENT_ERROR_CODES` — stops the flush and re-queues that
    write and every unreplayed one, in order, for the next attempt.
    """

    report = FlushReport()

    with client._lock:
        queue = client.offline_queue
        current_identity = client.identity
        pending = queue.items()

    # The consumer's predicate, evaluated with the lock RELEASED and over a
    # snapshot; only the resulting id set goes back under it.
    stale = {item.id for item in pending if item.precondition is not None and not item.precondition()}

    with client._lock:
        conflicted = queue.drain_conflict(stale)
        for discarded in conflicted:
            queue.unpersist(discarded.entry.id)

    for discarded in conflicted:
        report.conflicted.append(discarded.entry.id)
        report.rejected.append(discarded.entry.id)

    report_discarded(client, conflicted)

    # A null shard key and an empty one are the SAME shard, so a write submitted
    # with `shard_key=""` drains on the default shard's flush instead of waiting
    # for a socket that is never opened.
    key = shard_key or ""

    with client._lock:
        drained = queue.drain(lambda item: (item.shard_key or "") == key)

    if not drained:
        return report

    # Gated against ONE identity snapshot: a flush is a single authenticated
    # burst, so every write in it necessarily runs under one identity.
    sendable: list = []
    terminal: list = []

    for item in drained:
        if not identity_allows_replay(item.identity, current_identity):
            terminal.append((item, OfflineError(OFFLINE_IDENTITY_CHANGED, "offline mutation skipped: auth identity changed before replay")))
            continue

        # A write whose args cannot be wire-encoded can never succeed. Left to the
        # replay loop it would throw mid-flush, be classified transient (a codec
        # error carries no code), and re-queue at the FRONT forever: never
        # settling its caller, never rolling its overlay back, and blocking every
        # write behind it. Encoding is cheap; the flush is the slow path anyway.
        try:
            encode_wire(item.args if item.args is not None else {})
        except Exception as error:
            terminal.append((item, OfflineError(OFFLINE_WRITE_UNENCODABLE, f"offline mutation cannot be wire-encoded: {error}")))
            continue

        sendable.append(item)

    with client._lock:
        for item, _error in terminal:
            queue.unpersist(item.id)

    for item, error in terminal:
        settle_rejected(client, item, error)
        report.rejected.append(item.id)

    for index, item in enumerate(sendable):
        try:
            value, commit_cursor = await client._rpc_full(
                item.function_path,
                item.args,
                item.shard_key,
                item.id,
                client_id=item.client_id,
            )
        except Exception as error:
            if is_transient(error):
                # Nothing after this write may go out ahead of it: replaying out
                # of order is how a durable queue corrupts the data it was
                # protecting.
                with client._lock:
                    queue.requeue(sendable[index:])
                report.requeued.extend(entry.id for entry in sendable[index:])

                return report

            with client._lock:
                queue.unpersist(item.id)
            settle_rejected(client, item, error)
            report.rejected.append(item.id)

            continue

        with client._lock:
            queue.unpersist(item.id)
        settle_committed(client, item, value, commit_cursor)
        report.committed.append(item.id)

    return report


def close_queue(client: Any) -> None:
    """Reject every queued write so no caller waits on a dead client.

    Durable storage is untouched: the next session restores those writes.
    """

    with client._lock:
        client._closed = True
        client._send = None
        discarded = client.offline_queue.clear()

    report_discarded(client, discarded)


# --- Internals --------------------------------------------------------------


def find_subscriptions(subs: Any, function_path: str, args: Any, shard_key: Optional[str]) -> list:
    """Live subscriptions registered under exactly this ``(path, args, shard)``.

    A linear scan, unlike ``@lunora/client``'s keyed registry, and deliberately:
    this client does not de-duplicate subscriptions, so several can share one
    triple and all of them must receive the overlay. The scan is over a handful
    of entries on the write path, not the frame path.

    A ``None`` shard key and an empty one are the same shard, so a write fired
    without one matches a subscription registered without one either way.
    """

    args_key = stable_wire_key(args if args is not None else {})
    key = shard_key or ""

    return [sub for sub in subs if sub.function_path == function_path and sub.args_key == args_key and (sub.shard_key or "") == key]


def _record_optimistic(client: Any, options: SubmitOptions) -> list:
    """Run the consumer's ``optimistic_update``, with the lock RELEASED.

    It returns the ``(subscription, value)`` overrides the callback asked for
    rather than installing them: the callback is arbitrary application code and
    is handed a store that reads the client back, so running it inside the
    critical section deadlocks the calling thread on a non-reentrant lock. The
    caller installs what comes back under the lock.
    """

    if options.optimistic_update is None:
        return []

    with client._lock:
        subs = list(client._subs.values())

    key = options.shard_key or ""
    store = OptimisticLocalStore(
        lambda path, query_args: find_subscriptions(subs, path, query_args, options.shard_key),
        lambda path: [sub for sub in subs if sub.function_path == path and (sub.shard_key or "") == key],
    )

    try:
        options.optimistic_update(store, options.args)
    except Exception:
        # Nothing was installed, so a throwing update leaves the cache exactly as
        # it found it by doing nothing at all.
        return []

    return store.writes


def _install_layers(client: Any, options: SubmitOptions, overrides: list, deferred: list) -> tuple:
    """Install both optimistic APIs' layers. Runs with the lock held."""

    confirms: list = []
    rollbacks: list = []

    def install(sub: Any, transform: Transform) -> None:
        handle = apply_optimistic_layer(sub, transform, deferred)
        if handle is not None:
            confirms.append(handle.confirm)
            rollbacks.append(handle.rollback)

    if options.optimistic is not None:
        for sub in find_subscriptions(client._subs.values(), options.function_path, options.args, options.shard_key):
            install(sub, options.optimistic)

    for sub, value in overrides:
        install(sub, lambda _current, held=value: held)

    return confirms, rollbacks


def _build_entry(client: Any, options: SubmitOptions, write_id: str, confirms: list, rollbacks: list) -> QueuedMutation:
    return QueuedMutation(
        args=options.args,
        client_id=client.client_id,
        confirms=confirms,
        function_path=options.function_path,
        # Bound at enqueue time, so the write can only ever replay as whoever
        # made it.
        identity=client.identity,
        live_awaiter=True,
        mutation_id=write_id,
        on_settled=options.on_settled,
        precondition=options.precondition,
        rollbacks=rollbacks,
        shard_key=options.shard_key,
    )


def report_discarded(client: Any, discarded: list) -> None:
    """Settle every write the queue let go of without sending it.

    Runs with the lock RELEASED: a rejection rolls optimistic layers back, which
    re-acquires it. Every discard path funnels through here, so an eviction can
    never drop a durable write in silence — which matters most for a hydrated
    record, whose original caller did not survive the restart and which therefore
    has no per-entry handler at all.
    """

    for item in discarded:
        settle_rejected(client, item.entry, item.error())


def settle_committed(client: Any, item: QueuedMutation, value: Any, commit_cursor: Optional[int]) -> None:
    deferred: list = []
    # The overlay is confirmed BEFORE the caller is told, so the gapless drop is
    # already in place when the confirming frame lands.
    with client._lock:
        confirm_all(item.confirms, commit_cursor, deferred)
    run_deferred(deferred)

    emit_settled(client, item, "committed", value=value)


def settle_rejected(client: Any, item: QueuedMutation, error: Exception) -> None:
    deferred: list = []
    with client._lock:
        rollback_all(item.rollbacks, deferred)
    run_deferred(deferred)

    emit_settled(client, item, "rejected", error=error)


def emit_settled(client: Any, item: QueuedMutation, status: str, value: Any = None, error: Optional[Exception] = None) -> None:
    """Report one write's terminal verdict, to the client AND to its own handler.

    The client-level listeners are notified unconditionally, never only when the
    entry carries a handler of its own: a hydrated write has none, so gating on
    it is exactly how an evicted durable write used to vanish in silence.
    """

    event = MutationSettled(item.id, status, value=value, error=error, had_awaiter=item.live_awaiter)

    with client._lock:
        listeners = list(client._settled_listeners)

    if item.on_settled is not None:
        listeners.insert(0, item.on_settled)

    for listener in listeners:
        # One observer raising must not stop the rest from being told: a write's
        # terminal verdict is the only report a restored write ever produces.
        with contextlib.suppress(Exception):
            listener(event)


def run_deferred(deferred: list) -> None:
    """Run notifications queued while the lock was held."""

    for call in deferred:
        call()
