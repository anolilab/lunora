# frozen_string_literal: true

# The cursor-gated optimistic-layer engine, against the shared golden scenarios
# in protocol/fixtures/offline-optimistic.json. Every expectation is read from
# that file so this port and the other six assert the same values rather than
# each documenting its own behaviour.

require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

module OptimisticFixtures
  include FixtureLoader

  def scenario(name)
    fixture("offline-optimistic.json").fetch("optimistic").fetch(name)
  end

  # The one transform primitive the fixtures use: push onto a COPY of the list.
  #
  # A copy, not an in-place push: a transform is re-run on every rebase, so one
  # that mutated its input would compound its own effect on each server frame.
  def appender(item) = ->(current) { (current || []) + [item] }

  def build_state(base, seen = nil)
    Lunora::Optimistic::State.build(base, seen.nil? ? [] : [->(value) { seen << value }])
  end

  # Apply one server data frame the way Client#deliver does.
  def apply_frame(state, frame, deferred)
    state.server_base = frame["data"]
    state.server_cursor = frame["cursor"]
    Lunora::Optimistic.drop_confirmed?(state, state.server_cursor)
    Lunora::Optimistic.notify(state, Lunora::Optimistic.fold(state.server_base, state.layers), deferred)
  end
end

class TestOptimisticRebase < Minitest::Test
  include OptimisticFixtures

  def test_layer_rebases_onto_a_later_server_frame
    ConformanceManifest.covers("optimistic_layer_rebases_onto_server_frame")
    case_data = scenario("rebase")
    seen = []
    state = build_state(case_data["base"], seen)

    deferred = []
    Lunora::Optimistic.apply_layer(state, appender(case_data["appended"]), deferred)
    deferred.each(&:call)

    assert_equal case_data["displayedAfterApply"], state.last_value
    assert_equal [case_data["displayedAfterApply"]], seen

    deferred = []
    apply_frame(state, case_data["frame"], deferred)
    deferred.each(&:call)

    # The overlay survived the frame and was RE-FOLDED onto the new base, rather
    # than being clobbered by it.
    assert_equal case_data["displayedAfterFrame"], state.last_value
    assert_equal case_data["layersAfterFrame"], state.layers.length
    assert_equal case_data["displayedAfterFrame"], seen.last
  end

  def test_a_raising_layer_is_skipped_not_fatal
    ConformanceManifest.covers("optimistic_layer_rebases_onto_server_frame")
    case_data = scenario("throwingLayerSkipped")
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
    case_data = scenario("commitCursorDrop")
    state = build_state(case_data["base"])

    deferred = []
    handle = Lunora::Optimistic.apply_layer(state, appender(case_data["appended"]), deferred)
    handle.confirm(case_data["commitCursor"], deferred)
    deferred.each(&:call)

    deferred = []
    apply_frame(state, case_data["belowFrame"], deferred)
    deferred.each(&:call)

    # Below the commit cursor: the write is NOT in the server base yet, so
    # dropping the overlay here would blink the value away and back.
    assert_equal case_data["displayedAfterBelowFrame"], state.last_value
    assert_equal case_data["layersAfterBelowFrame"], state.layers.length

    deferred = []
    apply_frame(state, case_data["atFrame"], deferred)
    deferred.each(&:call)

    # The frame reached the commit cursor: the effect is in the base, so the
    # overlay drops without the value ever double-counting it.
    assert_equal case_data["displayedAfterAtFrame"], state.last_value
    assert_equal case_data["layersAfterAtFrame"], state.layers.length
  end

  def test_confirm_without_a_cursor_drops_without_reverting
    ConformanceManifest.covers("optimistic_layer_drops_on_commit_cursor")
    case_data = scenario("confirmWithoutCursor")
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
    case_data = scenario("commitCursorDrop")
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
    case_data = scenario("rollback")
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
    case_data = scenario("constantMask")
    state = build_state(case_data["base"])
    deferred = []
    store = Lunora::Optimistic::LocalStore.new(
      ->(_path, _args) { [state] },
      ->(_path) { [[{}, state.last_value]] },
      deferred
    )

    store.set_query("messages:list", {}, case_data["value"])
    deferred.each(&:call)

    assert_equal case_data["displayedAfterApply"], state.last_value
    assert_equal case_data["displayedAfterApply"], store.get_query("messages:list", {})

    deferred = []
    apply_frame(state, case_data["frame"], deferred)
    deferred.each(&:call)

    # An absolute override: while pending it re-clamps and HIDES the concurrent
    # server change rather than merging with it.
    assert_equal case_data["displayedAfterFrame"], state.last_value

    deferred = []
    Lunora::Optimistic.rollback_all(store.rollbacks, deferred)
    deferred.each(&:call)

    assert_equal case_data["displayedAfterRollback"], state.last_value
  end
end
