# frozen_string_literal: true

# The durable offline write queue, against the shared golden scenarios in
# protocol/fixtures/offline-optimistic.json. Every ordering and every code is
# read from that file, so a port that disagrees with the other six fails rather
# than quietly documenting a second behaviour.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

# A persistence adapter that records every call.
class MemoryStore
  attr_reader :records, :appended, :removed, :cleared

  def initialize(records = [])
    @records = records.dup
    @appended = []
    @removed = []
    @cleared = 0
  end

  def append(record)
    @appended << record
    @records << record
  end

  def load = @records.dup

  def remove(mutation_id)
    @removed << mutation_id
    @records.reject! { |record| record["id"] == mutation_id }
  end

  def clear
    @cleared += 1
    @records = []
  end
end

module QueueFixtures
  include FixtureLoader

  def scenario(name)
    fixture("offline-optimistic.json").fetch("offlineQueue").fetch(name)
  end

  def entry(id, shard_key: nil, precondition: nil, identity: Lunora::ABSENT_IDENTITY)
    Lunora::QueuedMutation.new(
      args: { "n" => id },
      function_path: "messages:send",
      id: id,
      identity: identity,
      precondition: precondition,
      shard_key: shard_key
    )
  end

  def ids(items) = items.map(&:id)

  # The (id, code) pairs a queue reported letting go of.
  def discarded_pairs(discarded) = discarded.map { |item| [item.entry.id, item.code] }

  # Turn a fixture's `persisted` list into durable records.
  def persisted_records(case_data)
    case_data["persisted"].map do |spec|
      {
        "args" => {}, "functionPath" => "messages:send", "id" => spec["id"],
        "shardKey" => spec["shardKey"], "version" => spec["version"]
      }
    end
  end
end

class TestQueueOrdering < Minitest::Test
  include QueueFixtures

  def test_writes_drain_in_submission_order
    ConformanceManifest.covers("offline_queue_fifo_and_shard_drain")
    case_data = scenario("fifo")
    sizes = []
    queue = Lunora::OfflineQueue.new(on_size_change: ->(size) { sizes << size })

    case_data["enqueue"].each { |id| queue.enqueue(entry(id)) }

    assert_equal case_data["sizeAfterEnqueue"], queue.size
    assert_equal case_data["drained"], ids(queue.drain)
    assert_equal case_data["sizeAfterDrain"], queue.size
    assert_equal case_data["sizeAfterDrain"], sizes.last
  end

  def test_a_predicate_drain_flushes_one_shard_and_leaves_the_rest
    ConformanceManifest.covers("offline_queue_fifo_and_shard_drain")
    case_data = scenario("shardDrain")
    queue = Lunora::OfflineQueue.new

    case_data["entries"].each { |spec| queue.enqueue(entry(spec["id"], shard_key: spec["shardKey"])) }

    target = case_data["drainShardKey"]
    drained = queue.drain { |item| item.shard_key == target }

    assert_equal case_data["drained"], ids(drained)
    assert_equal case_data["remaining"], ids(queue.items)
  end

  def test_requeue_returns_writes_to_the_front_without_re_persisting
    ConformanceManifest.covers("offline_queue_fifo_and_shard_drain")
    case_data = scenario("requeue")
    store = MemoryStore.new
    queue = Lunora::OfflineQueue.new(persistence: store)

    case_data["enqueue"].each { |id| queue.enqueue(entry(id)) }
    queue.requeue(queue.drain.select { |item| case_data["requeued"].include?(item.id) })

    assert_equal case_data["queuedAfterRequeue"], ids(queue.items)
    # Durable storage still holds them — they were never un-persisted, so a
    # re-append would duplicate the record.
    assert_equal case_data["persistAppendCalls"], store.appended.length
  end
end

