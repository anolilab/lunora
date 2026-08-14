"""The durable offline write queue.

A port of ``packages/client/src/offline-queue.ts``. Mutations submitted while the
socket is down are enqueued and replayed, in submission order, once it comes
back. With a :class:`PersistenceAdapter` wired the writes are mirrored to durable
storage as well, so :meth:`OfflineQueue.hydrate` restores them after a restart
and the next flush replays them.

The queue is deliberately transport-free: it never sends anything. The client
owns the flush (see ``LunoraClient.flush_offline_queue``), which is what keeps
this file unit-testable with no network and lets a consumer drive a flush from
its own reconnect logic.

**Divergences from ``@lunora/client``**, all recorded in ``sdks/README.md``:

- The persistence adapter is SYNCHRONOUS. The browser client's is async because
  IndexedDB is; a consumer here injects whatever it likes (a file, SQLite, a
  key-value store) and owns its own threading, exactly as it does for the HTTP
  poster and the frame sender.
- The identity stamp is an opaque string the CONSUMER sets
  (``LunoraClient.identity``), not a fingerprint this client derives from an auth
  token. These SDKs do not manage auth sessions, and a derived stamp would mean
  persisting a hash of a bearer token in the consumer's storage. Put a stable
  non-secret subject (a user id) there.
- There is no multi-tab leader election. There are no tabs.
"""

from __future__ import annotations

import contextlib
import os
import struct
import threading
import time
from collections.abc import Sequence
from typing import Any, Callable, Optional, Protocol

#: The oldest write was dropped because the queue is at capacity.
OFFLINE_QUEUE_OVERFLOW = "OFFLINE_QUEUE_OVERFLOW"
#: The write's precondition no longer held when the flush reached it.
OFFLINE_PRECONDITION_FAILED = "OFFLINE_PRECONDITION_FAILED"
#: The write was queued under a different identity than the one now in effect.
OFFLINE_IDENTITY_CHANGED = "OFFLINE_IDENTITY_CHANGED"
#: The client was closed while the write was still queued.
CLIENT_CLOSED = "CLIENT_CLOSED"


