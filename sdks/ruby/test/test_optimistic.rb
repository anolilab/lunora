# frozen_string_literal: true

# The cursor-gated optimistic-layer engine, against the shared golden scenarios
# in protocol/fixtures/offline-optimistic.json. Every expectation is read from
# that file so this port and the other six assert the same values rather than
# each documenting its own behaviour.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

module OptimisticFixtures
  include FixtureLoader

  SUBSCRIPTION_ID = "sub_1"
  QUERY = "messages:list"

  def optimistic_case(name) = scenario("optimistic", name)

  # The one transform primitive the fixtures use: push onto a COPY of the list.
  #
  # A copy, not an in-place push: a transform is re-run on every rebase, so one
  # that mutated its input would compound its own effect on each server frame.
  def appender(item) = ->(current) { (current || []) + [item] }

  def build_state(base, seen = nil)
    Lunora::Optimistic::State.build(base, seen.nil? ? [] : [->(value) { seen << value }])
  end

  # A client with one live subscription primed to +base+, plus the list every
  # value delivered to that subscription lands in.
  #
  # The frames below go through +Client#handle_frame+ — the PRODUCTION path. The
  # suite used to drive a hand-copied transcription of its `data` branch instead,
  # which is why a `handleFrame` that forgot to advance the cursor, or to drop
  # confirmed layers, would have kept all nine conformance names green.
  def primed_client(base, cursor: 1, responses: nil)
    seen = []
    poster = responses.nil? ? nil : ->(_url, _headers, _body) { [200, responses] }
    client = Lunora::Client.new("https://app.example", http_post: poster)

    client.attach_socket(->(_frame) {})
    client.subscribe(QUERY, {}, ->(value) { seen << value })
    deliver(client, { "cursor" => cursor, "data" => base })

    [client, seen]
  end

  def deliver(client, frame, kind: "data")
    client.handle_frame(JSON.generate(frame.merge("id" => SUBSCRIPTION_ID, "type" => kind)))
  end

  # The subscription's tracked cursor and live layer count. Read through the
  # registry because neither is public API — and neither should be; they are
  # internal state the fixture pins so a rebase cannot quietly stop rebasing.
  def tracked(client)
    client.instance_variable_get(:@subscriptions).fetch(SUBSCRIPTION_ID)
  end
end

class TestOptimisticRebase < Minitest::Test
  include OptimisticFixtures

  def test_layer_rebases_onto_a_later_server_frame
    ConformanceManifest.covers("optimistic_layer_rebases_onto_server_frame")
    case_data = optimistic_case("rebase")
    client, seen = primed_client(case_data["base"])
    # Offline, so the write QUEUES and its overlay stays pending across the frame.
    client.detach_socket

    client.submit(QUERY, {}, optimistic: appender(case_data["appended"]))

    assert_equal case_data["displayedAfterApply"], seen.last

    deliver(client, case_data["frame"])

    # The overlay survived the frame and was RE-FOLDED onto the new base, rather
    # than being clobbered by it.
    assert_equal case_data["displayedAfterFrame"], seen.last
    assert_equal case_data["layersAfterFrame"], tracked(client)[:state].layers.length
  end

  # `cursor` is OPTIONAL on a data frame, and one that omits it must leave the
  # tracked cursor where it was: the cursor is what a later commitCursor is
  # compared against, so nulling it strands every pending layer and the write
  # renders twice until some later cursored frame happens to land.
  def test_a_cursorless_frame_leaves_the_tracked_cursor_alone
    ConformanceManifest.covers("optimistic_cursorless_frame_preserves_cursor")
    case_data = optimistic_case("cursorlessFrame")
    client, seen = primed_client(case_data["base"], responses: { "commitCursor" => case_data["commitCursor"], "result" => nil })
    client.detach_socket

    client.submit(QUERY, {}, optimistic: appender(case_data["appended"]))
    deliver(client, case_data["cursoredFrame"])
    deliver(client, case_data["cursorlessFrame"])

    assert_equal case_data["cursorAfterCursorlessFrame"], tracked(client)[:cursor]
    assert_equal case_data["displayedAfterCursorlessFrame"], seen.last
    assert_equal case_data["layersAfterCursorlessFrame"], tracked(client)[:state].layers.length

    client.attach_socket(->(_frame) {})
    client.flush_offline_queue

    # Only reachable because the cursor survived: confirm compares the write's
    # commit cursor against it.
    assert_equal case_data["layersAfterConfirm"], tracked(client)[:state].layers.length
  end

  def test_a_raising_layer_is_skipped_not_fatal
    ConformanceManifest.covers("optimistic_layer_rebases_onto_server_frame")
    case_data = optimistic_case("throwingLayerSkipped")
    state = build_state(case_data["base"])

    # Registered directly rather than through apply_layer, which refuses a
    # transform that raises on the value it is first handed. This is the other
    # case: a layer that worked once and raises on a later rebase, which the fold
    # must survive.
    state.layers << Lunora::Optimistic::Layer.new(0, ->(_current) { raise "buggy optimistic update" }, nil)

    deferred = []
    Lunora::Optimistic.apply_layer(state, appender(case_data["appended"]), deferred)
    deferred.each(&:call)

    assert_equal case_data["layers"], state.layers.length
    assert_equal case_data["displayed"], Lunora::Optimistic.fold(state.server_base, state.layers)
  end
end