class TestQueueOverflow < Minitest::Test
  include QueueFixtures

  def test_overflow_evicts_the_oldest_write
    ConformanceManifest.covers("offline_queue_overflow_evicts_oldest")
    case_data = scenario("overflow")
    evicted = []
    store = MemoryStore.new
    queue = Lunora::OfflineQueue.new(max_items: case_data["maxItems"], persistence: store)

    case_data["enqueue"].each { |id| evicted.concat(queue.enqueue(entry(id))) }

    assert_equal case_data["remaining"], ids(queue.items)
    # Returned, not rejected in place: the caller settles it once it has released
    # its lock. A hydrated entry has no live caller at all, so this is the only
    # thing standing between an eviction and a durable write vanishing in silence.
    assert_equal case_data["evicted"].map { |id| [id, case_data["code"]] }, discarded_pairs(evicted)
    assert_equal case_data["persistRemoveCalls"], store.removed
  end

  def test_close_rejects_every_queued_write_but_keeps_the_durable_records
    ConformanceManifest.covers("offline_queue_overflow_evicts_oldest")
    case_data = scenario("clear")
    store = MemoryStore.new
    queue = Lunora::OfflineQueue.new(persistence: store)

    case_data["enqueue"].each { |id| queue.enqueue(entry(id)) }
    discarded = queue.clear

    assert_equal case_data["rejected"].map { |id| [id, case_data["code"]] }, discarded_pairs(discarded)
    assert_equal 0, queue.size
    # Closing must NOT discard writes the next session will restore.
    assert_equal case_data["persistRemoveCalls"], store.removed
    assert_equal case_data["enqueue"].length, store.records.length
  end
end

class TestQueuePrecondition < Minitest::Test
  include QueueFixtures

  def test_a_stale_write_is_dropped_before_it_replays
    ConformanceManifest.covers("offline_queue_precondition_drops_stale_write")
    case_data = scenario("precondition")
    queue = Lunora::OfflineQueue.new

    case_data["entries"].each do |spec|
      verdict = spec["precondition"]
      queue.enqueue(entry(spec["id"], precondition: -> { verdict }))
    end

    conflicted = queue.drain_conflict

    assert_equal case_data["conflicted"].map { |id| [id, case_data["code"]] }, discarded_pairs(conflicted)
    assert_equal case_data["remaining"], ids(queue.items)
  end
end

class TestQueueHydration < Minitest::Test
  include QueueFixtures

  def test_restored_writes_land_ahead_of_boot_time_writes
    ConformanceManifest.covers("offline_queue_hydrates_persisted_writes")
    case_data = scenario("hydrate")
    store = MemoryStore.new(persisted_records(case_data))
    queue = Lunora::OfflineQueue.new(persistence: store, version: case_data["version"])

    # Submitted during the boot window, BEFORE the durable load returns.
    case_data["liveEnqueue"].each { |id| queue.enqueue(entry(id)) }

    shard_keys, evicted = queue.hydrate

    assert_empty evicted, "nothing exceeded the default capacity"
    # The durable store's order is authoritative: a prior-session write is always
    # older, so replaying the boot-time write first would let last-writer-wins
    # clobber newer data with stale.
    assert_equal case_data["queuedAfterHydrate"], ids(queue.items)
    # A record stamped under another app version is dropped AND purged.
    assert_equal case_data["purged"], store.removed
    assert_equal case_data["shardKeys"].sort_by(&:to_s), shard_keys.sort_by(&:to_s)
  end

  def test_hydration_respects_the_capacity_cap
    ConformanceManifest.covers("offline_queue_hydrates_persisted_writes")
    case_data = scenario("hydrateOverflow")
    store = MemoryStore.new(persisted_records(case_data))
    queue = Lunora::OfflineQueue.new(
      max_items: case_data["maxItems"],
      persistence: store,
      version: case_data["version"]
    )

    shard_keys, evicted = queue.hydrate

    evicted_ids = evicted.map { |item| item.entry.id }

    assert_equal case_data["queuedAfterHydrate"], ids(queue.items)
    assert_equal case_data["evicted"], evicted_ids
    # Only the shards whose writes SURVIVED — a key gathered before eviction
    # would send the caller to open a socket with nothing queued behind it.
    assert_equal case_data["shardKeys"], shard_keys
  end

  def test_version_gating_is_off_until_a_version_is_configured
    ConformanceManifest.covers("offline_queue_hydrates_persisted_writes")

    refute Lunora.stale_version?(nil, nil)
    refute Lunora.stale_version?(nil, "v1")
    assert Lunora.stale_version?("v2", nil)
    assert Lunora.stale_version?("v2", "v1")
    refute Lunora.stale_version?("v2", "v2")
  end

  def test_ids_do_not_collide
    ConformanceManifest.covers("offline_queue_hydrates_persisted_writes")

    # Two anonymous clients that collided on an id would share one
    # de-duplication namespace server-side, letting one suppress the other.
    minted = Array.new(2000) { Lunora.random_id }

    assert_equal minted.length, minted.uniq.length
  end