class _AbsentIdentity:
    """Sentinel for 'this record carries no identity stamp at all'.

    Distinct from ``None``, which is a real value meaning "queued while signed
    out": a write made signed out must replay signed out, while a record written
    before stamping existed replays ambiently under whatever identity is current.
    Collapsing the two would either strand old records or silently push one
    user's queued writes as another.
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return "ABSENT_IDENTITY"


ABSENT_IDENTITY = _AbsentIdentity()

Identity = Any  # str | None | ABSENT_IDENTITY


class OfflineError(Exception):
    """A coded, queue-scoped failure (see the module's four code constants)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_counter = 0
_counter_lock = threading.Lock()


def random_id() -> str:
    """A process-unique, collision-resistant id, mirroring ``shared/uuid.ts``.

    It MUST be globally unique rather than merely locally distinct: the server
    scopes a replayed write's de-duplication watermark by ``(identity,
    client_id)``, and an anonymous push has no verified identity — so two
    anonymous clients that collided would share one watermark namespace and each
    could suppress the other's writes.

    ``os.urandom`` supplies the entropy; the monotonic timestamp and the process
    counter make two ids minted in the same microsecond distinct even if the
    entropy source were poor.
    """

    global _counter

    with _counter_lock:
        _counter += 1
        sequence = _counter

    stamp = struct.pack(">QI", time.time_ns() & 0xFFFFFFFFFFFFFFFF, sequence & 0xFFFFFFFF)

    return (stamp + os.urandom(8)).hex()


def is_stale_version(current: Optional[str], stamped: Optional[str]) -> bool:
    """Whether a persisted record should be dropped and purged on hydrate.

    Gating is OFF until a ``version`` is configured, so an SDK that never sets one
    restores everything. Once it is set, a record stamped with anything else —
    including a record from before gating was adopted, which carries no stamp —
    is stale, so adopting a version starts from a clean slate rather than
    replaying writes shaped for an older schema.
    """

    return current is not None and stamped != current


class PersistenceAdapter(Protocol):
    """Durable storage for queued writes. Injected; synchronous.

    ``append`` and ``remove`` are fire-and-forget from the queue's point of view —
    it reports a raised exception through ``on_persistence_error`` and carries on,
    because losing durability is strictly better than losing the write itself.
    ``load`` is the one call whose failure propagates: hydrating from a store that
    cannot be read must not look like an empty store.
    """

    def append(self, record: dict) -> None: ...

    def load(self) -> list: ...

    def remove(self, mutation_id: str) -> None: ...

    def clear(self) -> None: ...


class QueuedMutation:
    """One write waiting for the socket to come back."""

    __slots__ = (
        "args",
        "client_id",
        "function_path",
        "id",
        "identity",
        "live_awaiter",
        "on_commit",
        "precondition",
        "reject",
        "resolve",
        "shard_key",
    )

    def __init__(
        self,
        function_path: str,
        args: Any,
        shard_key: Optional[str] = None,
        mutation_id: Optional[str] = None,
        client_id: Optional[str] = None,
        identity: Identity = ABSENT_IDENTITY,
        precondition: Optional[Callable[[], bool]] = None,
        on_commit: Optional[Callable[[Optional[int]], None]] = None,
        resolve: Optional[Callable[[Any], None]] = None,
        reject: Optional[Callable[[Exception], None]] = None,
        live_awaiter: bool = False,
    ) -> None:
        self.function_path = function_path
        self.args = args
        self.shard_key = shard_key
        #: Stable id, reused as the replay's ``x-lunora-mutation-id`` so the
        #: server de-duplicates a write it already committed (exactly-once).
        self.id = mutation_id if mutation_id is not None else random_id()
        #: The client id that ISSUED the write. Persisted and restored, so a
        #: replay namespaces server-side under the id that made it rather than
        #: whatever the current session minted.
        self.client_id = client_id
        self.identity = identity
        #: Evaluated just before replay; ``False`` drops the write instead of
        #: replaying it (the row it edited was deleted while offline).
        self.precondition = precondition
        #: Invoked on a successful replay with the echoed commit cursor, so a
        #: pending optimistic layer drops gaplessly when a frame reaches it.
        self.on_commit = on_commit
        self.resolve = resolve
        self.reject = reject
        #: ``True`` when a live caller is still watching this write. ``False`` for
        #: a record restored from storage after a restart — its original caller is
        #: gone, so a terminal verdict reaches nobody but the settle observer.
        self.live_awaiter = live_awaiter

    def to_record(self, version: Optional[str] = None) -> dict:
        """The durable form. Callback fields are deliberately not persisted."""

        record: dict = {"args": self.args, "functionPath": self.function_path, "id": self.id}
        if self.client_id is not None:
            record["clientId"] = self.client_id
        if self.identity is not ABSENT_IDENTITY:
            record["identity"] = self.identity
        if self.shard_key is not None:
            record["shardKey"] = self.shard_key
        if version is not None:
            record["version"] = version
        return record

    @staticmethod
    def from_record(record: dict) -> QueuedMutation:
        """Rebuild a queued write from durable storage.

        The restored entry carries no ``resolve``/``reject``: the caller that
        submitted it is gone. A missing ``identity`` key restores as
        :data:`ABSENT_IDENTITY` (a legacy record), while a stored ``null``
        restores as ``None`` (queued signed out) — the distinction the identity
        gate turns on.
        """

        return QueuedMutation(
            args=record.get("args"),
            client_id=record.get("clientId"),
            function_path=record.get("functionPath", ""),
            identity=record.get("identity", ABSENT_IDENTITY),
            mutation_id=record.get("id"),
            shard_key=record.get("shardKey"),
        )


def identity_allows_replay(stamped: Identity, current: Optional[str]) -> bool:
    """Whether a write stamped ``stamped`` may replay under ``current``.

    A record with no stamp at all predates stamping and replays ambiently;
    anything else must match exactly, ``None`` (signed out) included.
    """

    if stamped is ABSENT_IDENTITY:
        return True

    return stamped == current


class OfflineQueue:
    """A bounded FIFO of writes waiting for the socket, optionally durable.

    Not internally locked, and deliberately so: every method mutates the same
    list, and the client that owns the queue already holds a lock across its own
    subscription registry. Two locks over one logical operation is how a deadlock
    gets built. Call these methods with the owning client's lock held (which is
    what ``LunoraClient`` does), or from one thread.
    """

    def __init__(
        self,
        max_items: int = 1000,
        queue_before_first_connect: bool = False,
        persistence: Optional[PersistenceAdapter] = None,
        version: Optional[str] = None,
        on_evict: Optional[Callable[[QueuedMutation, OfflineError], None]] = None,
        on_size_change: Optional[Callable[[int], None]] = None,
        on_persistence_error: Optional[Callable[[str, Exception, Optional[str]], None]] = None,
    ) -> None:
        self.max_items = max_items
        #: Queue writes made before the socket has EVER connected. Off by
        #: default: without it a misconfigured endpoint silently accumulates
        #: writes that will never flush, instead of failing on the first one.
        self.queue_before_first_connect = queue_before_first_connect
        self.persistence = persistence
        self.version = version
        self.on_evict = on_evict
        self.on_size_change = on_size_change
        self.on_persistence_error = on_persistence_error
        self._items: list[QueuedMutation] = []

    @property
    def size(self) -> int:
        return len(self._items)

    def items(self) -> list[QueuedMutation]:
        """A snapshot of the queued writes, oldest first."""

        return list(self._items)

    def enqueue(self, entry: QueuedMutation) -> None:
        self._items.append(entry)

        if self.persistence is not None:
            self._persist("append", entry.id, lambda: self.persistence.append(entry.to_record(self.version)))

        self._evict_overflow()
        self._notify_size()

    def hydrate(self) -> list:
        """Restore writes persisted in a prior session, oldest first.

        Restored records are UNSHIFTED ahead of whatever is already queued rather
        than appended. ``hydrate`` runs after construction (a durable load takes
        time), so a write submitted during that boot window is already in the
        list — and the durable store's order is authoritative, since a
        prior-session write is always older. Appending would let a boot-time
        write replay first and last-writer-wins clobber newer data with stale.

        Returns the distinct shard keys of the records that SURVIVED, so the
        caller can open exactly those sockets to trigger a flush. A no-op with no
        adapter configured.
        """

        if self.persistence is None:
            return []

        persisted = self.persistence.load()
        restored: list[QueuedMutation] = []
        seen = {item.id for item in self._items}

        for record in persisted:
            record_id = record.get("id")
            if record_id in seen:
                continue
            seen.add(record_id)

            if is_stale_version(self.version, record.get("version")):
                self._persist("remove", record_id, lambda rid=record_id: self.persistence.remove(rid))
                continue

            restored.append(QueuedMutation.from_record(record))

        self._items[:0] = restored

        # A store holding more than ``max_items`` (the cap was lowered between
        # sessions, or writes piled up across restarts) must not bypass it.
        self._evict_overflow()
        self._notify_size()

        # Shard keys are read AFTER eviction, from the entries that actually
        # survived: eviction drops from the front — the oldest restored records —
        # so a key gathered beforehand can name a shard with nothing queued.
        survivors = {id(item) for item in self._items}
        shard_keys: list = []
        for entry in restored:
            if id(entry) in survivors and entry.shard_key not in shard_keys:
                shard_keys.append(entry.shard_key)

        return shard_keys

    def drain(self, predicate: Optional[Callable[[QueuedMutation], bool]] = None) -> list:
        """Remove and return queued writes, oldest first.

        With no predicate this drains everything. With one it drains only the
        matching writes and leaves the rest queued in order — which is how a
        single shard flushes when its socket reconnects while others are down.
        """

        if predicate is None:
            drained = self._items[:]
            self._items.clear()
            self._notify_size()
            return drained

        # One pass, not two filters: the predicate is the caller's, and calling it
        # twice per entry would double any side effect it happens to carry.
        drained: list[QueuedMutation] = []
        kept: list[QueuedMutation] = []

        for item in self._items:
            (drained if predicate(item) else kept).append(item)

        if drained:
            self._items = kept
            self._notify_size()

        return drained

    def requeue(self, items: Sequence[QueuedMutation]) -> None:
        """Return drained writes to the FRONT, in order, without re-persisting.

        They were never un-persisted, so durable storage still holds them. Used
        when a flush aborts on a transient transport failure: the unreplayed
        writes stay queued for the next reconnect.
        """

        if not items:
            return

        self._items[:0] = list(items)
        self._notify_size()

    def drain_conflict(self) -> list:
        """Drop writes whose precondition no longer holds, rejecting each.

        Run at the start of a flush to weed out writes whose assumptions died
        while the client was offline. The admitted writes keep their FIFO order.
        """

        conflicted: list[QueuedMutation] = []
        kept: list[QueuedMutation] = []

        for item in self._items:
            if item.precondition is not None and not item.precondition():
                conflicted.append(item)
            else:
                kept.append(item)

        if conflicted:
            self._items = kept
            self._notify_size()

            for item in conflicted:
                self._settle_rejected(item, OfflineError(OFFLINE_PRECONDITION_FAILED, "offline mutation skipped: precondition failed before replay"))

        return conflicted

    def unpersist(self, mutation_id: Optional[str]) -> None:
        """Forget one write's durable record, after it has terminally settled."""

        if self.persistence is None or mutation_id is None:
            return

        self._persist("remove", mutation_id, lambda: self.persistence.remove(mutation_id))

    def clear(self) -> None:
        """Reject every pending write so no caller hangs on a closed client.

        Durable storage is left INTACT on purpose: closing must not discard
        writes a future session will restore. Use the adapter's own ``clear`` to
        purge them (on sign-out, say).
        """

        drained = self._items[:]
        self._items.clear()
        self._notify_size()

        for item in drained:
            self._settle_rejected(item, OfflineError(CLIENT_CLOSED, "client closed with the write still queued"))

    # --- internals ---------------------------------------------------------

    def _evict_overflow(self) -> None:
        """Drop from the FRONT (the oldest) until the queue is within capacity.

        Shared by ``enqueue`` and ``hydrate`` so an overflow always drops the same
        way regardless of which side pushed past the cap.
        """

        while len(self._items) > self.max_items:
            dropped = self._items.pop(0)
            self.unpersist(dropped.id)
            error = OfflineError(OFFLINE_QUEUE_OVERFLOW, "offline queue overflow")
            self._settle_rejected(dropped, error)

            # Also reported to the evict observer: a hydrated record has no live
            # caller, so without this an eviction would drop a durable write in
            # total silence.
            if self.on_evict is not None:
                self.on_evict(dropped, error)

    def _settle_rejected(self, item: QueuedMutation, error: OfflineError) -> None:
        if item.reject is None:
            return

        with contextlib.suppress(Exception):
            item.reject(error)

    def _persist(self, operation: str, mutation_id: Optional[str], call: Callable[[], None]) -> None:
        try:
            call()
        except Exception as error:
            if self.on_persistence_error is not None:
                self.on_persistence_error(operation, error, mutation_id)

    def _notify_size(self) -> None:
        if self.on_size_change is not None:
            self.on_size_change(len(self._items))
