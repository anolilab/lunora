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
import json
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Optional

from .errors import PAYLOAD_TOO_LARGE, LunoraError, decode_failed, envelope_error, reply_error
from .offline import (
    CLIENT_CLOSED,
    OFFLINE_IDENTITY_CHANGED,
    OFFLINE_WRITE_UNENCODABLE,
    OfflineError,
    QueuedMutation,
    identity_allows_replay,
    random_id,
    same_shard,
)
from .optimistic import (
    OptimisticLocalStore,
    apply_optimistic_layer,
    confirm_all,
    rollback_all,
)
from .wire import WireFormatError, decode_wire, encode_wire, stable_wire_key

if TYPE_CHECKING:  # pragma: no cover - imported for annotations only
    # Under TYPE_CHECKING alone: `client.py` imports this module at run time, so
    # a real import here would be a cycle. What it buys is that the ~40 accesses
    # below reach into a TYPED object — under `Any` a rename of `_send` or
    # `_subs` was silent, because a checker sees `Any` and checks nothing.
    from .client import LunoraClient

#: Error codes a replay must NOT treat as the server's final word on a write.
#: The shard was momentarily unreachable, so the same call under the same
#: idempotency key is expected to succeed later; dropping it would lose a durable
#: write to a transient condition. Everything else coded is a verdict — replaying
#: it would only re-trigger the same failure (a poison-message loop).
TRANSIENT_ERROR_CODES = frozenset({"SHARD_ERROR", "SHARD_UNAVAILABLE"})

#: Codes that say "not now" rather than "no". A rate-limited replay is the one
#: verdict a durable queue must never honour: the write is perfectly valid and
#: the server is asking for it later, so dropping it loses data for being
#: punctual. The delay comes from the envelope's ``data.retryAfterMs`` (see
#: ``protocol/fixtures/rpc.json``'s ``responseError.with-data``).
RATE_LIMIT_ERROR_CODES = frozenset({"RATE_LIMITED", "TOO_MANY_REQUESTS"})

#: Hard cap on entries in one batch, matching the server's own
#: (``shared/batch-wire.ts``). A Durable Object is single-threaded and replays a
#: batch's entries sequentially, so an unbounded one could pin a shard for tens
#: of thousands of dispatches. A flush with a larger backlog chunks itself.
MAX_BATCH_ENTRIES = 500

#: Byte budget for one batch body: the worker's own 1 MiB body cap
#: (``packages/runtime/src/body-readers.ts``) less 64 KiB of headroom, per
#: ``protocol/README.md`` §4.3. The entry cap alone is blind to size: 500 writes
#: carrying bytes or long text exceed a megabyte, the worker answers
#: ``413 PAYLOAD_TOO_LARGE``, and a whole-batch coded envelope is terminal for
#: every entry — so a count-only chunker settles 500 durable writes `rejected`
#: that would each have committed alone. The headroom covers the request line,
#: the headers and the JSON framing this estimate does not weigh.
MAX_BATCH_BYTES = 1_048_576 - 65_536

#: Ceiling on a rate limit's honoured delay. A server (or a proxy in front of it)
#: can name minutes, and a durable queue that sleeps that long has stopped being
#: a queue; the write is not dropped either way, only retried sooner.
MAX_RETRY_AFTER_MS = 60_000

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

    __slots__ = ("committed", "conflicted", "rejected", "requeued", "retry_after_ms")

    def __init__(self) -> None:
        #: Milliseconds the server asked the caller to wait before flushing
        #: again, when a replay came back rate-limited. ``None`` otherwise. The
        #: client enforces it too — a flush inside the window is a no-op — so
        #: this is for a caller that schedules its own retry.
        self.retry_after_ms: Optional[int] = None
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
        return error.transient or error.code in TRANSIENT_ERROR_CODES or error.code in RATE_LIMIT_ERROR_CODES

    return True


def retry_after_ms(error: BaseException) -> Optional[int]:
    """How long a rate-limited replay asks to wait, if the envelope said.

    ``None`` when the server named no delay — the caller then decides its own
    backoff rather than hammering, which is what :attr:`FlushReport.retry_after_ms`
    reports.
    """

    if not isinstance(error, LunoraError) or error.code not in RATE_LIMIT_ERROR_CODES:
        return None

    data = error.data
    delay = data.get("retryAfterMs") if isinstance(data, dict) else None

    if not isinstance(delay, int) or isinstance(delay, bool) or delay <= 0:
        return None

    return min(delay, MAX_RETRY_AFTER_MS)