end

class TestIdentityGate < Minitest::Test
  include QueueFixtures

  def test_a_write_only_replays_under_the_identity_that_made_it
    ConformanceManifest.covers("offline_queue_identity_gate_rejects_replay")
    case_data = scenario("identityGate")

    case_data["cases"].each do |spec|
      stamped = spec["stamped"] == "absent" ? Lunora::ABSENT_IDENTITY : spec["stamped"]

      assert_equal spec["replays"], Lunora.identity_allows_replay?(stamped, spec["current"]), spec["name"]
    end
  end

  def test_flush_rejects_a_write_stamped_under_another_identity
    ConformanceManifest.covers("offline_queue_identity_gate_rejects_replay")
    case_data = scenario("identityGate")
    posts = []
    codes = []

    client = Lunora::Client.new(
      "https://app.example",
      http_post: lambda { |_url, headers, _body|
        posts << headers
        [200, { "result" => nil }]
      },
      identity: "user-b"
    )
    client.offline_queue.enqueue(
      Lunora::QueuedMutation.new(
        args: {}, function_path: "messages:send", id: "m1", identity: "user-a",
        on_reject: ->(error) { codes << error.code }
      )
    )

    report = client.flush_offline_queue

    assert_equal ["m1"], report.rejected
    assert_empty report.committed
    # Nothing reached the wire: a restart must not push the previous user's
    # queued writes as the current one.
    assert_empty posts
    assert_equal [case_data["code"]], codes
  end
end

