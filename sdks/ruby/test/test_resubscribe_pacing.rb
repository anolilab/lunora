# frozen_string_literal: true

# A reconnect re-sends its query subscriptions a few at a time, as the reference
# client does. RESUBSCRIBE_CONCURRENCY in packages/client/src/client-tuning.ts is
# the width: a re-sent subscribe holds a slot until any frame bearing its id
# arrives, it is unsubscribed, or RESUBSCRIBE_ACK_TIMEOUT passes with no reply.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"

class TestResubscribePacing < Minitest::Test
  SUBSCRIPTIONS = 7

  def subscribes(sent) = sent.select { |frame| frame["type"] == "subscribe" }.map { |frame| frame["id"] }

  def ack(id) = JSON.generate({ "id" => id, "type" => "ack" })

  def new_client = Lunora::Client.new("https://app.example", client_id: "client-test")

  def subscribe_channel(client, index, args = { "channel" => "c#{index}" })
    client.subscribe("messages:list", args, ->(_value) {})
  end

  # A client holding +count+ query subscriptions made on a first socket, attached to +sender+ before any resend.
  def paced_client(count, sender)
    client = new_client
    client.attach_socket(->(_frame) {})
    unsubscribes = Array.new(count) { |index| subscribe_channel(client, index) }
    client.attach_socket(sender)
    [client, unsubscribes]
  end

  # +paced_client+ recording to a list, resent.
  def reconnected(count = SUBSCRIPTIONS)
    sent = []
    client, = paced_client(count, ->(frame) { sent << frame })
    sent.clear
    client.resend_subscriptions
    [client, sent]
  end

  def test_only_the_window_goes_out_until_a_reply_arrives
    assert_equal 3, Lunora::RESUBSCRIBE_CONCURRENCY, "the reference client's width"

    _client, sent = reconnected

    assert_equal Lunora::RESUBSCRIBE_CONCURRENCY, subscribes(sent).size
  end

  def test_any_frame_bearing_the_id_lets_the_next_one_out
    client, sent = reconnected
    window = subscribes(sent)

    client.handle_frame(ack(window[0]))
    assert_equal 4, subscribes(sent).size, "an ack frees its slot"

    client.handle_frame(JSON.generate({ "cursor" => 1, "data" => [], "id" => window[1], "type" => "data" }))
    assert_equal 5, subscribes(sent).size, "a data frame that overtakes the ack frees it too"

    client.handle_frame(JSON.generate({ "error" => { "code" => "FORBIDDEN", "message" => "no" }, "id" => window[2], "type" => "error" }))
    assert_equal 6, subscribes(sent).size, "so does the error that refuses it"

    client.handle_frame(ack(window[0]))
    assert_equal 6, subscribes(sent).size, "a second frame for a released id frees nothing"
  end

  def test_every_subscription_goes_out_exactly_once_in_subscribe_order
    client, sent = reconnected

    answered = 0
    while answered < subscribes(sent).size
      client.handle_frame(ack(subscribes(sent)[answered]))
      answered += 1
    end

    assert_equal (1..SUBSCRIPTIONS).map { |index| "sub_#{index}" }, subscribes(sent)
  end

  def test_an_unsubscribe_skips_a_queued_one_and_frees_an_outstanding_one
    sent = []
    client, unsubscribes = paced_client(5, ->(frame) { sent << frame })
    sent.clear
    client.resend_subscriptions
    outstanding = subscribes(sent)

    unsubscribes[4].call
    assert_equal 3, subscribes(sent).size, "a queued one is dropped and frees no slot"

    unsubscribes[0].call
    assert_equal 4, subscribes(sent).size, "an outstanding one will never be answered, so its slot goes on"
    refute_includes subscribes(sent), "sub_5", "the unsubscribed queued one does not go out"

    client.handle_frame(ack(outstanding[1]))
    assert_equal 4, subscribes(sent).size, "nothing is left to send"
  end

  def test_an_unanswered_one_stops_holding_its_slot_after_the_timeout
    before = Lunora.monotonic_now
    client, sent = reconnected
    after = Lunora.monotonic_now
    deadline = client.next_subscription_retry_at

    refute_nil deadline, "an outstanding re-subscribe reports its deadline"
    assert_operator deadline, :>=, before + Lunora::RESUBSCRIBE_ACK_TIMEOUT
    assert_operator deadline, :<=, after + Lunora::RESUBSCRIBE_ACK_TIMEOUT

    assert_equal 0, client.retry_due_subscriptions(deadline - 0.001), "a slot holds until its deadline"
    assert_equal 3, subscribes(sent).size
    assert_equal Lunora::RESUBSCRIBE_CONCURRENCY, client.retry_due_subscriptions(deadline),
                 "every timed-out slot lets the next one out, and counts it"
    assert_equal 6, subscribes(sent).size
  end

  def test_a_late_retry_dates_the_next_window_from_now
    client, = reconnected
    # A timer armed for an hour-old deadline that only fires now passes that deadline.
    armed_for = Lunora.monotonic_now - 3600
    slots = client.instance_variable_get(:@resubscribe_slots)
    slots.each_key { |id| slots[id] = armed_for }
    before = Lunora.monotonic_now

    assert_equal Lunora::RESUBSCRIBE_CONCURRENCY, client.retry_due_subscriptions(armed_for),
                 "the expired slots let the next window out"
    assert_operator client.next_subscription_retry_at, :>=, before + Lunora::RESUBSCRIBE_ACK_TIMEOUT,
                    "the new window's slots hold for the ack timeout from now"
  end

  def test_a_reconnect_mid_drain_starts_a_fresh_window
    client, sent = reconnected
    client.detach_socket

    assert_nil client.next_subscription_retry_at, "a dropped socket's slots are gone"

    resent = []
    client.attach_socket(->(frame) { resent << frame })
    resent.clear
    client.resend_subscriptions

    assert_equal Lunora::RESUBSCRIBE_CONCURRENCY, subscribes(resent).size, "the new socket gets a fresh window"

    client.handle_frame(ack(subscribes(sent)[0]))
    assert_equal 4, subscribes(resent).size, "a reply on the new socket drains its queue"
  end

  def test_a_queued_one_carries_the_cursor_it_has_when_it_goes_out
    client = new_client
    client.identity = "alice"
    client.attach_socket(->(_frame) {})
    4.times do |index|
      subscribe_channel(client, index)
      client.handle_frame(JSON.generate({ "cursor" => 9, "data" => [], "id" => "sub_#{index + 1}", "type" => "data" }))
    end
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    sent.clear
    client.resend_subscriptions
    client.identity = "bob"
    client.handle_frame(ack("sub_1"))

    late = sent.find { |frame| frame["type"] == "subscribe" && frame["id"] == "sub_4" }

    refute_nil late, "the queued subscription goes out once a slot frees"
    refute late["query"].key?("sinceSeq"), "the new identity must not resume the old one's position"
  end

  def test_a_failed_paced_send_from_a_frame_does_not_raise
    failing = false
    client, = paced_client(4, lambda { |frame|
      raise IOError, "socket write failed" if failing && frame["type"] == "subscribe"
    })
    client.resend_subscriptions
    failing = true

    client.handle_frame(ack("sub_1"))
  end

  def test_a_failed_send_puts_the_unsent_ones_back_in_line
    sent = []
    broken = true
    client, = paced_client(SUBSCRIPTIONS, lambda { |frame|
      if frame["id"] == "sub_2" && broken
        broken = false
        raise IOError, "write failed"
      end
      sent << frame
    })
    sent.clear

    assert_raises(IOError) { client.resend_subscriptions }

    answered = 0
    while answered < subscribes(sent).size
      client.handle_frame(ack(subscribes(sent)[answered]))
      answered += 1
    end

    assert_equal (1..SUBSCRIPTIONS).map { |index| "sub_#{index}" }.sort, subscribes(sent).uniq.sort
  end

  def test_a_failed_unsubscribe_write_still_sends_the_batch_it_freed
    sent = []
    client, unsubscribes = paced_client(5, lambda { |frame|
      raise IOError, "write failed" if frame["type"] == "unsubscribe"

      sent << frame
    })
    sent.clear
    client.resend_subscriptions

    assert_raises(IOError) { unsubscribes[0].call }
    assert_includes subscribes(sent), "sub_4"
  end

  def test_a_retry_across_a_socket_swap_leaves_the_new_queue_alone
    old = []
    fresh = []
    swapped = false
    client = nil
    client, = paced_client(5, lambda { |frame|
      old << frame
      # The socket is replaced while the retry's own frame is being written to the old one.
      if frame["id"] == "sub_5" && !swapped
        swapped = true
        client.detach_socket
        client.attach_socket(->(each) { fresh << each })
        client.resend_subscriptions
      end
    })
    client.resend_subscriptions
    client.handle_frame(JSON.generate({ "error" => { "code" => "OVERLOADED", "message" => "busy", "retryAfterMs" => 0 },
                                        "id" => "sub_5", "type" => "error" }))

    client.retry_due_subscriptions(Lunora.monotonic_now + (2 * Lunora::RESUBSCRIBE_ACK_TIMEOUT))

    assert swapped, "the retry reached the old socket"
    refute_includes subscribes(old), "sub_4", "the new socket's queue must not be drained onto the old one"
    assert_includes subscribes(fresh), "sub_1", "the new socket keeps its own window"
  end

  def test_a_queued_one_whose_args_no_longer_encode_does_not_stall_the_rest
    client = new_client
    client.attach_socket(->(_frame) {})
    args = Array.new(5) { |index| { "channel" => "c#{index}" } }
    args.each_with_index { |each, index| subscribe_channel(client, index, each) }
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    sent.clear
    client.resend_subscriptions

    # The caller mutated a queued subscription's args into something the wire cannot carry.
    args[3]["bad"] = Object.new

    client.handle_frame(ack("sub_1"))

    refute_includes subscribes(sent), "sub_4"
    assert_includes subscribes(sent), "sub_5", "the next queued one still goes out"
  end

  def test_the_callers_resend_raises_for_args_that_no_longer_encode
    client = new_client
    client.attach_socket(->(_frame) {})
    args = Array.new(5) { |index| { "channel" => "c#{index}" } }
    args.each_with_index { |each, index| subscribe_channel(client, index, each) }
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    sent.clear
    args[4]["bad"] = Object.new

    assert_raises(Lunora::WireFormatError) { client.resend_subscriptions }
    assert_empty subscribes(sent), "nothing goes out on a half re-subscribed socket"
  end

  def test_shape_subscriptions_are_not_paced
    client = new_client
    client.attach_socket(->(_frame) {})
    5.times { |index| client.subscribe_shape("roomMessages", { "room" => "r#{index}" }, ->(_rows) {}) }
    sent = []
    client.attach_socket(->(frame) { sent << frame })
    sent.clear
    client.resend_subscriptions

    assert_equal(5, sent.count { |frame| frame["type"] == "shape_subscribe" })
  end
end
