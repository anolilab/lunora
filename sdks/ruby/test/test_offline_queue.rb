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

  def queue_case(name) = scenario("offlineQueue", name)

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

  # Answer a request in whichever shape it arrived in: a single call gets a whole
  # response, a batch gets one success slot per entry. A flush of two or more
  # writes coalesces into +/_lunora/rpc-batch+, so a poster that only speaks the
  # single-call shape makes every batched write look unanswered.
  def echo_batch_slots(body, result: nil, commit_cursor: nil)
    calls = JSON.parse(body)["calls"]
    return [200, { "commitCursor" => commit_cursor, "result" => result }] unless calls.is_a?(Array)

    slots = calls.each_index.map do |index|
      { "id" => index, "body" => { "commitCursor" => commit_cursor, "result" => result } }
    end

    [200, { "results" => slots }]
  end

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
    ConformanceManifest.covers("offline_queue_fifo_replay_order")
    case_data = queue_case("fifo")
    sizes = []
    queue = Lunora::OfflineQueue.new(on_size_change: ->(size) { sizes << size })

    case_data["enqueue"].each { |id| queue.enqueue(entry(id)) }

    assert_equal case_data["sizeAfterEnqueue"], queue.size
    assert_equal case_data["drained"], ids(queue.drain)
    assert_equal case_data["sizeAfterDrain"], queue.size
    assert_equal case_data["sizeAfterDrain"], sizes.last
  end

  def test_a_predicate_drain_flushes_one_shard_and_leaves_the_rest
    ConformanceManifest.covers("offline_queue_drains_only_the_named_shard")
    case_data = queue_case("shardDrain")
    queue = Lunora::OfflineQueue.new

    case_data["entries"].each { |spec| queue.enqueue(entry(spec["id"], shard_key: spec["shardKey"])) }

    # Normalised, not compared strictly: an absent shard key and an empty one are
    # the SAME shard, so `m5` (queued under `""`) has to drain on a null flush or
    # nothing ever replays it.
    target = case_data["drainShardKey"]
    drained = queue.drain { |item| Lunora.same_shard?(item.shard_key, target) }

    assert_equal case_data["drained"], ids(drained)
    assert_equal case_data["remaining"], ids(queue.items)
  end

  def test_requeue_returns_writes_to_the_front_without_re_persisting
    ConformanceManifest.covers("offline_queue_fifo_replay_order")
    case_data = queue_case("requeue")
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
    case_data = queue_case("overflow")
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

  def test_a_zero_capacity_is_clamped_to_one
    ConformanceManifest.covers("offline_queue_overflow_evicts_oldest")
    queue = Lunora::OfflineQueue.new(max_items: 0)

    # Taken literally, a cap of zero accepts a write and evicts it in the same
    # call: every submit reports "queued" and then settles OVERFLOW.
    assert_empty queue.enqueue(entry("m1"))
    assert_equal ["m1"], ids(queue.items)
  end

  def test_close_rejects_every_queued_write_but_keeps_the_durable_records
    ConformanceManifest.covers("offline_queue_overflow_evicts_oldest")
    case_data = queue_case("clear")
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
    case_data = queue_case("precondition")
    queue = Lunora::OfflineQueue.new

    case_data["entries"].each do |spec|
      verdict = spec["precondition"]
      queue.enqueue(entry(spec["id"], precondition: -> { verdict }))
    end

    # The verdicts are computed by the caller and handed in as ids: a precondition
    # is the consumer's predicate, and the queue is called with the client's lock
    # held.
    failed = queue.items.reject { |item| item.precondition.call }
    conflicted = queue.drain_conflict(failed.map(&:id))

    assert_equal case_data["conflicted"].map { |id| [id, case_data["code"]] }, discarded_pairs(conflicted)
    assert_equal case_data["remaining"], ids(queue.items)
  end

  # The client evaluates the predicates OUTSIDE its lock, so one that calls back
  # into the client cannot deadlock the flush.
  def test_a_precondition_may_re_enter_the_client
    ConformanceManifest.covers("offline_queue_precondition_drops_stale_write")
    case_data = queue_case("precondition")
    client = Lunora::Client.new("https://app.example", http_post: ->(_url, _headers, body) { echo_batch_slots(body) })

    case_data["entries"].each do |spec|
      verdict = spec["precondition"]
      client.offline_queue.enqueue(entry(spec["id"], precondition: -> { client.pending_mutation_count.positive? && verdict }))
    end

    report = client.flush_offline_queue

    assert_equal case_data["conflicted"], report.conflicted
    assert_equal case_data["remaining"], report.committed
  end