class TestFlushIntegration < Minitest::Test
  include QueueFixtures

  def test_a_flush_replays_in_order_and_confirms_the_optimistic_overlay
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")
    case_data = scenario("flushReplay")
    by_id = case_data["responses"].to_h { |spec| [spec["id"], spec] }
    seen_headers = []
    confirmed = []

    client = Lunora::Client.new(
      "https://app.example",
      client_id: "client-1",
      http_post: lambda { |_url, headers, _body|
        mutation_id = headers["x-lunora-mutation-id"]
        seen_headers << mutation_id
        spec = by_id[mutation_id]

        case spec["outcome"]
        when "transport-error" then raise IOError, "connection reset"
        when "coded-error" then [200, { "error" => { "code" => spec["code"], "message" => "gone" } }]
        else [200, { "commitCursor" => spec["commitCursor"], "result" => { "ok" => true } }]
        end
      }
    )

    store = MemoryStore.new
    client.offline_queue = Lunora::OfflineQueue.new(persistence: store)

    case_data["queued"].each do |id|
      client.offline_queue.enqueue(
        Lunora::QueuedMutation.new(
          args: {}, client_id: "client-1", function_path: "messages:send", id: id,
          on_commit: ->(cursor) { confirmed << [id, cursor] }, on_reject: ->(_error) {}, on_resolve: ->(_value) {}
        )
      )
    end

    report = client.flush_offline_queue

    # Replayed in FIFO order, each under its own idempotency key so a write the
    # server already committed is de-duplicated rather than re-applied.
    assert_equal case_data["mutationIdHeaders"], seen_headers
    assert_equal case_data["committed"], report.committed
    # A coded verdict is terminal: replaying it would only re-trigger the same
    # failure. A transport failure is not, so that write stays queued.
    assert_equal case_data["rejected"], report.rejected
    assert_equal case_data["queuedAfterFlush"], ids(client.offline_queue.items)
    assert_equal case_data["queuedAfterFlush"], report.requeued
    assert_equal case_data["persistRemoveCalls"], store.removed
    assert_equal [[case_data["committed"].first, case_data["confirmedCommitCursor"]]], confirmed
  end

  def test_a_transient_shard_code_requeues_instead_of_dropping
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")

    client = Lunora::Client.new(
      "https://app.example",
      http_post: ->(_url, _headers, _body) { [200, { "error" => { "code" => "SHARD_UNAVAILABLE", "message" => "restarting" } }] }
    )
    client.offline_queue.enqueue(Lunora::QueuedMutation.new(args: {}, function_path: "messages:send", id: "m1"))

    report = client.flush_offline_queue

    # The shard blinked; the identical call is expected to succeed later, so
    # dropping the write here would lose it to a transient condition.
    assert_equal ["m1"], report.requeued
    assert_equal ["m1"], ids(client.offline_queue.items)
  end

  def test_a_write_made_offline_is_queued_with_its_optimistic_overlay
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")
    posts = []
    seen = []

    client = Lunora::Client.new(
      "https://app.example",
      http_post: lambda { |_url, headers, _body|
        posts << headers
        [200, { "commitCursor" => 4, "result" => { "ok" => true } }]
      }
    )

    client.attach_socket(->(_frame) {})
    client.subscribe("messages:list", { "channel" => "general" }, ->(value) { seen << value })
    # Prime the subscription with a server value, then drop the socket.
    client.handle_frame(JSON.generate({ "cursor" => 1, "data" => %w[a], "id" => "sub_1", "type" => "data" }))
    client.detach_socket

    outcome = client.submit("messages:list", { "channel" => "general" }, optimistic: ->(current) { (current || []) + ["c"] })

    assert_equal :queued, outcome.status
    assert_equal %w[a c], seen.last
    assert_equal 1, client.pending_mutation_count
    # Queued, not sent: nothing may reach the wire while the socket is down.
    assert_empty posts

    client.attach_socket(->(_frame) {})
    client.flush_offline_queue

    assert_equal 1, posts.length
    assert_equal 0, client.pending_mutation_count
    # Still displayed: the overlay is confirmed at cursor 4 and drops only once a
    # frame reaches it.
    assert_equal %w[a c], seen.last

    client.handle_frame(JSON.generate({ "cursor" => 4, "data" => %w[a c], "id" => "sub_1", "type" => "data" }))

    assert_equal %w[a c], seen.last
  end

  def test_a_write_before_the_first_connect_fails_fast_by_default
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")

    client = Lunora::Client.new("https://app.example", http_post: ->(_url, _headers, _body) { raise IOError, "no route to host" })

    # Never connected and the opt-in is off, so a misconfigured endpoint surfaces
    # on the first write rather than silently filling a queue that never flushes.
    assert_raises(IOError) { client.submit("messages:send", { "text" => "hi" }) }
    assert_equal 0, client.pending_mutation_count

    client.offline_queue = Lunora::OfflineQueue.new(queue_before_first_connect: true)
    outcome = client.submit("messages:send", { "text" => "hi" })

    assert_equal :queued, outcome.status
    assert_equal 1, client.pending_mutation_count
  end

  # An eviction triggered from inside +submit+ settles rather than re-entering the
  # client's Mutex.
  #
  # This is the regression: the queue used to reject an evicted write in place,
  # and that rejection rolls optimistic layers back — which re-acquires the very
  # Mutex +submit+ was holding. Ruby's Mutex is not reentrant, so it raised a
  # ThreadError that the queue's own rescue swallowed: the write never rolled back
  # and never settled.
  def test_an_overflow_during_submit_settles_rather_than_re_entering_the_lock
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")
    case_data = scenario("overflow")
    settled = []

    client = Lunora::Client.new("https://app.example", http_post: ->(_url, _headers, _body) { [200, { "result" => nil }] })
    client.offline_queue = Lunora::OfflineQueue.new(max_items: case_data["maxItems"], queue_before_first_connect: true)
    client.on_mutation_settled(->(event) { settled << event })

    case_data["enqueue"].each { client.submit("messages:send", {}) }

    assert_equal [:rejected], settled.map(&:status)
    assert_equal case_data["code"], settled.first.error.code
    assert_equal case_data["maxItems"], client.pending_mutation_count
  end

  def test_a_failed_online_write_rolls_its_overlay_back
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")
    seen = []

    client = Lunora::Client.new(
      "https://app.example",
      http_post: ->(_url, _headers, _body) { [200, { "error" => { "code" => "NOT_FOUND", "message" => "gone" } }] }
    )

    client.attach_socket(->(_frame) {})
    client.subscribe("messages:list", {}, ->(value) { seen << value })
    client.handle_frame(JSON.generate({ "cursor" => 1, "data" => %w[a], "id" => "sub_1", "type" => "data" }))

    assert_raises(Lunora::ApiError) { client.submit("messages:list", {}, optimistic: ->(current) { (current || []) + ["c"] }) }
    assert_equal %w[a], seen.last
  end
end