async def submit_write(client: LunoraClient, options: SubmitOptions) -> MutationOutcome:
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
        value, commit_cursor, decode_error = await client._rpc_full(options.function_path, options.args, options.shard_key, write_id)
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

    # Committed, so the overlay was confirmed above; only the VALUE is lost.
    if decode_error is not None:
        raise decode_error

    return MutationOutcome("committed", write_id, value, commit_cursor)


def hydrate_queue(client: LunoraClient) -> list:
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


async def flush_queue(client: LunoraClient, shard_key: Optional[str] = None) -> FlushReport:
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
        # A server that answered "not now" gets waited out. Without this the
        # caller's own reconnect loop replays the identical burst immediately and
        # earns the same 429, indefinitely.
        remaining = client._flush_not_before - time.monotonic()

        if remaining > 0:
            report.retry_after_ms = int(remaining * 1000) + 1

            return report

        queue = client.offline_queue
        current_identity = client._identity
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

    # `same_shard`, not `==`: a null shard key and an empty one are the SAME
    # shard, so a write submitted with `shard_key=""` drains on the default
    # shard's flush instead of waiting for a socket that is never opened.
    with client._lock:
        drained = queue.drain(lambda item: same_shard(item.shard_key, shard_key))

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

    try:
        # A lone write rides the single-call path, which is the proven one. Two
        # or more coalesce into batch round trips — the flaky-reconnect win,
        # where N queued writes cost a handful of hops instead of N.
        if len(sendable) == 1:
            await _replay_sequential(client, queue, sendable, report)
        else:
            # Chunks replay sequentially, which is what preserves FIFO across a
            # flush longer than one batch. A whole-chunk transport failure stops
            # the flush rather than sending on into a connection that just failed.
            for chunk in _chunk_batches(sendable):
                if await _replay_batched(client, queue, chunk, report):
                    break
    finally:
        # EVERY drained write that did not settle goes back to the FRONT, in
        # order: a transient failure, a slot the server never answered, the
        # chunks after a stop — and whatever was still in hand when something
        # unexpected raised. The replay paths never requeue themselves; doing it
        # once, here, is what keeps an exception from losing drained writes that
        # were no longer in the queue and not yet settled.
        settled = set(report.committed) | set(report.rejected)
        leftover = [item for item in sendable if item.id not in settled]

        if leftover:
            with client._lock:
                queue.requeue(leftover)
            report.requeued.extend(item.id for item in leftover)

    return report


def _entry_bytes(item: QueuedMutation) -> int:
    """A batch entry's contribution to the request body, in bytes.

    The args dominate and are the only part that can be large; the constant
    covers the entry's fixed keys and the comma joining it to the next one.
    Encoding twice (here and in :func:`_replay_batched`) is deliberate — the
    flush is the slow path, and carrying the encoded form through the chunker
    would put a second representation of every queued write in memory.
    """

    encoded = json.dumps(encode_wire(item.args if item.args is not None else {}), separators=(",", ":"))

    return len(encoded.encode("utf-8")) + len(item.function_path) + len(item.id) + 160


def _chunk_batches(items: list) -> list:
    """Split a flush into batch bodies the worker will accept.

    By BYTES as well as by count: the worker reads a batch body under a 1 MiB
    budget and answers ``413 PAYLOAD_TOO_LARGE`` past it, so 500 writes carrying
    bytes or long text are one request the server refuses whole. A single write
    over the budget still forms its own chunk — splitting cannot help it, and
    :func:`_replay_batched` settles it on the answer.
    """

    chunks: list = []
    current: list = []
    size = 0

    for item in items:
        cost = _entry_bytes(item)

        if current and (len(current) >= MAX_BATCH_ENTRIES or size + cost > MAX_BATCH_BYTES):
            chunks.append(current)
            current = []
            size = 0

        current.append(item)
        size += cost

    if current:
        chunks.append(current)

    return chunks


def _note_retry_after(client: LunoraClient, report: FlushReport, error: BaseException) -> None:
    """Record a rate limit's delay, and hold the next flush off until it passes."""

    delay = retry_after_ms(error)

    if delay is None:
        return

    report.retry_after_ms = delay

    with client._lock:
        client._flush_not_before = max(client._flush_not_before, time.monotonic() + delay / 1000)


