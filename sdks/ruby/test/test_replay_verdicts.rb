# frozen_string_literal: true

# How a flush settles each queued write, against the shared golden scenarios in
# protocol/fixtures/offline-optimistic.json: one classification for a write sent
# alone and one sent in a batch, a 413 split or settled whatever its body, a
# committed write whose result does not decode, and the empty shard key.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"
require_relative "test_offline_queue"

class TestReplayVerdicts < Minitest::Test
  include QueueFixtures

  # What a poster reads: the parsed JSON, or the raw text when it is not JSON.
  def read_body(raw)
    JSON.parse(raw)
  rescue JSON::ParserError
    raw
  end

  # A client over +poster+, a durable store, and every settled event.
  def flushing_client(poster)
    client = Lunora::Client.new("https://app.example", client_id: "c-1", http_post: poster)
    store = MemoryStore.new
    client.offline_queue = Lunora::OfflineQueue.new(persistence: store)
    settled = []
    client.on_mutation_settled(->(event) { settled << event })
    [client, store, settled]
  end

  def enqueue(client, id, shard_key: nil, confirmed: nil)
    confirms = confirmed.nil? ? [] : [->(cursor, _deferred) { confirmed << [id, cursor] }]
    client.offline_queue.enqueue(
      Lunora::QueuedMutation.new(args: {}, confirms: confirms, function_path: "messages:send", id: id,
                                 shard_key: shard_key)
    )
  end

  def batch?(body) = JSON.parse(body).key?("calls")

  def test_an_empty_shard_key_routes_to_the_default_shard_on_both_paths
    ConformanceManifest.covers("offline_flush_empty_shard_key_routes_to_default")

    %w[batch lone].each do |path|
      case_data = queue_case("emptyShardKey")[path]
      sent = []
      client, = flushing_client(lambda { |_url, _headers, body|
        sent.concat(batch?(body) ? JSON.parse(body)["calls"] : [JSON.parse(body)])
        echo_batch_slots(body, commit_cursor: 1)
      })
      case_data["queued"].each { |spec| enqueue(client, spec["id"], shard_key: spec["shardKey"]) }

      report = client.flush_offline_queue(case_data["flushShardKey"])

      assert_equal case_data["committed"], report.committed, path
      assert_equal case_data["queued"].length, sent.length, path
      sent.each { |call| refute call.key?("shardKey"), "#{path}: #{call.inspect}" }
    end
  end

  def test_a_batch_slot_whose_result_does_not_decode_settles_committed
    ConformanceManifest.covers("offline_flush_undecodable_result_settles_committed")
    fixture_data = queue_case("undecodableResult")
    case_data = fixture_data["batch"]
    confirmed = []

    client, store, settled = flushing_client(lambda { |_url, _headers, body|
      slots = JSON.parse(body)["calls"].map do |call|
        result = call["id"] == case_data["undecodableSlot"] ? fixture_data["rawResult"] : "ok"
        { "id" => call["id"], "body" => { "commitCursor" => call["id"] + 1, "result" => result } }
      end
      [200, { "results" => slots }]
    })
    case_data["queued"].each { |id| enqueue(client, id, confirmed: confirmed) }

    report = client.flush_offline_queue

    assert_equal case_data["committed"], report.committed
    assert_equal case_data["rejected"], report.rejected
    assert_equal case_data["queuedAfterFlush"], ids(client.offline_queue.items)
    assert_equal case_data["persistRemoveCalls"], store.removed
    # Every overlay is confirmed against its echoed cursor, the undecodable one's too.
    assert_equal(case_data["queued"].each_with_index.map { |id, index| [id, index + 1] }, confirmed)
    assert_decode_failures(settled, case_data, fixture_data["code"])
  end

  def test_a_lone_write_whose_result_does_not_decode_settles_committed
    ConformanceManifest.covers("offline_flush_undecodable_result_settles_committed")
    fixture_data = queue_case("undecodableResult")
    case_data = fixture_data["lone"]
    requests = 0

    client, store, settled = flushing_client(lambda { |_url, _headers, _body|
      requests += 1
      [200, { "commitCursor" => 4, "result" => fixture_data["rawResult"] }]
    })
    case_data["queued"].each { |id| enqueue(client, id) }

    report = client.flush_offline_queue
    client.flush_offline_queue

    assert_equal case_data["committed"], report.committed
    assert_equal case_data["rejected"], report.rejected
    assert_equal case_data["queuedAfterFlush"], ids(client.offline_queue.items)
    assert_equal case_data["persistRemoveCalls"], store.removed
    assert_equal case_data["requestsAfterSecondFlush"], requests
    assert_decode_failures(settled, case_data, fixture_data["code"])
  end

  def assert_decode_failures(settled, case_data, code)
    assert_equal case_data["committed"], settled.map(&:mutation_id)
    assert(settled.all? { |event| event.status == :committed })
    failed = settled.reject { |event| event.error.nil? }

    assert_equal case_data["decodeFailed"], failed.map(&:mutation_id)
    failed.each do |event|
      assert_kind_of Lunora::ApiError, event.error
      assert_equal code, event.error.code
      assert_nil event.value
    end
  end

  # A write drained for a flush exists only in that flush until it settles or
  # is re-queued. An unexpected exception out of the replay must not take the
  # unsettled ones with it.
  def test_an_unexpected_failure_mid_flush_requeues_the_unsettled_writes
    ConformanceManifest.covers("offline_flush_undecodable_result_settles_committed")
    client, store, = flushing_client(->(_url, _headers, body) { echo_batch_slots(body, result: "ok", commit_cursor: 1) })
    %w[u1 u2 u3].each { |id| enqueue(client, id) }
    original = Lunora.method(:decode_result)
    calls = 0
    Lunora.define_singleton_method(:decode_result) do |raw|
      calls += 1
      raise "injected decoder failure" if calls == 2

      original.call(raw)
    end

    begin
      assert_raises(RuntimeError) { client.flush_offline_queue }
    ensure
      Lunora.define_singleton_method(:decode_result, original)
    end

    assert_equal %w[u2 u3], ids(client.offline_queue.items)
    assert_equal %w[u1], store.removed
  end

  def test_single_and_batch_replays_classify_alike
    ConformanceManifest.covers("offline_flush_classifies_single_and_batch_alike")
    case_data = queue_case("replayClassification")

    case_data["cases"].each do |entry|
      body = entry.key?("rawBody") ? read_body(entry["rawBody"]) : entry["body"]

      case_data["paths"].each do |path, queued|
        label = "#{entry["name"]} (#{path})"
        client, store, settled = flushing_client(->(_url, _headers, _body) { [entry["status"], body] })
        queued.each { |id| enqueue(client, id) }

        report = client.flush_offline_queue

        if entry["outcome"] == "rejected"
          assert_equal queued, report.rejected, label
          assert_empty ids(client.offline_queue.items), label
          assert_equal([entry["code"]] * queued.length, settled.map { |event| event.error.code }, label)
        else
          assert_equal queued, report.requeued, label
          assert_equal queued, ids(client.offline_queue.items), label
          assert_empty settled, label
          assert_empty store.removed, label
        end
      end
    end
  end

  def test_an_envelope_less_413_splits_a_batch_and_settles_a_lone_write
    ConformanceManifest.covers("offline_flush_batch_splits_on_envelopeless_413")
    fixture_data = queue_case("envelopelessPayloadTooLarge")
    refused = [413, read_body(fixture_data["rawBody"])]

    posters = {
      "split" => lambda { |_url, _headers, body|
        calls = batch?(body) ? JSON.parse(body)["calls"].length : 1
        calls > fixture_data["split"]["refuseCallsAbove"] ? refused : echo_batch_slots(body, commit_cursor: 1)
      },
      "alwaysRefused" => ->(_url, _headers, _body) { refused },
      "lone" => ->(_url, _headers, _body) { refused }
    }

    posters.each do |name, poster|
      case_data = fixture_data[name]
      client, _store, settled = flushing_client(poster)
      case_data["queued"].each { |id| enqueue(client, id) }

      report = client.flush_offline_queue

      assert_equal case_data["committed"], report.committed, name
      assert_equal case_data["rejected"], report.rejected, name
      assert_equal case_data["queuedAfterFlush"], ids(client.offline_queue.items), name
      rejected = settled.select { |event| event.status == :rejected }

      assert_equal([fixture_data["code"]] * case_data["rejected"].length, rejected.map { |event| event.error.code }, name)
    end
  end
end