class TestOptimisticCommitCursor < Minitest::Test
  include OptimisticFixtures

  def test_layer_drops_only_once_a_frame_reaches_the_commit_cursor
    ConformanceManifest.covers("optimistic_layer_drops_on_commit_cursor")
    case_data = optimistic_case("commitCursorDrop")
    client, seen = primed_client(case_data["base"], responses: { "commitCursor" => case_data["commitCursor"], "result" => nil })

    client.submit(QUERY, {}, optimistic: appender(case_data["appended"]))
    deliver(client, case_data["belowFrame"])

    # Below the commit cursor: the write is NOT in the server base yet, so
    # dropping the overlay here would blink the value away and back.
    assert_equal case_data["displayedAfterBelowFrame"], seen.last
    assert_equal case_data["layersAfterBelowFrame"], tracked(client)[:state].layers.length

    deliver(client, case_data["atFrame"])

    # The frame reached the commit cursor: the effect is in the base, so the
    # overlay drops without the value ever double-counting it.
    assert_equal case_data["displayedAfterAtFrame"], seen.last
    assert_equal case_data["layersAfterAtFrame"], tracked(client)[:state].layers.length
  end

  def test_layer_drops_on_a_settled_frame_reaching_the_commit_cursor
    ConformanceManifest.covers("optimistic_layer_drops_on_settled_frame")
    case_data = optimistic_case("settledFrameDrop")
    client, seen = primed_client(case_data["base"], responses: { "commitCursor" => case_data["commitCursor"], "result" => nil })

    client.submit(QUERY, {}, optimistic: appender(case_data["appended"]))
    deliver(client, case_data["belowFrame"], kind: "settled")

    assert_equal case_data["displayedAfterBelowFrame"], seen.last
    assert_equal case_data["layersAfterBelowFrame"], tracked(client)[:state].layers.length

    deliver(client, case_data["atFrame"], kind: "settled")

    # A byte-identical write yields a settled frame, never a data frame. Sweeping
    # only on data frames leaves the prediction on screen until some unrelated
    # write happens to change this query.
    assert_equal case_data["displayedAfterAtFrame"], seen.last
    assert_equal case_data["layersAfterAtFrame"], tracked(client)[:state].layers.length
  end

  def test_confirm_without_a_cursor_drops_without_reverting
    ConformanceManifest.covers("optimistic_layer_drops_on_commit_cursor")
    case_data = optimistic_case("confirmWithoutCursor")
    state = build_state(case_data["base"])

    deferred = []
    handle = Lunora::Optimistic.apply_layer(state, appender(case_data["appended"]), deferred)
    handle.confirm(nil, deferred)
    deferred.each(&:call)

    # CDC is off on this shard, so there is no cursor to gate on. The layer goes,
    # but the display does not revert: the write DID commit.
    assert_equal case_data["displayedAfterConfirm"], state.last_value
    assert_equal case_data["layersAfterConfirm"], state.layers.length
  end

  def test_a_confirmed_cursor_already_passed_drops_immediately
    ConformanceManifest.covers("optimistic_layer_drops_on_commit_cursor")
    case_data = optimistic_case("commitCursorDrop")
    state = build_state(case_data["atFrame"]["data"])
    state.server_cursor = case_data["atFrame"]["cursor"]

    deferred = []
    handle = Lunora::Optimistic.apply_layer(state, appender("x"), deferred)
    handle.confirm(case_data["commitCursor"], deferred)
    deferred.each(&:call)

    # The confirming frame beat the RPC response — the common race. The overlay
    # must drop on confirm rather than linger until the next frame.
    assert_empty state.layers
    assert_equal case_data["atFrame"]["data"], state.last_value
  end
end

class TestOptimisticRollback < Minitest::Test
  include OptimisticFixtures

  def test_rollback_restores_the_server_value
    ConformanceManifest.covers("optimistic_layer_rolls_back_on_failure")
    case_data = optimistic_case("rollback")
    seen = []
    state = build_state(case_data["base"], seen)

    deferred = []
    handle = Lunora::Optimistic.apply_layer(state, appender(case_data["appended"]), deferred)
    handle.rollback(deferred)
    deferred.each(&:call)

    assert_equal case_data["displayedAfterRollback"], state.last_value
    assert_equal case_data["layersAfterRollback"], state.layers.length
    assert_equal case_data["displayedAfterRollback"], seen.last
  end

  def test_a_constant_layer_masks_concurrent_server_changes
    ConformanceManifest.covers("optimistic_layer_rolls_back_on_failure")
    case_data = optimistic_case("constantMask")
    client, seen = primed_client(case_data["base"])
    client.detach_socket
    read_back = nil
    read_back_all = nil

    client.submit("messages:send", {}, optimistic_update: lambda { |store, _args|
      store.set_query(QUERY, {}, case_data["value"])
      # Reflects the override already written in this batch, before anything is
      # installed on the subscription — through BOTH readers, or a multi-step
      # update that patches every variant of a list and then reads it back
      # composes onto the value it just replaced.
      read_back = store.get_query(QUERY, {})
      read_back_all = store.get_all_queries(QUERY).map(&:last)
    })

    assert_equal case_data["displayedAfterApply"], seen.last
    assert_equal case_data["displayedAfterApply"], read_back
    assert_equal [case_data["displayedAfterApply"]], read_back_all

    deliver(client, case_data["frame"])

    # An absolute override: while pending it re-clamps and HIDES the concurrent
    # server change rather than merging with it.
    assert_equal case_data["displayedAfterFrame"], seen.last

    # Closing rejects the still-queued write, which unwinds its layers.
    client.close

    assert_equal case_data["displayedAfterRollback"], seen.last
  end
end
