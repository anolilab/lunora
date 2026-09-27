# frozen_string_literal: true

# With no +identity+ set, the bearer token's digest is who a queued write belongs
# to. Every write goes through +submit+ — the path that stamps it — and every
# flush is the caller's own, so nothing here depends on a socket.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

class TestTokenIdentity < Minitest::Test
  include FixtureLoader

  def token_case = scenario("offlineQueue", "tokenIdentity")

  def identity_code = scenario("offlineQueue", "identityGate")["code"]

  # A client that records each request's authorization header and answers
  # success in whichever shape the request arrived in.
  def recording_client(identity: nil, auth_token: nil, queue: nil, &on_post)
    posts = []
    client = nil
    client = Lunora::Client.new(
      "https://app.example",
      identity: identity,
      auth_token: auth_token,
      offline_queue: queue || Lunora::OfflineQueue.new(queue_before_first_connect: true),
      http_post: lambda { |_url, headers, body|
        calls = JSON.parse(body)["calls"]
        posts << (calls ? [headers["authorization"], calls.length] : headers["authorization"])
        on_post&.call(client, calls)
        next [200, { "result" => nil }] unless calls

        [200, { "results" => calls.map { |call| { "id" => call["id"], "body" => { "commitCursor" => 1, "result" => nil } } } }]
      }
    )
    settled = []
    client.on_mutation_settled(->(event) { settled << event })

    [client, posts, settled]
  end

  # Queue one write under +queue_as+ and flush it under +replay_as+, each an
  # [identity, token] pair; returns the authorization headers sent.
  def flush_after(queue_as, replay_as)
    client, posts, = recording_client(identity: queue_as[0], auth_token: queue_as[1])
    client.submit("messages:send", {})
    client.identity, client.auth_token = replay_as
    client.flush_offline_queue

    posts
  end

  def test_the_digest_matches_the_reference_client
    token_case["digests"].each do |spec|
      assert_equal spec["digest"], Lunora.token_digest(spec["token"]), "digest of #{spec["token"].inspect}"
    end
  end

  # Ruby cannot hold a lone surrogate in a valid UTF-8 string: the literal and
  # JSON.parse both refuse one. Bytes that are not valid UTF-8 digest as their
  # replacement characters rather than raising, so no token can make a submit or
  # a flush throw.
  def test_a_token_that_is_not_valid_utf8_digests_as_its_replacement
    invalid = (+"a\xED\xA0\x80b").force_encoding(Encoding::UTF_8)

    refute invalid.valid_encoding?
    assert_equal Lunora.token_digest(invalid.scrub), Lunora.token_digest(invalid)
  end

  def test_offline_unset_identity_stamps_token_digest
    ConformanceManifest.covers("offline_unset_identity_stamps_token_digest")
    test_the_digest_matches_the_reference_client
    switch = token_case["accountSwitch"]

    client, posts, settled = recording_client(auth_token: switch["queuedUnder"])
    client.submit("messages:send", {})
    client.auth_token = switch["flushedUnder"]
    report = client.flush_offline_queue

    assert_empty posts, "user A's write must not be sent with user B's bearer"
    assert_equal [settled.first.mutation_id], report.rejected
    assert_equal identity_code, settled.first.error.code
    assert_equal 0, client.pending_mutation_count

    client, posts, settled = recording_client(auth_token: switch["queuedUnder"])
    client.submit("messages:send", {})
    report = client.flush_offline_queue

    assert_equal ["Bearer #{switch["queuedUnder"]}"], posts
    assert_equal 1, report.committed.length
    assert_equal :committed, settled.first.status
  end

  def test_a_write_queued_with_no_token_replays_with_none
    client, posts, settled = recording_client
    client.submit("messages:send", {})

    report = client.flush_offline_queue

    assert_equal [nil], posts
    assert_equal 1, report.committed.length
    assert_equal :committed, settled.first.status
  end

  # Nobody is signed in, so whose write it is cannot be told: held, neither sent
  # nor dropped, as the reference's "unknown" verdict holds it.
  def test_a_write_queued_under_a_token_is_held_once_the_token_is_cleared
    store = MemoryStoreForTokens.new
    client, posts, settled = recording_client(auth_token: "token-a",
                                              queue: Lunora::OfflineQueue.new(queue_before_first_connect: true,
                                                                              persistence: store))
    client.submit("messages:send", {})
    client.auth_token = nil

    report = client.flush_offline_queue

    assert_equal [[], [], []], [posts, settled, report.rejected]
    assert_equal 1, client.pending_mutation_count
    assert_equal 1, store.records.length, "a held write stays durable"

    client.auth_token = "token-a"
    client.flush_offline_queue

    assert_equal ["Bearer token-a"], posts
  end

  def test_a_held_write_keeps_its_place_in_line
    client, _posts, = recording_client(auth_token: "token-a")
    client.submit("messages:send", {}, mutation_id: "held")
    client.auth_token = nil
    client.submit("messages:send", {}, mutation_id: "sent")
    # The second write is stamped signed out, so it replays; the first is held.
    client.offline_queue.enqueue(Lunora::QueuedMutation.new(args: {}, function_path: "messages:send", id: "held-2",
                                                            identity: Lunora.token_stamp("token-z")))

    report = client.flush_offline_queue

    assert_equal ["sent"], report.committed
    assert_equal %w[held held-2], client.offline_queue.items.map(&:id)
  end

  def test_an_identity_spelled_like_a_digest_never_matches_that_tokens_writes
    digest = Lunora.token_digest("token-a")

    assert_empty flush_after([nil, "token-a"], [digest, nil])
    assert_empty flush_after([digest, nil], [nil, "token-a"])
    assert_equal :mismatch, Lunora.replay_identity_verdict(Lunora.token_stamp("token-a"), digest, nil)
    assert_equal :mismatch, Lunora.replay_identity_verdict(digest, Lunora.token_stamp("token-a"), "token-a")
  end

  def test_a_token_stamp_survives_persistence
    client, = recording_client(auth_token: "token-a")
    client.submit("messages:send", {})
    item = client.offline_queue.items.first
    stamp = Lunora.token_stamp("token-a")

    assert_equal stamp, item.identity

    record = JSON.parse(JSON.generate(item.to_record))

    assert_equal({ "tokenDigest" => Lunora.token_digest("token-a") }, record["identity"])

    restored = Lunora::QueuedMutation.from_record(record)

    assert_equal stamp, restored.identity
    assert_equal :match, Lunora.replay_identity_verdict(restored.identity, stamp, "token-a")
  end

  def test_plain_string_and_nil_stamps_are_judged_as_before
    [
      ["user-a", "user-a", nil, :match],
      ["user-a", "user-b", nil, :mismatch],
      ["user-a", nil, nil, :unknown],
      [nil, nil, nil, :match],
      [nil, "user-a", nil, :mismatch],
      [nil, Lunora.token_stamp("token-b"), "token-b", :mismatch],
      [Lunora::ABSENT_IDENTITY, "user-a", nil, :match],
      [Lunora::ABSENT_IDENTITY, Lunora.token_stamp("token-b"), "token-b", :match]
    ].each do |stamped, current, token, verdict|
      assert_equal verdict, Lunora.replay_identity_verdict(stamped, current, token), [stamped, current].inspect
    end
  end

  # Before token digests a write queued with no identity was stamped nil
  # whatever token was held, so nil no longer says whose it is.
  def test_a_record_stamped_nil_by_an_earlier_build_is_not_sent_under_a_token
    client, posts, = recording_client(auth_token: "token-b")
    client.offline_queue.enqueue(Lunora::QueuedMutation.new(args: {}, function_path: "messages:send", id: "m1",
                                                            identity: nil))

    report = client.flush_offline_queue

    assert_equal [[], ["m1"]], [posts, report.rejected]
  end

  def test_a_legacy_unstamped_record_still_replays
    client, posts, = recording_client(auth_token: "token-b")
    client.offline_queue.enqueue(Lunora::QueuedMutation.from_record({ "args" => {}, "functionPath" => "messages:send",
                                                                      "id" => "m1" }))

    report = client.flush_offline_queue

    assert_equal [["Bearer token-b"], ["m1"]], [posts, report.committed]
  end

  # The gate judged the pass against token-a, so every request in that pass —
  # every batch chunk — carries token-a: a later chunk must not go out with
  # token-b.
  def test_a_token_switched_mid_flush_does_not_carry_the_rest_of_it
    count = Lunora::MAX_BATCH_ENTRIES + 1
    client, posts, = recording_client(auth_token: "token-a",
                                      queue: Lunora::OfflineQueue.new(max_items: count,
                                                                      queue_before_first_connect: true)) do |c, _calls|
      c.auth_token = "token-b"
    end
    count.times { client.submit("messages:send", {}) }

    client.flush_offline_queue

    assert_equal [["Bearer token-a", Lunora::MAX_BATCH_ENTRIES], ["Bearer token-a", 1]], posts
  end

  # The 413 halves are part of the same pass, so they carry the same token.
  def test_a_token_switched_mid_flush_does_not_carry_a_413_split
    headers = []
    client = nil
    client = Lunora::Client.new(
      "https://app.example",
      auth_token: "token-a",
      offline_queue: Lunora::OfflineQueue.new(queue_before_first_connect: true),
      http_post: lambda { |_url, sent, body|
        headers << sent["authorization"]
        client.auth_token = "token-b"
        calls = JSON.parse(body)["calls"]
        next [413, { "error" => { "code" => "PAYLOAD_TOO_LARGE", "message" => "too large" } }] if calls.length > 1

        [200, { "results" => [{ "id" => 0, "body" => { "commitCursor" => 1, "result" => nil } }] }]
      }
    )
    2.times { client.submit("messages:send", {}) }

    report = client.flush_offline_queue

    assert_equal 2, report.committed.length
    assert_equal ["Bearer token-a"] * 3, headers
  end

  # With no identity the token's digest is the identity, so a token change is a
  # change of user for the session as it is for the queue. Only a change FROM a
  # token evicts, as only a change from a set identity does.
  def test_a_new_token_without_an_identity_evicts_the_previous_session
    frames = fixture("ws-frames.json")
    case_data = frames["identityChange"]

    [
      ["token-a", "token-b", nil, true],
      ["token-a", nil, nil, true],
      ["token-a", "token-a", nil, false],
      [nil, "token-a", nil, false],
      ["token-a", "token-b", "user-a", false]
    ].each do |before, after, identity, evicts|
      label = [before, after, identity].inspect
      client = Lunora::Client.new("https://app.example", auth_token: before, identity: identity)
      client.attach_socket(->(_frame) {})
      client.subscribe("messages:list", {}, ->(_value) {})
      client.subscribe_shape("roomMessages", { "room" => "general" }, ->(_rows) {})
      client.handle_frame(JSON.generate(case_data["queryFrame"]))
      frames["shape"]["pokeSequence"].each { |frame| client.handle_frame(JSON.generate(frame)) }

      client.auth_token = after

      sent = []
      client.attach_socket(->(frame) { sent << frame })
      client.resend_subscriptions
      query = sent.find { |frame| frame["type"] == "subscribe" }["query"]
      shape_frame = sent.find { |frame| frame["type"] == "shape_subscribe" }

      assert_equal evicts, query["sinceSeq"].nil?, label
      assert_equal evicts, shape_frame["sinceCheckpoint"].nil?, label
    end
  end
end

# A persistence adapter that JSON round-trips every record, as a real store does.
class MemoryStoreForTokens
  attr_reader :records

  def initialize = @records = []

  def append(record) = @records << JSON.parse(JSON.generate(record))

  def load = @records.map { |record| JSON.parse(JSON.generate(record)) }

  def remove(mutation_id) = @records.reject! { |record| record["id"] == mutation_id }

  def clear = @records.clear
end