async def _replay_sequential(client: LunoraClient, queue: Any, items: list, report: FlushReport) -> None:
    """Replay writes one at a time. FIFO is preserved by the loop itself.

    A write left unsettled — a transient failure, and every write after it — is
    re-queued by :func:`flush_queue`, in order: nothing after it may go out
    ahead of it, since replaying out of order is how a durable queue corrupts
    the data it was protecting.
    """

    for item in items:
        try:
            value, commit_cursor, decode_error = await client._rpc_full(
                item.function_path,
                item.args,
                item.shard_key,
                item.id,
                client_id=item.client_id,
            )
        except Exception as error:
            if is_transient(error):
                _note_retry_after(client, report, error)

                return

            with client._lock:
                queue.unpersist(item.id)
            report.rejected.append(item.id)
            settle_rejected(client, item, error)

            continue

        # A committed write whose result does not decode is still committed:
        # replaying it can only return the same bytes, so it settles here with
        # the decode error rather than being retried forever.
        with client._lock:
            queue.unpersist(item.id)
        report.committed.append(item.id)
        settle_committed(client, item, value, commit_cursor, decode_error)


async def _replay_batched(client: LunoraClient, queue: Any, items: list, report: FlushReport) -> bool:
    """Replay one chunk over ``POST /_lunora/rpc-batch``; ``True`` means stop the flush.

    The worker forwards the entries to their shard, which dispatches each through
    its ordinary single-call path — so per-entry ``mutationId`` idempotency and
    in-order application are inherited from the proven route rather than
    re-implemented here.

    Stop means the whole chunk failed without a verdict. Whatever this leaves
    unsettled is re-queued by :func:`flush_queue`, once and in order.
    """

    calls = [
        {
            "args": encode_wire(item.args if item.args is not None else {}),
            "functionPath": item.function_path,
            # The slot this entry's result comes back in.
            "id": index,
            # The same stable key the single-call replay sends, beside the id
            # that namespaces its de-duplication row for an anonymous caller.
            # Per ENTRY, not on the outer request: a batch is one hop, but its
            # entries are dispatched as independent single calls.
            "mutationId": item.id,
            "clientId": item.client_id if item.client_id is not None else client.client_id,
            **({"shardKey": item.shard_key} if item.shard_key else {}),
        }
        for index, item in enumerate(items)
    ]

    try:
        status, body = await client._rpc_batch(calls)
    except Exception:
        # Transport failure — nothing committed, so retry everything.
        return True

    results = body.get("results") if isinstance(body, dict) else None

    if isinstance(results, list):
        _settle_batch_slots(client, queue, items, results, report)

        return False

    # No per-slot results, so the reply is about the WHOLE batch, and it is
    # classified by the very predicate a single call's reply is: a coded envelope
    # by its code, a 413 as PAYLOAD_TOO_LARGE, anything else as transport. A 2xx
    # carrying neither results nor an envelope said nothing about any entry.
    error = reply_error(body, status) or LunoraError("INTERNAL", "batch reply carried no results", transient=True)

    # The body was too big, not wrong — every entry in it would have committed
    # alone. Halve and retry, on ANY 413: an edge refuses an oversized body with
    # its own page, and re-queuing that chunk whole sent the identical body into
    # the identical refusal on every flush. A lone write still refused settles
    # below, terminally, as a coded 413 does.
    if error.code == PAYLOAD_TOO_LARGE and len(items) > 1:
        middle = len(items) // 2

        return await _replay_batched(client, queue, items[:middle], report) or await _replay_batched(client, queue, items[middle:], report)

    # A shard blip or a rate limit is not a verdict on the batch's contents.
    if is_transient(error):
        _note_retry_after(client, report, error)

        return True

    with client._lock:
        for item in items:
            queue.unpersist(item.id)

    for item in items:
        report.rejected.append(item.id)
        settle_rejected(client, item, error)

    return False


