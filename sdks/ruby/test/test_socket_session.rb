# frozen_string_literal: true

# The WebSocket session: the connect frame every socket opens with, the close
# codes that expire a session credential, and whisper topics. Each case drives
# the client's own socket calls and checks the frames against the goldens in
# protocol/fixtures/ws-frames.json.

require "json"
require "minitest/autorun"
require "uri"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

class TestSocketSession < Minitest::Test
  include FixtureLoader

  def ws_fixture = @ws_fixture ||= fixture("ws-frames.json")

  def test_a_detach_made_during_the_connect_write_stays_in_force
    client = Lunora::Client.new("https://app.example", client_id: "client-test")
    installed = []
    client.attach_socket(lambda do |frame|
      installed << frame
      client.detach_socket if frame["type"] == "connect"
    end)

    refute client.online?, "a detach made by the connect sender must not be undone by the attach"
    refute client.whisper("room:general", "hi"), "nothing is sent on a socket that was detached"
    assert_equal(%w[connect], installed.map { |frame| frame["type"] })
  end

  def test_connect_frame_first_and_carries_session_token
    ConformanceManifest.covers("connect_frame_first_and_carries_session_token")
    golden = ws_fixture["clientFrames"]

    client = Lunora::Client.new("https://app.example", auth_token: "rpc-bearer-1", client_id: "client-test")
    client.session_token = "session-token"
    client.subscribe("messages:list", { "channel" => "general" }, ->(_value) {})

    sent = []
    client.attach_socket(->(frame) { sent << frame })
    client.resend_subscriptions

    types = sent.map { |frame| frame["type"] }
    assert_equal %w[connect subscribe], types
    assert_equal canonical(golden["connect-with-token"]), canonical(sent.first)
    refute_includes JSON.generate(sent), "rpc-bearer-1", "the RPC bearer never rides a socket frame"

    anonymous = []
    Lunora::Client.new("https://app.example", client_id: "client-test").attach_socket(->(frame) { anonymous << frame })
    assert_equal canonical(golden["connect"]), canonical(anonymous.first)
    refute anonymous.first.key?("token"), "no session credential, so no token key"

    assert_equal canonical(golden["connect-with-token"]),
                 canonical(Lunora.build_connect_frame("client-test", token: "session-token"))
    assert_equal canonical(golden["connect-with-token-and-context"]),
                 canonical(Lunora.build_connect_frame("client-test", { "roomId" => "general" }, token: "session-token"))
  end

  def test_ws_url_carries_only_the_admin_ticket
    ConformanceManifest.covers("ws_url_carries_only_the_admin_ticket")

    client = Lunora::Client.new("https://app.example", auth_token: "rpc-bearer-1")
    client.session_token = "session-token"

    assert_equal "wss://app.example/_lunora/ws", client.send(:ws_url), "no ticket, no token parameter"

    url = client.send(:ws_url, nil, "tkt-1")
    assert_equal [%w[token tkt-1]], URI.decode_www_form(URI.parse(url).query)
    refute_includes url, "session-token"
    refute_includes url, "rpc-bearer-1"
  end

  def test_attach_socket_carries_connection_context
    ConformanceManifest.covers("attach_socket_carries_connection_context")
    golden = ws_fixture["clientFrames"]

    with_context = []
    Lunora::Client.new("https://app.example", client_id: "client-test")
                  .attach_socket(->(frame) { with_context << frame }, { "roomId" => "general" })
    assert_equal canonical(golden["connect-with-context"]), canonical(with_context.first)

    without_context = []
    Lunora::Client.new("https://app.example", client_id: "client-test").attach_socket(->(frame) { without_context << frame })
    refute without_context.first.key?("context"), "no context given, so none is sent"
  end

  def test_close_codes_drive_token_expiry
    ConformanceManifest.covers("close_codes_drive_token_expiry")
    cases = ws_fixture["closeSequences"]["cases"]
    driven = []

    cases.each do |data|
      driven << data["name"]
      notifications = 0
      errors = []
      credential = 0

      client = Lunora::Client.new("https://app.example", client_id: "client-test")
      client.on_token_expired(-> { notifications += 1 })
      client.subscribe("messages:list", {}, ->(_value) {}, ->(error) { errors << error })

      data["steps"].each do |step|
        if step.key?("attach")
          client.attach_socket(->(_frame) {})
        elsif step.key?("close")
          client.detach_socket(step["close"]["code"], step["close"]["reason"])
          refute client.online?, "#{data["name"]}: every close leaves the client offline"
        elsif step.key?("frame")
          client.handle_frame(JSON.generate(step["frame"]))
        elsif step.key?("credentialChange")
          credential += 1
          client.session_token = "credential-#{credential}"
        end
      end

      assert_equal data["tokenExpiredNotifications"], notifications, data["name"]
      assert_equal data["subscriptionErrors"], errors.length, data["name"] if data.key?("subscriptionErrors")
    end

    assert_equal cases.length, driven.length
    assert_includes driven, "superseded_socket_refusal_is_not_notified"
  end

  def test_whisper_frames_join_send_and_deliver
    ConformanceManifest.covers("whisper_frames_join_send_and_deliver")
    golden = ws_fixture["clientFrames"]
    whisper = ws_fixture["whisperFrames"]

    assert_equal canonical(golden["whisper-subscribe"]), canonical(Lunora.build_whisper_subscribe_frame("room:general"))
    assert_equal canonical(golden["whisper-unsubscribe"]), canonical(Lunora.build_whisper_unsubscribe_frame("room:general"))
    assert_equal canonical(golden["whisper-send"]), canonical(Lunora.build_whisper_frame("room:general", { "text" => "hi" }))

    whisper["serverFrames"].each do |entry|
      client = Lunora::Client.new("https://app.example")
      delivered = []
      client.whisper_subscribe("room:general") { |value| delivered << { "topic" => "room:general", "value" => value } }

      client.handle_frame(JSON.generate(entry["frame"]))

      assert_equal canonical(entry["delivered"]), canonical(delivered), entry["name"]
    end

    sent = []
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(frame) { sent << frame })
    sent.clear
    assert client.whisper("room:general", { "text" => "hi" }), "attached, so the relay goes out"
    assert_equal canonical(golden["whisper-send"]), canonical(sent.first)
  end

  def test_whisper_topics_rejoin_after_reconnect
    ConformanceManifest.covers("whisper_topics_rejoin_after_reconnect")
    rejoin = ws_fixture["whisperFrames"]["rejoinOnReconnect"]

    client = Lunora::Client.new("https://app.example")
    heard = []
    client.connect_room("general") { |message| heard << message }

    first = []
    client.attach_socket(->(frame) { first << frame })
    client.detach_socket
    second = []
    client.attach_socket(->(frame) { second << frame })

    [first, second].each do |frames|
      types = frames.map { |frame| frame["type"] }
      topics = frames.drop(1).map { |frame| frame["topic"] }

      assert_equal "connect", types.first, "connect is the first frame of every open"
      assert_equal %w[whisper_subscribe], types.drop(1)
      assert_equal rejoin, topics
    end
  end

  def test_a_room_sends_while_attached_and_leaves_once
    client = Lunora::Client.new("https://app.example")
    heard = []
    room = client.connect_room("general") { |message| heard << message }
    refute room.send({ "text" => "early" }), "no socket attached, so nothing is queued"

    sent = []
    client.attach_socket(->(frame) { sent << frame })
    assert room.send({ "text" => "hi" })
    room.close
    room.close

    types = sent.map { |frame| frame["type"] }
    assert_equal %w[connect whisper_subscribe whisper whisper_unsubscribe], types
  end

  def test_a_malformed_whisper_is_ignored_and_a_raising_listener_is_contained
    client = Lunora::Client.new("https://app.example")
    notified = 0
    client.on_token_expired(-> { raise "listener failed" })
    client.on_token_expired(-> { notified += 1 })
    client.attach_socket(->(_frame) {})

    client.handle_frame(JSON.generate({ "type" => "error", "error" => { "code" => "TOKEN_EXPIRED" } }))
    assert_equal 1, notified, "a raising listener does not stop the next one"

    client.detach_socket(4001, "")
    assert_equal 2, notified
    refute client.online?

    heard = []
    client.whisper_subscribe("room:general") { |value| heard << value }
    assert_equal "whisper", client.handle_frame(JSON.generate({ "type" => "whisper", "topic" => "room:general",
                                                                "data" => ["$lunora.wire$", "bigint", "not-a-number"] }))
    assert_empty heard
  end
end
