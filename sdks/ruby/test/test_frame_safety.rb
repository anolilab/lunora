# frozen_string_literal: true

# What the frame handler and the RPC reader must survive: a poke is applied to a
# shape whole or not at all, the socket read loop outlives any frame and any
# consumer callback, what an earlier identity left live is retired, and an RPC
# body that cannot be read raises this SDK's own error.

require "json"
require "minitest/autorun"
require "pp"
require "timeout"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

class TestFrameSafety < Minitest::Test
  include FixtureLoader

  def shape_fixture = fixture("ws-frames.json")["shape"]

  def feed(client, frames) = frames.each { |frame| client.handle_frame(JSON.generate(frame)) }

  def resend(client)
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    client.resend_subscriptions
    sent
  end

  def test_a_poke_with_an_undecodable_row_is_refused_whole
    ConformanceManifest.covers("shape_poke_with_undecodable_row_is_refused_whole")
    shape = shape_fixture
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    delivered = []
    errors = []
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(rows) { delivered << rows },
                           ->(error) { errors << error })
    feed(client, shape["pokeSequence"])

    assert_equal canonical(shape["expectedRows"]), canonical(delivered.last)
    fired = delivered.length

    feed(client, shape["undecodableRowPokeSequence"])

    assert_equal fired, delivered.length, "no rows callback for a refused poke"
    assert_equal [shape["undecodableRowErrorCode"]], errors.map(&:code)

    frame = resend(client).find { |sent| sent["type"] == "shape_subscribe" }

    assert_equal shape["undecodableRowResendCheckpoint"], frame["sinceCheckpoint"]
    assert_equal "e1", frame["sinceEpoch"]

    # The view is untouched: a later empty poke re-emits exactly the old rows.
    feed(client, [{ "type" => "pokeStart", "pokeId" => "p9" },
                  { "type" => "pokePart", "pokeId" => "p9", "shapeId" => "shape_1", "rowsPatch" => [] },
                  { "type" => "pokeEnd", "pokeId" => "p9" }])

    assert_equal canonical(shape["expectedRows"]), canonical(delivered.last)

    # The server believes it delivered the refused rows, so its next diff is
    # based past them: the view drops, tells the callback, and re-seeds cold.
    sent = []
    client.attach_socket(->(sent_frame) { sent << sent_frame })
    fired = delivered.length
    feed(client, shape["gapPokeSequence"])

    assert_equal([canonical(shape["gapExpectedRows"])], delivered[fired..].map { |rows| canonical(rows) })
    assert_equal([{ "type" => "shape_subscribe", "id" => "shape_1" }],
                 sent.map { |sent_frame| sent_frame.slice("type", "id", "sinceCheckpoint", "sinceEpoch") })

    cold = resend(client).find { |sent_frame| sent_frame["type"] == "shape_subscribe" }

    refute cold.key?("sinceCheckpoint")
    refute cold.key?("sinceEpoch")
  end

  # A poke based exactly where the view is applies normally: the gap check is
  # not a re-seed on every based poke.
  def test_a_contiguous_based_poke_applies
    ConformanceManifest.covers("shape_poke_with_undecodable_row_is_refused_whole")
    shape = shape_fixture
    client = Lunora::Client.new("https://app.example")
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    delivered = []
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(rows) { delivered << rows })
    sent.clear
    feed(client, shape["pokeSequence"] + shape["contiguousPokeSequence"])

    assert_equal canonical(shape["contiguousExpectedRows"]), canonical(delivered.last)
    assert_empty sent, "no re-seed"
  end

  # The refusal is per shape: another shape in the same poke still applies.
  def test_a_refused_shape_does_not_hold_back_the_other_shapes_of_its_poke
    ConformanceManifest.covers("shape_poke_with_undecodable_row_is_refused_whole")
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    good = []
    client.subscribe_shape("a", nil, ->(_rows) {}, ->(_error) {})
    client.subscribe_shape("b", nil, ->(rows) { good << rows })
    bad = { "op" => "insert", "key" => "x", "value" => [Lunora::TAG, "bigint", "nope"] }

    feed(client, [{ "type" => "pokeStart", "pokeId" => "p" },
                  { "type" => "pokePart", "pokeId" => "p", "shapeId" => "shape_1", "rowsPatch" => [bad] },
                  { "type" => "pokePart", "pokeId" => "p", "shapeId" => "shape_2",
                    "rowsPatch" => [{ "op" => "insert", "key" => "y", "value" => 1 }] },
                  { "type" => "pokeEnd", "pokeId" => "p" }])

    assert_equal [[1]], good
  end

  def test_malformed_frames_are_ignored_without_raising
    ConformanceManifest.covers("malformed_frames_are_ignored_without_raising")
    case_data = fixture("ws-frames.json")["malformedFrames"]
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    seen = []
    client.subscribe("messages:list", {}, ->(value) { seen << value })
    client.subscribe_shape("roomMessages", nil, ->(_rows) {})
    client.handle_frame(JSON.generate(case_data["setupFrame"]))
    seen.clear

    case_data["frames"].each do |frame|
      raw = JSON.generate(frame)

      begin
        client.handle_frame(raw)
      rescue StandardError => e
        flunk "#{raw} raised #{e.class}: #{e.message}"
      end
    end

    assert_empty seen, "sub_1's callback must not fire"
    query = resend(client).find { |sent| sent["id"] == "sub_1" }["query"]

    assert_equal case_data["resendSinceSeq"], query["sinceSeq"]
    assert_equal case_data["resendSinceEpoch"], query["sinceEpoch"]
  end

  # An error envelope that is not an object, and a poke part whose rows are not
  # ops, raised TypeError out of a LIVE subscription's frames. Each is reported
  # on that subscription instead.
  def test_malformed_frames_addressed_to_live_subscriptions_do_not_raise
    ConformanceManifest.covers("malformed_frames_are_ignored_without_raising")
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    errors = []
    client.subscribe("messages:list", {}, ->(_value) {}, ->(error) { errors << error.code })
    client.subscribe_shape("roomMessages", nil, ->(_rows) {}, ->(error) { errors << error.code })

    feed(client, [{ "type" => "error", "id" => "sub_1", "error" => 5 },
                  { "type" => "error", "id" => "sub_1", "error" => [1] },
                  { "type" => "pokeStart", "pokeId" => "q" },
                  { "type" => "pokePart", "pokeId" => "q", "shapeId" => "shape_1", "rowsPatch" => "notalist" },
                  { "type" => "pokeEnd", "pokeId" => "q" },
                  { "type" => "pokeStart", "pokeId" => "r" },
                  { "type" => "pokePart", "pokeId" => "r", "shapeId" => "shape_1", "rowsPatch" => [5] },
                  { "type" => "pokeEnd", "pokeId" => "r" }])

    assert_equal [nil, nil, "WIRE_DECODE_FAILED", "WIRE_DECODE_FAILED"], errors
  end

  # A consumer callback that raises is the consumer's bug: it must neither stop
  # the other shapes of the poke being told nor escape into the socket read loop.
  def test_a_raising_callback_does_not_stop_the_others
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    delivered = []
    client.subscribe_shape("a", nil, ->(_rows) { raise "renderer bug" })
    client.subscribe_shape("b", nil, ->(rows) { delivered << rows })

    feed(client, [{ "type" => "pokeStart", "pokeId" => "p" },
                  { "type" => "pokePart", "pokeId" => "p", "shapeId" => "shape_1",
                    "rowsPatch" => [{ "op" => "insert", "key" => "a", "value" => 1 }] },
                  { "type" => "pokePart", "pokeId" => "p", "shapeId" => "shape_2",
                    "rowsPatch" => [{ "op" => "insert", "key" => "b", "value" => 2 }] },
                  { "type" => "pokeEnd", "pokeId" => "p", "checkpoint" => 1 }])

    assert_equal [[2]], delivered
  end

  def test_an_identity_change_evicts_the_previous_session
    ConformanceManifest.covers("identity_change_evicts_previous_session")
    case_data = fixture("ws-frames.json")["identityChange"]

    case_data["transitions"].each do |transition|
      label = "#{transition["from"].inspect} -> #{transition["to"].inspect}"
      client, delivered = identity_session(case_data, transition["from"])

      client.identity = transition["to"]

      sent = resend(client)
      query = sent.find { |frame| frame["type"] == "subscribe" }["query"]
      shape_frame = sent.find { |frame| frame["type"] == "shape_subscribe" }

      if transition["evicts"]
        assert_nil query["sinceSeq"], label
        assert_nil query["sinceEpoch"], label
        assert_nil shape_frame["sinceCheckpoint"], label
        assert_nil shape_frame["sinceEpoch"], label
        assert_equal [case_data["evicted"]["shapeCallbackRows"]], delivered, label
      else
        retained = case_data["retained"]

        assert_equal retained["sinceSeq"], query["sinceSeq"], label
        assert_equal retained["sinceEpoch"], query["sinceEpoch"], label
        assert_equal retained["sinceCheckpoint"], shape_frame["sinceCheckpoint"], label
        assert_empty delivered, label
      end
    end
  end

  # The fixture's starting state: +sub_1+ has seen +queryFrame+, +shape_1+ has
  # applied +pokeSequence+ (two rows), and the identity is +from+.
  def identity_session(case_data, from)
    client = Lunora::Client.new("https://app.example", identity: from)
    client.attach_socket(->(_frame) {})
    client.subscribe("messages:list", {}, ->(_value) {})
    delivered = []
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(rows) { delivered << rows })
    client.handle_frame(JSON.generate(case_data["queryFrame"]))
    feed(client, shape_fixture["pokeSequence"])

    assert_equal case_data["retained"]["shapeRowCount"], delivered.last.length
    delivered.clear

    [client, delivered]
  end

  def test_the_subscription_stream_ends_on_close
    ConformanceManifest.covers("subscription_stream_ends_on_close")
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    values, _stop = client.stream("messages:list", {})
    client.handle_frame(JSON.generate({ "type" => "data", "id" => "sub_1", "data" => { "n" => 1 } }))

    client.close

    Timeout.timeout(2) do
      assert_equal({ "n" => 1 }, values.next)
      assert_raises(StopIteration) { values.next }
    end
  end

  def test_the_auth_token_is_redacted_when_printed
    ConformanceManifest.covers("auth_token_redacted_when_printed")
    secret = "lunora-secret-7f3a9c"
    client = Lunora::Client.new("https://app.example", auth_token: secret)

    printed = capture_io do
      p client
      pp client
      puts client
    end.first
    renderings = [client.inspect, client.to_s, client.pretty_inspect, printed]

    renderings.each { |text| refute_includes text, secret }
  end
end

class TestUnreadableRpcBody < Minitest::Test
  include FixtureLoader

  # What a poster reads: the parsed JSON, or the raw text when it is not JSON.
  def read_body(raw)
    JSON.parse(raw)
  rescue JSON::ParserError
    raw
  end

  def test_an_unreadable_body_raises_the_sdk_error
    ConformanceManifest.covers("rpc_unreadable_success_body_raises_sdk_error")

    fixture("rpc.json")["unreadableSuccessBody"].each do |entry|
      client = Lunora::Client.new("https://app.example",
                                  http_post: ->(_url, _headers, _body) { [entry["status"], read_body(entry["rawBody"])] })

      %i[query mutation action].each do |call|
        error = assert_raises(Lunora::ApiError, "#{entry["name"]} #{call}") { client.public_send(call, "messages:list") }

        assert_equal entry["code"], error.code, "#{entry["name"]} #{call}"
      end
    end

    # An empty object is how a function returning nothing is answered.
    client = Lunora::Client.new("https://app.example", http_post: ->(_url, _headers, _body) { [200, read_body("{}")] })

    assert_nil client.query("messages:list")
  end
end