end

class TestQueueHydration < Minitest::Test
  include QueueFixtures

  def test_restored_writes_land_ahead_of_boot_time_writes
    ConformanceManifest.covers("offline_queue_hydrates_persisted_writes")
    case_data = queue_case("hydrate")
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
    case_data = queue_case("hydrateOverflow")
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

  # Driven through the CLIENT, not through +OfflineQueue#hydrate+ — the direct
  # call is the test above, and it is exactly the one that misses this: a
  # restored record has no per-entry reject handler, so a client that reports a
  # discard through one reports this eviction to NOBODY while still un-persisting
  # the durable write.
  def test_a_hydrated_write_the_cap_dropped_settles_through_the_client
    ConformanceManifest.covers("offline_queue_hydrate_overflow_settles_discarded")
    case_data = queue_case("hydrateOverflow")
    store = MemoryStore.new(persisted_records(case_data))
    settled = []

    client = Lunora::Client.new("https://app.example")
    client.offline_queue = Lunora::OfflineQueue.new(
      max_items: case_data["maxItems"], persistence: store, version: case_data["version"]
    )
    client.on_mutation_settled(->(event) { settled << event })

    shard_keys = client.hydrate_offline_queue

    assert_equal case_data["shardKeys"], shard_keys
    assert_equal case_data["queuedAfterHydrate"], ids(client.offline_queue.items)
    assert_equal case_data["settledFromClient"], settled.map(&:mutation_id)
    assert_equal case_data["settledCode"], settled.first.error.code
    # Read from the entry's own live_awaiter, never restated here: it is the one
    # field that tells a restored write's ONLY report from a live caller's second.
    assert_equal case_data["settledHadAwaiter"], settled.first.had_awaiter
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
    case_data = queue_case("identityGate")

    case_data["cases"].each do |spec|
      stamped = spec["stamped"] == "absent" ? Lunora::ABSENT_IDENTITY : spec["stamped"]

      assert_equal spec["replays"], Lunora.identity_allows_replay?(stamped, spec["current"]), spec["name"]
    end
  end

  def test_flush_rejects_a_write_stamped_under_another_identity
    ConformanceManifest.covers("offline_queue_identity_gate_rejects_replay")
    case_data = queue_case("identityGate")
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
        on_settled: ->(event) { codes << event.error.code }
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
    case_data = queue_case("flushReplay")
    seen_ids = []
    confirmed = []

    # The three fixture outcomes, as this transport now expresses them. Three
    # queued writes coalesce into ONE batch hop, so `ok` and `coded-error` are
    # slots and `transport-error` is an ABSENT slot: a per-entry transport
    # failure is the server not answering for that entry, and an unanswered
    # write is retried under its original idempotency key exactly as a raw error
    # re-queues on the single-call path.
    client = Lunora::Client.new(
      "https://app.example",
      client_id: "client-1",
      http_post: lambda { |_url, _headers, body|
        seen_ids.concat(JSON.parse(body)["calls"].map { |call| call["mutationId"] })

        slots = case_data["responses"].each_with_index.filter_map do |spec, index|
          case spec["outcome"]
          when "coded-error" then { "id" => index, "body" => { "error" => { "code" => spec["code"], "message" => "gone" } } }
          when "ok" then { "id" => index, "body" => { "commitCursor" => spec["commitCursor"], "result" => { "ok" => true } } }
          end
        end

        [200, { "results" => slots }]
      }
    )

    store = MemoryStore.new
    client.offline_queue = Lunora::OfflineQueue.new(persistence: store)

    case_data["queued"].each do |id|
      client.offline_queue.enqueue(
        Lunora::QueuedMutation.new(
          args: {}, client_id: "client-1", confirms: [->(cursor, _deferred) { confirmed << [id, cursor] }],
          function_path: "messages:send", id: id
        )
      )
    end

    report = client.flush_offline_queue

    # Replayed in FIFO order, each under its own idempotency key so a write the
    # server already committed is de-duplicated rather than re-applied.
    assert_equal case_data["mutationIdHeaders"], seen_ids
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
    case_data = queue_case("overflow")
    settled = []

    client = Lunora::Client.new("https://app.example", http_post: ->(_url, _headers, _body) { [200, { "result" => nil }] })
    client.offline_queue = Lunora::OfflineQueue.new(max_items: case_data["maxItems"], queue_before_first_connect: true)
    client.on_mutation_settled(->(event) { settled << event })

    case_data["enqueue"].each { client.submit("messages:send", {}) }

    assert_equal [:rejected], settled.map(&:status)
    assert_equal case_data["code"], settled.first.error.code
    assert_equal case_data["maxItems"], client.pending_mutation_count
  end

  # The shard namespaces an anonymous caller's idempotency rows by the client id
  # (`anon:<clientId>`). A per-language constant would put every unauthenticated
  # user of this SDK in ONE key space: two of them submitting the same
  # caller-supplied mutation id, and the second write short-circuits to the
  # first user's cached result without ever running.
  def test_each_client_mints_its_own_id_on_the_wire_and_in_the_durable_record
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")
    sent = []
    post = lambda { |_url, headers, _body|
      sent << headers["x-lunora-client-id"]
      [200, { "result" => nil }]
    }

    2.times { Lunora::Client.new("https://app.example", http_post: post).mutation("messages:send", {}, nil, mutation_id: "order-1") }

    refute_includes sent, nil
    refute_equal sent[0], sent[1]

    # And it is the INSTANCE id that is persisted, so a replay after a restart
    # namespaces under the id that issued the write.
    persisted = Array.new(2).map do
      store = MemoryStore.new
      client = Lunora::Client.new(
        "https://app.example",
        offline_queue: Lunora::OfflineQueue.new(persistence: store, queue_before_first_connect: true)
      )
      client.submit("messages:send", {})
      store.appended.first["clientId"]
    end

    refute_includes persisted, nil
    refute_equal persisted[0], persisted[1]
  end

  # Two or more queued writes coalesce into ONE +/_lunora/rpc-batch+ round trip,
  # and each slot is classified exactly as a whole single-call response is.
  def test_two_or_more_writes_coalesce_into_one_batch_round_trip
    ConformanceManifest.covers("offline_flush_batches_multiple_writes")
    case_data = queue_case("batchReplay")
    urls = []
    calls = []
    confirmed = []

    client = Lunora::Client.new(
      "https://app.example",
      client_id: "c-1",
      http_post: lambda { |url, _headers, body|
        urls << url
        calls.concat(JSON.parse(body)["calls"])

        slots = case_data["slots"].map do |slot|
          if slot["outcome"] == "ok"
            { "id" => slot["id"], "body" => { "commitCursor" => slot["commitCursor"], "result" => nil } }
          else
            { "id" => slot["id"], "body" => { "error" => { "code" => slot["code"], "message" => "slot failed" } } }
          end
        end

        [200, { "results" => slots }]
      }
    )

    store = MemoryStore.new
    client.offline_queue = Lunora::OfflineQueue.new(persistence: store)

    case_data["queued"].each do |id|
      client.offline_queue.enqueue(
        Lunora::QueuedMutation.new(
          args: {}, confirms: [->(cursor, _deferred) { confirmed << [id, cursor] }],
          function_path: "messages:send", id: id
        )
      )
    end

    report = client.flush_offline_queue

    assert_equal case_data["requests"], urls.length
    assert urls.first.end_with?(case_data["path"])
    # The idempotency key and the client id ride in the ENTRY, not in a request
    # header: a batch is one hop carrying independent calls, and a single outer
    # header would de-duplicate the whole chunk against one id.
    sent = calls.map { |call| call.slice("clientId", "functionPath", "id", "mutationId") }

    assert_equal case_data["calls"], sent
    assert_equal case_data["committed"], report.committed
    # A transient shard code in a slot is not a verdict, so that write goes back
    # on the queue instead of being reported as failed — and so does the slot the
    # server never returned at all.
    assert_equal case_data["rejected"], report.rejected
    assert_equal case_data["queuedAfterFlush"], ids(client.offline_queue.items)
    assert_equal case_data["persistRemoveCalls"], store.removed
    assert_equal [[case_data["committed"].first, case_data["confirmedCommitCursor"]]], confirmed
  end

  def test_an_unencodable_write_settles_terminally_instead_of_looping_forever
    ConformanceManifest.covers("offline_flush_unencodable_write_settles_terminal")
    case_data = queue_case("unencodableWrite")
    seen_headers = []
    settled = []
    store = MemoryStore.new

    client = Lunora::Client.new(
      "https://app.example",
      http_post: lambda { |_url, headers, _body|
        seen_headers << headers["x-lunora-mutation-id"]
        [200, { "commitCursor" => 4, "result" => { "ok" => true } }]
      }
    )
    client.offline_queue = Lunora::OfflineQueue.new(persistence: store)
    client.on_mutation_settled(->(event) { settled << event })

    case_data["queued"].each do |id|
      # A bare Object is the smallest value the codec refuses; the real case is a
      # Regexp or a class instance handed to a `v.any()` field.
      args = case_data["unencodable"].include?(id) ? { "bad" => Object.new } : { "n" => id }
      client.offline_queue.enqueue(Lunora::QueuedMutation.new(args: args, function_path: "messages:send", id: id))
    end

    report = client.flush_offline_queue

    # Partitioned BEFORE the replay loop: a codec error carries no code, so the
    # transient rule would re-queue it at the FRONT on every reconnect forever —
    # never settling its caller and blocking every write behind it.
    assert_equal case_data["mutationIdHeaders"], seen_headers
    assert_equal case_data["rejected"], report.rejected
    assert_equal case_data["committed"], report.committed
    assert_equal case_data["queuedAfterFlush"], ids(client.offline_queue.items)
    assert_equal case_data["persistRemoveCalls"], store.removed
    assert_equal case_data["code"], settled.first.error.code
  end

  # +optimistic_update+ is consumer code and must run with the lock RELEASED:
  # Ruby's Mutex is not reentrant, so a callback reading the client it was handed
  # would otherwise hard-deadlock its own thread.
  def test_an_optimistic_update_may_re_enter_the_client
    ConformanceManifest.covers("offline_flush_replays_and_confirms_optimistic")
    seen = []
    observed = nil

    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    client.subscribe("messages:list", {}, ->(value) { seen << value })
    client.handle_frame(JSON.generate({ "cursor" => 1, "data" => %w[a], "id" => "sub_1", "type" => "data" }))
    client.detach_socket

    outcome = client.submit("messages:send", {}, optimistic_update: lambda { |store, _args|
      observed = [client.pending_mutation_count, client.online?, store.get_query("messages:list", {})]
      store.set_query("messages:list", {}, %w[a z])
    })

    assert_equal :queued, outcome.status
    assert_equal [0, false, %w[a]], observed
    assert_equal %w[a z], seen.last
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
