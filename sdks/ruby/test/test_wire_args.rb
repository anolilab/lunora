# frozen_string_literal: true

# +Lunora.wire_args+ decides which nils reach the wire, and the two halves it has
# to separate are opposites: an unset +v.optional+ must be an ABSENT key, because
# the validator rejects an explicit null, while a required +v.nullable+ must be a
# PRESENT null, because the validator requires the key. quicktype declares both
# +Types::X.optional+, so the schema-derived path list is the only thing telling
# them apart — and dropping every nil, which this port did before, made a
# nullable argument impossible to send.
#
# Not a manifest case: this is how a GENERATED MODEL reaches the wire, which is
# each port's own business, not a frame every SDK must agree on.

require "minitest/autorun"

require_relative "../lib/lunora"

# Stands in for a generated model: +to_dynamic+ is all +wire_args+ uses.
class FakeModel
  def initialize(dynamic)
    @dynamic = dynamic
  end

  def to_dynamic
    @dynamic
  end
end

class TestWireArgs < Minitest::Test
  def test_drops_an_unset_optional_and_keeps_a_required_null
    model = FakeModel.new({ "id" => "r1", "limit" => nil, "nickname" => nil })

    assert_equal({ "id" => "r1", "nickname" => nil }, Lunora.wire_args(model, [["limit"]]))
  end

  def test_keeps_every_nil_when_no_path_is_given
    # The shape a function with no optional arguments generates.
    model = FakeModel.new({ "id" => "r1", "nickname" => nil })

    assert_equal({ "id" => "r1", "nickname" => nil }, Lunora.wire_args(model, []))
  end

  def test_matches_whole_paths_rather_than_a_key_anywhere
    model = FakeModel.new({ "limit" => nil, "outer" => { "limit" => nil } })

    assert_equal({ "outer" => { "limit" => nil } }, Lunora.wire_args(model, [["limit"]]))
  end

  def test_prunes_at_a_nested_path
    model = FakeModel.new({ "outer" => { "keep" => nil, "limit" => nil } })

    assert_equal({ "outer" => { "keep" => nil } }, Lunora.wire_args(model, [%w[outer limit]]))
  end

  def test_keeps_a_deliberate_nil_inside_a_record
    # A record's values are not properties and no path names them, so a blanket
    # prune — which is what this used to be — silently dropped the caller's key.
    model = FakeModel.new({ "tags" => { "a" => nil, "b" => "x" } })

    assert_equal({ "tags" => { "a" => nil, "b" => "x" } }, Lunora.wire_args(model, [["limit"]]))
  end

  def test_prunes_inside_array_elements_through_a_star
    model = FakeModel.new({ "rows" => [{ "note" => nil, "tag" => nil }, { "note" => "n", "tag" => nil }] })

    assert_equal({ "rows" => [{ "note" => nil }, { "note" => "n" }] }, Lunora.wire_args(model, [%w[rows * tag]]))
  end

  def test_never_drops_an_array_element
    # Removing one would shift every later element.
    model = FakeModel.new({ "rows" => [nil, "a", nil] })

    assert_equal({ "rows" => [nil, "a", nil] }, Lunora.wire_args(model, [%w[rows *]]))
  end
end
