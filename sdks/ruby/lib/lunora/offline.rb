# frozen_string_literal: true

require "securerandom"

require_relative "wire"

module Lunora
  # The oldest write was dropped because the queue is at capacity.
  OFFLINE_QUEUE_OVERFLOW = "OFFLINE_QUEUE_OVERFLOW"
  # The write's precondition no longer held when the flush reached it.
  OFFLINE_PRECONDITION_FAILED = "OFFLINE_PRECONDITION_FAILED"
  # The write was queued under a different identity than the one now in effect.
  OFFLINE_IDENTITY_CHANGED = "OFFLINE_IDENTITY_CHANGED"
  # The client was closed while the write was still queued.
  CLIENT_CLOSED = "CLIENT_CLOSED"
  # The write's args cannot be wire-encoded, so no replay of it can ever succeed.
  OFFLINE_WRITE_UNENCODABLE = "OFFLINE_WRITE_UNENCODABLE"
  # A restored record's args are not readable as wire values — the store was
  # corrupted, or written by an incompatible build.
  OFFLINE_WRITE_UNDECODABLE = "OFFLINE_WRITE_UNDECODABLE"

  # The coded errors a replay must NOT treat as the server's final word.
  #
  # The shard was momentarily unreachable, so the identical call under the same
  # idempotency key is expected to succeed later, and dropping the write would
  # lose it to a transient condition. Every other coded error IS a verdict:
  # replaying it would only re-trigger the same failure, a poison-message loop.
  TRANSIENT_ERROR_CODES = %w[SHARD_ERROR SHARD_UNAVAILABLE].freeze

  # Codes that say "not now" rather than "no". A rate-limited replay is the one
  # verdict a durable queue must never honour: the write is perfectly valid and
  # the server is asking for it later, so dropping it loses data for being
  # punctual. The delay comes from the envelope's +data.retryAfterMs+ (see
  # protocol/fixtures/rpc.json's +responseError.with-data+).
  RATE_LIMIT_ERROR_CODES = %w[RATE_LIMITED TOO_MANY_REQUESTS].freeze

  # The stamp of a record that carries no identity at all.
  #
  # Distinct from nil, which is a real value meaning "queued while signed out": a
  # write made signed out must replay signed out, while a record written before
  # stamping existed replays ambiently under whatever identity is current.
  # Collapsing the two would either strand old records or silently push one
  # user's queued writes as another.
  ABSENT_IDENTITY = :absent

  # A coded, queue-scoped failure.
  class OfflineError < StandardError
    attr_reader :code

    def initialize(code, message)
      super(message)
      @code = code
    end
  end

  # A write the queue let go of without sending it, and the coded reason.
  #
  # Returned rather than rejected in place, which is the whole point: the client
  # calls into this queue with its own Mutex held (see OfflineQueue), and a
  # rejection handler rolls optimistic layers back — which needs that same Mutex.
  # Ruby's Mutex is not reentrant, so invoking it here raised a ThreadError that
  # the queue's own rescue then swallowed: the evicted write never rolled back and
  # never settled. The caller settles these once it has released the lock.
  Discarded = Struct.new(:entry, :code, :message) do
    # The coded error this write settles with.
    def error = OfflineError.new(code, message)
  end

  # One write waiting for the socket to come back.
  #
  # +id+ is the stable idempotency key the replay sends as x-lunora-mutation-id,
  # so the server de-duplicates a write it already committed. +client_id+ is the
  # id that ISSUED the write — persisted and restored, so a replay namespaces
  # server-side under the id that made it rather than whatever the current
  # session minted. +live_awaiter+ is false for a write restored from storage
  # after a restart: its original caller is gone, so the settle observer is the
  # only report it will ever produce.
  #
  # The settle state is carried as DATA, not as verdict closures: +confirms+ and
  # +rollbacks+ are the write's optimistic-layer handles and +on_settled+ its
  # per-write observer. The client builds the MutationSettled at the settle site
  # from these, so there is exactly ONE place that decides what a terminal
  # verdict looks like — and an entry with no handles at all (a hydrated record)
  # still reports through the client-level listeners rather than to nobody.
  QueuedMutation = Struct.new(
    :id, :function_path, :args, :shard_key, :client_id, :identity,
    :live_awaiter, :precondition, :confirms, :rollbacks, :on_settled,
    keyword_init: true
  ) do
    # Whether a caller is still waiting on this write. False for a restored
    # record, and read — never restated — wherever a settle event is stamped.
    def awaited? = live_awaiter == true

    # The durable form. Callback fields are deliberately not persisted.
    #
    # +args+ is the WIRE form, not the native one. A real adapter serialises — a
    # file, a SQLite text column, a preferences store — and the native form
    # carries the codec's own wrappers, so a queued write with a WireBigInt,
    # WireBytes, WireDate or WireMap argument either fails to serialise (and is
    # reported "queued" while nothing durable was written) or serialises as
    # whatever the adapter makes of an opaque Struct and replays after a restart
    # with CORRUPTED args. Encoding here also raises for args outside the codec
    # entirely, which +OfflineQueue#enqueue+ reports through +on_persistence_error+
    # as the failed append it is — the write stays in memory with its real args
    # and settles terminally on the next flush, never persisted as a substitute.
    def to_record(version = nil)
      record = { "args" => Lunora.encode_wire(args.nil? ? {} : args), "functionPath" => function_path, "id" => id }
      record["clientId"] = client_id unless client_id.nil?
      record["identity"] = identity unless identity == Lunora::ABSENT_IDENTITY
      record["shardKey"] = shard_key unless shard_key.nil?
      record["version"] = version unless version.nil?
      record
    end

    # Rebuild a queued write from durable storage.
    #
    # The restored entry carries no settle handles: the caller that submitted it
    # did not survive the restart. A missing "identity" key restores as
    # ABSENT_IDENTITY (a legacy record) while a stored null restores as nil
    # (queued signed out) — the distinction the identity gate turns on.
    #
    # Raises WireFormatError when the stored args are not wire values. Never
    # substitutes: a record hydrated as empty args replays SUCCESSFULLY with the
    # wrong arguments, which is corruption rather than failure.
    # +OfflineQueue#hydrate+ settles such a record terminally instead.
    def self.from_record(record)
      new(
        args: Lunora.decode_wire(record["args"]),
        client_id: record["clientId"],
        function_path: record["functionPath"],
        id: record["id"],
        identity: record.key?("identity") ? record["identity"] : Lunora::ABSENT_IDENTITY,
        live_awaiter: false,
        shard_key: record["shardKey"]
      )
    end
  end

  module_function

  # A process-unique, collision-resistant id.
  #
  # It must be globally unique rather than merely locally distinct: the server
  # scopes a replayed write's de-duplication watermark by (identity, clientId),
  # and an anonymous push has no verified identity — so two anonymous clients
  # that collided would share one watermark namespace and each could suppress the
  # other's writes.
  def random_id = SecureRandom.hex(20)

  # The canonical form of a shard key: an absent key and an empty one name the
  # SAME shard (the default one), because +ws_url+ omits an empty +?shard=+ and
  # the server routes both to the same place.
  def normalize_shard_key(key) = key.nil? || key.empty? ? nil : key

  # Whether two shard keys name the same shard.
  #
  # Compared normalised rather than strictly: a write submitted with
  # +shard_key: ""+ would otherwise queue under a shard no flush ever names, so
  # it never replays and its optimistic overlay never targets a subscription.
  def same_shard?(left, right) = normalize_shard_key(left) == normalize_shard_key(right)

  # Whether a persisted record should be dropped and purged on hydrate.
  #
  # Gating is OFF until a version is configured, so a consumer that never sets
  # one restores everything. Once set, a record stamped with anything else —
  # including one from before gating was adopted, which carries no stamp — is
  # stale, so adopting a version starts from a clean slate rather than replaying
  # writes shaped for an older schema.
  def stale_version?(current, stamped) = !current.nil? && stamped != current

  # Whether a write stamped +stamped+ may replay under +current+ (nil = signed
  # out). A record with no stamp at all predates stamping and replays ambiently;
  # anything else must match exactly, nil included.
  def identity_allows_replay?(stamped, current)
    return true if stamped == ABSENT_IDENTITY

    stamped == current
  end

  # A bounded FIFO of writes waiting for the socket, optionally durable.
  #
  # Writes submitted while the socket is down are enqueued and replayed, in
  # submission order, once it comes back. With a persistence adapter wired they
  # are mirrored to durable storage as well, so +hydrate+ restores them after a
  # restart and the next flush replays them.
  #
  # The queue is deliberately transport-free: it never sends anything. The client
  # owns the flush (+Client#flush_offline_queue+), which keeps this class
  # testable with no network and lets a consumer drive a flush from its own
  # reconnect logic.
  #
  # Not internally locked, and deliberately so: every method mutates the same
  # array, and the client that owns the queue already holds a Mutex over its
  # subscription registry — and Ruby's Mutex is not reentrant, so a second lock
  # over one logical operation is a deadlock waiting to be written. Call these
  # with the owning client's lock held (which is what Client does) or from one
  # thread.
  #
  # No SETTLE path here invokes a consumer's callback, which is what makes
  # calling it under that lock safe: every method that lets go of a write RETURNS
  # it as a Discarded instead, and the client settles those once it has released
  # the lock. See Discarded for what the alternative cost. A precondition is the
  # consumer's too, so +drain_conflict+ takes the ids its caller already decided
  # rather than evaluating one here.
  #
  # +on_size_change+ and +on_persistence_error+ are the exception: they fire
  # INSIDE that critical section, because every call that can move the size is
  # made under it. Keep them to bookkeeping — one that calls back into the owning
  # client deadlocks on a Mutex that is not reentrant.
  #
  # The persistence adapter is any object answering +append+, +load+, +remove+
  # and +clear+, SYNCHRONOUSLY. The browser client's is async because IndexedDB
  # is; a consumer here injects whatever it likes and owns its own threading,
  # exactly as it does for the HTTP poster and the frame sender. +append+ and
  # +remove+ are best-effort — a raised error is reported through
  # +on_persistence_error+ and the write carries on, because losing durability is
  # strictly better than losing the write. +load+ is the one call whose failure
  # propagates: hydrating from a store that cannot be read must not look like an
  # empty store.
  class OfflineQueue
    DEFAULT_MAX_ITEMS = 1000

    # Whether writes may queue before the socket has EVER connected. Off by
    # default: without it a misconfigured endpoint silently accumulates writes
    # that will never flush instead of failing on the first one.
    attr_reader :queue_before_first_connect

    def initialize(max_items: DEFAULT_MAX_ITEMS, queue_before_first_connect: false, persistence: nil, version: nil,
                   on_size_change: nil, on_persistence_error: nil)
      # Clamped to at least one: a cap of zero accepts a write and evicts it in
      # the same call, so every submit reports "queued" and then settles
      # OFFLINE_QUEUE_OVERFLOW — a queue that cannot hold anything is a
      # misconfiguration, not a policy.
      @max_items = [1, max_items].max
      @queue_before_first_connect = queue_before_first_connect
      @persistence = persistence
      @version = version
      @on_size_change = on_size_change
      @on_persistence_error = on_persistence_error
      @items = []
    end

    def size = @items.length

    # A snapshot of the queued writes, oldest first.
    def items = @items.dup

    # Add a write to the back, persist it, and cap the queue. Returns whatever the
    # cap evicted, for the caller to report.
    def enqueue(entry)
      entry.id ||= Lunora.random_id
      @items << entry

      persist("append", entry.id) { @persistence.append(entry.to_record(@version)) } unless @persistence.nil?

      evicted = evict_overflow
      notify_size

      evicted
    end

    # Restore writes persisted in a prior session.
    #
    # Returns the distinct shard keys of the records that SURVIVED — so the caller
    # can open exactly those sockets to trigger a flush — alongside whatever the
    # capacity cap evicted. A no-op with no adapter configured.
    #
    # Restored records are UNSHIFTED ahead of whatever is already queued.
    # +hydrate+ runs after construction (a durable load takes time), so a write
    # submitted during that boot window is already in the array — and the store's
    # order is authoritative, since a prior-session write is always older.
    # Appending would let a boot-time write replay first and last-writer-wins
    # clobber newer data with stale.
    def hydrate
      return [[], []] if @persistence.nil?

      # A Hash rather than a Set so the file needs no extra require on 3.1,
      # where Set is not yet autoloaded.
      seen = @items.to_h { |item| [item.id, true] }
      restored = []
      undecodable = []

      @persistence.load.each do |record|
        id = record["id"]
        next if seen.key?(id)

        seen[id] = true

        if Lunora.stale_version?(@version, record["version"])
          persist("remove", id) { @persistence.remove(id) }
          next
        end

        begin
          restored << QueuedMutation.from_record(record)
        rescue StandardError => e
          # Purged and REPORTED, never replayed with substitute args: a record
          # whose args do not decode has no correct replay, and sending it with
          # an empty argument object would commit a DIFFERENT write than the one
          # the caller made.
          persist("remove", id) { @persistence.remove(id) }
          undecodable << Discarded.new(
            QueuedMutation.new(function_path: record["functionPath"], id: id, live_awaiter: false,
                               shard_key: record["shardKey"]),
            OFFLINE_WRITE_UNDECODABLE,
            "offline mutation restored from storage cannot be wire-decoded: #{e.message}"
          )
        end
      end

      @items.unshift(*restored)

      # A store holding more than max_items (the cap was lowered between
      # sessions, or writes piled up across restarts) must not bypass it.
      evicted = undecodable + evict_overflow
      notify_size

      # Shard keys are read AFTER eviction, from the entries that actually
      # survived: eviction drops from the front — the oldest restored records —
      # so a key gathered beforehand can name a shard with nothing queued.
      survivors = {}.compare_by_identity
      @items.each { |item| survivors[item] = true }
      shard_keys = restored.select { |entry| survivors.key?(entry) }.map(&:shard_key).uniq

      [shard_keys, evicted]
    end

    # Remove and return queued writes, oldest first. With no block this drains
    # everything; with one, only the matching writes go and the rest stay queued
    # in order — which is how one shard flushes while others are still down.
    def drain(&predicate)
      if predicate.nil?
        drained = @items
        @items = []
        notify_size
        return drained
      end

      # One pass, not two filters: the predicate is the caller's, and calling it
      # twice per entry would double any side effect it happens to carry.
      drained, kept = @items.partition(&predicate)

      unless drained.empty?
        @items = kept
        notify_size
      end

      drained
    end

    # Return drained writes to the FRONT, in order, without re-persisting them:
    # they were never un-persisted, so durable storage still holds them. Used
    # when a flush aborts on a transient failure and the unreplayed writes must
    # wait for the next reconnect.
    def requeue(entries)
      return if entries.empty?

      @items.unshift(*entries)
      notify_size
    end

    # Drop and return the writes named by +conflicted_ids+, whose preconditions no
    # longer held. Run at the start of a flush to weed out writes whose
    # assumptions died while the client was offline; the admitted writes keep
    # their FIFO order.
    #
    # The verdicts arrive as ids rather than being computed here: a precondition
    # is the CONSUMER's predicate, and this queue is called with the owning
    # client's lock held. Evaluating one here would run consumer code inside that
    # critical section, which is what Discarded exists to avoid.
    def drain_conflict(conflicted_ids)
      wanted = conflicted_ids.to_h { |id| [id, true] }

      drain { |item| wanted.key?(item.id) }.map do |item|
        Discarded.new(item, OFFLINE_PRECONDITION_FAILED, "offline mutation skipped: precondition failed before replay")
      end
    end

    # Forget one write's durable record, after it has terminally settled.
    def unpersist(mutation_id)
      return if @persistence.nil? || mutation_id.nil?

      persist("remove", mutation_id) { @persistence.remove(mutation_id) }
    end

    # Empty the queue and return every pending write, so none is left waiting on a
    # dead client.
    #
    # Durable storage is left INTACT on purpose: closing must not discard writes
    # a future session will restore. Use the adapter's own +clear+ to purge them.
    def clear
      drain.map { |item| Discarded.new(item, CLIENT_CLOSED, "client closed with the write still queued") }
    end

    private

    # Drop from the FRONT (the oldest) until the queue is within capacity. Shared
    # by +enqueue+ and +hydrate+ so an overflow always drops the same way
    # regardless of which side pushed past the cap.
    #
    # The dropped entries are returned, never rejected here — a hydrated record
    # has no live caller, so the caller reporting them is the only thing that
    # keeps an eviction from dropping a durable write in total silence.
    def evict_overflow
      evicted = []

      while @items.length > @max_items
        dropped = @items.shift
        unpersist(dropped.id)
        evicted << Discarded.new(dropped, OFFLINE_QUEUE_OVERFLOW, "offline queue overflow")
      end

      evicted
    end

    def persist(operation, mutation_id)
      yield
    rescue StandardError => e
      @on_persistence_error&.call(operation, e, mutation_id)
    end

    def notify_size
      @on_size_change&.call(@items.length)
    end
  end
end