def _settle_batch_slots(client: LunoraClient, queue: Any, items: list, results: list, report: FlushReport) -> None:
    """Demux a batch reply back onto the writes it replayed, in input order.

    Each slot is classified exactly as :func:`_replay_sequential` classifies a
    whole response. A write left unsettled is re-queued by :func:`flush_queue`.
    """

    by_slot = {}

    for entry in results:
        if isinstance(entry, dict) and isinstance(entry.get("id"), int) and isinstance(entry.get("body"), dict):
            by_slot[entry["id"]] = entry["body"]

    for index, item in enumerate(items):
        slot = by_slot.get(index)

        if slot is None:
            # The server never returned this slot. It may or may not have
            # committed, so retry it — the `mutationId` makes that safe.
            continue

        if "error" in slot and not isinstance(slot["error"], dict):
            # An `error` key holding a string, a null, an array or a number is
            # no envelope (``protocol/README.md`` 4.2), and a slot carries no
            # HTTP status of its own to classify it by — so nothing readable
            # came back about this entry, which is exactly the position of a
            # slot the server never returned. 4.3 retries that one. Falling
            # through to the commit branch below settled a durable write
            # COMMITTED with a null result and un-persisted it.
            continue

        envelope = slot.get("error")

        if isinstance(envelope, dict):
            error = envelope_error(envelope)

            # A transient shard failure — or a limiter that refused to look — is
            # the batch's counterpart of an uncoded throw on the single-call path:
            # the server never reached a verdict, so the write goes back on the
            # queue rather than being reported as failed.
            if is_transient(error):
                _note_retry_after(client, report, error)

                continue

            with client._lock:
                queue.unpersist(item.id)
            report.rejected.append(item.id)
            settle_rejected(client, item, error)

            continue

        # The outcome is decided FIRST, inside a guard: a result that does not
        # decode is still a commit, and letting the codec error escape here lost
        # every later slot of the batch. Only then is the durable record removed.
        cursor = slot.get("commitCursor")

        try:
            value, decode_error = decode_wire(slot.get("result")), None
        except WireFormatError as failure:
            value, decode_error = None, decode_failed(failure)

        with client._lock:
            queue.unpersist(item.id)
        report.committed.append(item.id)
        settle_committed(client, item, value, cursor if isinstance(cursor, int) and not isinstance(cursor, bool) else None, decode_error)


def close_queue(client: LunoraClient) -> None:
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

    return [sub for sub in subs if sub.function_path == function_path and sub.args_key == args_key and same_shard(sub.shard_key, shard_key)]


def _record_optimistic(client: LunoraClient, options: SubmitOptions) -> list:
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

    store = OptimisticLocalStore(
        lambda path, query_args: find_subscriptions(subs, path, query_args, options.shard_key),
        lambda path: [sub for sub in subs if sub.function_path == path and same_shard(sub.shard_key, options.shard_key)],
    )

    try:
        options.optimistic_update(store, options.args)
    except Exception:
        # Nothing was installed, so a throwing update leaves the cache exactly as
        # it found it by doing nothing at all.
        return []

    return store.writes


def _install_layers(client: LunoraClient, options: SubmitOptions, overrides: list, deferred: list) -> tuple:
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


def _build_entry(client: LunoraClient, options: SubmitOptions, write_id: str, confirms: list, rollbacks: list) -> QueuedMutation:
    return QueuedMutation(
        args=options.args,
        client_id=client.client_id,
        confirms=confirms,
        function_path=options.function_path,
        # Bound at enqueue time, so the write can only ever replay as whoever
        # made it.
        identity=client._identity,
        live_awaiter=True,
        mutation_id=write_id,
        on_settled=options.on_settled,
        precondition=options.precondition,
        rollbacks=rollbacks,
        shard_key=options.shard_key,
    )


def report_discarded(client: LunoraClient, discarded: list) -> None:
    """Settle every write the queue let go of without sending it.

    Runs with the lock RELEASED: a rejection rolls optimistic layers back, which
    re-acquires it. Every discard path funnels through here, so an eviction can
    never drop a durable write in silence — which matters most for a hydrated
    record, whose original caller did not survive the restart and which therefore
    has no per-entry handler at all.
    """

    for item in discarded:
        settle_rejected(client, item.entry, item.error())


def settle_committed(client: LunoraClient, item: QueuedMutation, value: Any, commit_cursor: Optional[int], error: Optional[Exception] = None) -> None:
    """Settle a write the server committed.

    ``error`` is set — with no value — when the result did not decode
    (``WIRE_DECODE_FAILED``): the write still committed, so its overlay is
    confirmed and it is reported ``committed`` all the same.
    """

    deferred: list = []
    # The overlay is confirmed BEFORE the caller is told, so the gapless drop is
    # already in place when the confirming frame lands.
    with client._lock:
        confirm_all(item.confirms, commit_cursor, deferred)
    run_deferred(deferred)

    emit_settled(client, item, "committed", value=value, error=error)


def settle_rejected(client: LunoraClient, item: QueuedMutation, error: Exception) -> None:
    deferred: list = []
    with client._lock:
        rollback_all(item.rollbacks, deferred)
    run_deferred(deferred)

    emit_settled(client, item, "rejected", error=error)


def emit_settled(client: LunoraClient, item: QueuedMutation, status: str, value: Any = None, error: Optional[Exception] = None) -> None:
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
    """Run notifications queued while the lock was held, each in its own guard.

    They are subscriber callbacks, and one raising must not stop the rest — nor
    unwind the flush that is settling a write.
    """

    for call in deferred:
        with contextlib.suppress(Exception):
            call()
