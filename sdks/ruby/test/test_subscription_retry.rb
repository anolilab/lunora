# frozen_string_literal: true

# The live-query retry hint: a query subscription's error carrying retryAfterMs
# schedules one cold re-subscribe at that delay, pulled by retry_due_subscriptions.
# Each case feeds frames through handle_frame and checks the goldens in
# protocol/fixtures/ws-frames.json (subscriptionRetry).

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"

class TestSubscriptionRetry < Minitest::Test
  include FixtureLoader

  def retry_fixture
    @retry_fixture ||= fixture("ws-frames.json")["subscriptionRetry"]
  end

  # A client with one open socket and one query subscription, sub_1, that has
  # received its seed. The sent list is cleared so only later frames show up in it.
  # The third element is sub_1's unsubscribe handle.
  def subscribed_client(on_error = nil)
    client = Lunora::Client.new("https://app.example", client_id: "client-test")
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    unsubscribe = client.subscribe("messages:list", { "channel" => "general" }, ->(_value) {}, on_error)
    client.handle_frame(JSON.generate(retry_fixture["seedFrame"]))
    sent.clear
    [client, sent, unsubscribe]
  end

  # The same client with the hint already applied, so a pending retry exists.
  def pending_client
    client, sent = subscribed_client
    client.handle_frame(JSON.generate(retry_fixture["hintFrame"]))
    refute_nil client.next_subscription_retry_at, "the hint must schedule a retry before a case can cancel it"
    [client, sent]
  end

  def test_a_cold_retry_is_sent_once_at_the_hint
    client, sent = subscribed_client

    t0 = Lunora.monotonic_now
    client.handle_frame(JSON.generate(retry_fixture["hintFrame"]))
    t1 = Lunora.monotonic_now

    deadline = client.next_subscription_retry_at
    refute_nil deadline
    assert_operator deadline, :>=, t0 + 5
    assert_operator deadline, :<=, t1 + 5

    assert_equal 0, client.retry_due_subscriptions(deadline - 0.001), "nothing is due before the hint"
    assert_empty sent

    assert_equal 1, client.retry_due_subscriptions(deadline), "exactly one frame is due at the hint"
    assert_equal 1, sent.size
    assert_equal canonical(retry_fixture["retryFrame"]), canonical(sent.first),
                 "the retry is cold, even though the seed set a resume cursor"

    assert_equal 0, client.retry_due_subscriptions(deadline + 60), "a sent retry is not sent again"
    assert_nil client.next_subscription_retry_at
  end

  def test_the_error_callback_still_fires_once
    errors = []
    client, = subscribed_client(->(error) { errors << error })

    client.handle_frame(JSON.generate(retry_fixture["hintFrame"]))

    assert_equal 1, errors.size
    assert_equal "SUBSCRIPTION_REFRESH_FAILED", errors.first.code
  end

  def test_a_later_hint_replaces_the_pending_retry
    client, sent = subscribed_client

    t0 = Lunora.monotonic_now
    client.handle_frame(JSON.generate(retry_fixture["hintFrame"]))
    client.handle_frame(JSON.generate(retry_fixture["laterHintFrame"]))

    deadline = client.next_subscription_retry_at
    assert_operator deadline, :>=, t0 + 8, "the later hint's delay replaces the earlier one"

    assert_equal 0, client.retry_due_subscriptions(t0 + 5.5), "the replaced deadline is not due"
    assert_empty sent
    assert_equal 1, client.retry_due_subscriptions(deadline)
  end

  def test_every_cancel_frame_cancels_the_pending_retry
    retry_fixture["cancelFrames"].each do |entry|
      client, = pending_client

      client.handle_frame(JSON.generate(entry["frame"]))

      assert_nil client.next_subscription_retry_at, "#{entry["name"]} must cancel the pending retry"
    end
  end

  def test_no_retry_frame_schedules_anything
    retry_fixture["noRetryFrames"].each do |entry|
      client, sent = subscribed_client

      client.handle_frame(JSON.generate(entry["frame"]))

      assert_nil client.next_subscription_retry_at, "#{entry["name"]} must not schedule a retry"
      assert_equal 0, client.retry_due_subscriptions(Lunora.monotonic_now + 3600), "#{entry["name"]} sends nothing"
      assert_empty sent
    end
  end

  def test_an_unsubscribe_cancels_the_pending_retry
    client, _sent, unsubscribe = subscribed_client
    client.handle_frame(JSON.generate(retry_fixture["hintFrame"]))
    refute_nil client.next_subscription_retry_at

    unsubscribe.call

    assert_nil client.next_subscription_retry_at
  end

  def test_a_detach_cancels_the_pending_retry
    client, = pending_client

    client.detach_socket

    assert_nil client.next_subscription_retry_at
  end

  def test_an_attach_cancels_the_pending_retry
    client, = pending_client

    client.attach_socket(->(_frame) {})

    assert_nil client.next_subscription_retry_at
  end

  def test_close_cancels_the_pending_retry
    client, = pending_client

    client.close

    assert_nil client.next_subscription_retry_at
  end

  def test_a_shape_error_schedules_nothing
    client = Lunora::Client.new("https://app.example", client_id: "client-test")
    client.attach_socket(->(_frame) {})
    client.subscribe_shape("messages", {}, ->(_rows) {})
    frame = { "id" => "shape_1", "type" => "error",
              "error" => { "code" => "SUBSCRIPTION_REFRESH_FAILED", "message" => "refresh failed", "retryAfterMs" => 5000 } }

    client.handle_frame(JSON.generate(frame))

    assert_nil client.next_subscription_retry_at, "a shape is not a query, so its hint is not honoured"
  end

  def test_an_hour_long_hint_is_clamped_to_sixty_seconds
    client, = subscribed_client
    hour = retry_fixture["hintFrame"].merge("error" => retry_fixture["hintFrame"]["error"].merge("retryAfterMs" => 3_600_000))

    t1 = Lunora.monotonic_now
    client.handle_frame(JSON.generate(hour))
    t2 = Lunora.monotonic_now

    deadline = client.next_subscription_retry_at
    refute_nil deadline
    assert_operator deadline, :<=, t2 + 60, "the clamp caps the delay at MAX_RETRY_AFTER_MS"
    assert_operator deadline, :>=, t1 + 60
  end

  # Two query subscriptions, sub_1 and sub_2, each holding a pending retry, writing
  # through +sender+. Returns the client and a time by which both are due.
  def two_hinted_client(sender)
    client = Lunora::Client.new("https://app.example", client_id: "client-test")
    client.attach_socket(sender)
    %w[a b].each { |channel| client.subscribe("messages:list", { "channel" => channel }, ->(_value) {}) }
    %w[sub_1 sub_2].each do |id|
      hint = { "id" => id, "type" => "error",
               "error" => { "code" => "SUBSCRIPTION_REFRESH_FAILED", "message" => "refresh failed", "retryAfterMs" => 5000 } }
      client.handle_frame(JSON.generate(hint))
    end
    [client, Lunora.monotonic_now + 10]
  end

  def test_a_failed_write_keeps_the_unsent_retries_due
    failing = false
    subscribes = 0
    client, later = two_hinted_client(lambda do |frame|
      next unless frame["type"] == "subscribe"

      if failing
        failing = false
        raise IOError, "socket write failed"
      end
      subscribes += 1
    end)

    subscribes = 0
    failing = true
    assert_raises(IOError) { client.retry_due_subscriptions(later) }

    assert_equal 2, client.retry_due_subscriptions(later), "both retries stay due after a failed write"
    assert_equal 2, subscribes
  end

  def test_a_detach_mid_batch_stops_the_retries
    client = nil
    armed = false
    subscribes = 0
    client, later = two_hinted_client(lambda do |frame|
      next unless armed && frame["type"] == "subscribe"

      subscribes += 1
      client.detach_socket
    end)

    armed = true

    assert_equal 1, client.retry_due_subscriptions(later)
    assert_equal 1, subscribes, "a detached socket takes no more retries"
  end
end
