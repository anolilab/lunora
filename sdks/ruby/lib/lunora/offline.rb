# frozen_string_literal: true

require "securerandom"

module Lunora
  # The oldest write was dropped because the queue is at capacity.
  OFFLINE_QUEUE_OVERFLOW = "OFFLINE_QUEUE_OVERFLOW"
  # The write's precondition no longer held when the flush reached it.
  OFFLINE_PRECONDITION_FAILED = "OFFLINE_PRECONDITION_FAILED"
  # The write was queued under a different identity than the one now in effect.
  OFFLINE_IDENTITY_CHANGED = "OFFLINE_IDENTITY_CHANGED"
  # The client was closed while the write was still queued.
  CLIENT_CLOSED = "CLIENT_CLOSED"

  # The coded errors a replay must NOT treat as the server's final word.
  #
  # The shard was momentarily unreachable, so the identical call under the same
  # idempotency key is expected to succeed later, and dropping the write would
  # lose it to a transient condition. Every other coded error IS a verdict:
  # replaying it would only re-trigger the same failure, a poison-message loop.
  TRANSIENT_ERROR_CODES = %w[SHARD_ERROR SHARD_UNAVAILABLE].freeze

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
  # The settle callbacks are +on_resolve+/+on_reject+ rather than the sibling
  # ports' +resolve+/+reject+: a Struct member named +reject+ shadows
  # +Struct#reject+, which every enumerable helper in this file would then reach
  # through this entry rather than through Enumerable.
  QueuedMutation = Struct.new(
    :id, :function_path, :args, :shard_key, :client_id, :identity,
    :live_awaiter, :precondition, :on_commit, :on_resolve, :on_reject,
    keyword_init: true
  ) do
    # The durable form. Callback fields are deliberately not persisted.
    def to_record(version = nil)
      record = { "args" => args, "functionPath" => function_path, "id" => id }
      record["clientId"] = client_id unless client_id.nil?
      record["identity"] = identity unless identity == Lunora::ABSENT_IDENTITY
      record["shardKey"] = shard_key unless shard_key.nil?
      record["version"] = version unless version.nil?
      record
    end

    # Rebuild a queued write from durable storage.
    #
    # The restored entry carries no resolve/reject: the caller that submitted it
    # did not survive the restart. A missing "identity" key restores as
    # ABSENT_IDENTITY (a legacy record) while a stored null restores as nil
    # (queued signed out) — the distinction the identity gate turns on.
    def self.from_record(record)
      new(
        args: record["args"],
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
                   on_evict: nil, on_size_change: nil, on_persistence_error: nil)
      @max_items = max_items
      @queue_before_first_connect = queue_before_first_connect
      @persistence = persistence
      @version = version
      @on_evict = on_evict
      @on_size_change = on_size_change
      @on_persistence_error = on_persistence_error
      @items = []
    end

    def size = @items.length

    # A snapshot of the queued writes, oldest first.
    def items = @items.dup

    def enqueue(entry)
      entry.id ||= Lunora.random_id
      @items << entry

      persist("append", entry.id) { @persistence.append(entry.to_record(@version)) } unless @persistence.nil?

      evict_overflow
      notify_size
    end

    # Restore writes persisted in a prior session, returning the distinct shard
    # keys of the records that SURVIVED so the caller can open exactly those
    # sockets to trigger a flush. A no-op with no adapter configured.
    #
    # Restored records are UNSHIFTED ahead of whatever is already queued.
    # +hydrate+ runs after construction (a durable load takes time), so a write
    # submitted during that boot window is already in the array — and the store's
    # order is authoritative, since a prior-session write is always older.
    # Appending would let a boot-time write replay first and last-writer-wins
    # clobber newer data with stale.
    def hydrate
      return [] if @persistence.nil?

      # A Hash rather than a Set so the file needs no extra require on 3.1,
      # where Set is not yet autoloaded.
      seen = @items.to_h { |item| [item.id, true] }
      restored = []

      @persistence.load.each do |record|
        id = record["id"]
        next if seen.key?(id)

        seen[id] = true

        if Lunora.stale_version?(@version, record["version"])
          persist("remove", id) { @persistence.remove(id) }
          next
        end

        restored << QueuedMutation.from_record(record)
      end

      @items.unshift(*restored)

      # A store holding more than max_items (the cap was lowered between
      # sessions, or writes piled up across restarts) must not bypass it.
      evict_overflow
      notify_size

      # Shard keys are read AFTER eviction, from the entries that actually
      # survived: eviction drops from the front — the oldest restored records —
      # so a key gathered beforehand can name a shard with nothing queued.
      survivors = {}.compare_by_identity
      @items.each { |item| survivors[item] = true }
      restored.select { |entry| survivors.key?(entry) }.map(&:shard_key).uniq
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

    # Drop the writes whose precondition no longer holds, rejecting each, and
    # return them. Run at the start of a flush to weed out writes whose
    # assumptions died while the client was offline; the admitted writes keep
    # their FIFO order.
    def drain_conflict
      conflicted, kept = @items.partition { |item| !item.precondition.nil? && !item.precondition.call }
      return [] if conflicted.empty?

      @items = kept
      notify_size

      conflicted.each do |item|
        settle_rejected(item, OfflineError.new(OFFLINE_PRECONDITION_FAILED,
                                               "offline mutation skipped: precondition failed before replay"))
      end

      conflicted
    end

    # Forget one write's durable record, after it has terminally settled.
    def unpersist(mutation_id)
      return if @persistence.nil? || mutation_id.nil?

      persist("remove", mutation_id) { @persistence.remove(mutation_id) }
    end

    # Reject every pending write so no caller waits on a dead client.
    #
    # Durable storage is left INTACT on purpose: closing must not discard writes
    # a future session will restore. Use the adapter's own +clear+ to purge them.
    def clear
      drained = @items
      @items = []
      notify_size

      drained.each { |item| settle_rejected(item, OfflineError.new(CLIENT_CLOSED, "client closed with the write still queued")) }
    end

    private

    # Drop from the FRONT (the oldest) until the queue is within capacity. Shared
    # by +enqueue+ and +hydrate+ so an overflow always drops the same way
    # regardless of which side pushed past the cap.
    def evict_overflow
      while @items.length > @max_items
        dropped = @items.shift
        unpersist(dropped.id)
        error = OfflineError.new(OFFLINE_QUEUE_OVERFLOW, "offline queue overflow")
        settle_rejected(dropped, error)

        # Also reported to the evict observer: a hydrated record has no live
        # caller, so without this an eviction would drop a durable write in total
        # silence.
        @on_evict&.call(dropped, error)
      end
    end

    def settle_rejected(item, error)
      item.on_reject&.call(error)
    rescue StandardError
      # A consumer's rejection handler raising is not this queue's problem.
      nil
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
