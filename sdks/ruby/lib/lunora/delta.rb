# frozen_string_literal: true

# Row-delta merge (protocol/README.md 5.1.1 and 5.4): a +delta+ frame on a live
# list query carries one row change, +{ key, op, table, row }+, to splice into
# the server base. Insert placement is normative: the delta carries no index, so
# every client must pick the same position the server replayed.
module Lunora
  # Returned by +resolve_data_payload+ for a row change that cannot be merged
  # into the cached base. A sentinel rather than nil, which is a legal value.
  UNMERGEABLE_DELTA = Object.new.freeze

  module Delta
    ID_FIELD = "_id"
    CREATION_FIELD = "_creationTime"
    PAGE_FIELD = "page"
    # Announced on connect; the server sends row deltas only to a client that does.
    PAGE_DELTA_CAPABILITY = "pageDelta"
    OPS = %w[insert update delete].freeze

    module_function

    def mutation_delta?(value)
      value.is_a?(Hash) && value["key"].is_a?(String) && value["table"].is_a?(String) && OPS.include?(value["op"])
    end

    # A bare array, or a +{ "page" => [...] }+ result. Otherwise nil.
    def row_list_of(value)
      return value if value.is_a?(Array)

      value[PAGE_FIELD] if value.is_a?(Hash) && value[PAGE_FIELD].is_a?(Array)
    end

    def numeric?(value)
      value.is_a?(Numeric) && value.respond_to?(:finite?) && value.finite?
    end

    # Newest-first when the first strictly-ordered numeric adjacent pair
    # descends; ascending when indeterminate.
    def descending?(list)
      previous = nil

      list.each do |row|
        current = row[CREATION_FIELD]
        next unless numeric?(current)

        unless previous.nil?
          return true if current < previous
          return false if current > previous
        end

        previous = current
      end

      false
    end

    def insertion_index_for(list, row)
      creation = row[CREATION_FIELD]
      return list.length unless numeric?(creation)

      descending = descending?(list)
      index = list.index do |existing_row|
        existing = existing_row[CREATION_FIELD]
        numeric?(existing) && (descending ? existing < creation : existing > creation)
      end

      index || list.length
    end

    # A new array, or nil when the list is not id-keyable or an insert/update
    # carries no row.
    def merge_rows(list, delta)
      key = delta["key"]
      op = delta["op"]
      return nil unless list.all? { |element| element.is_a?(Hash) && element[ID_FIELD].is_a?(String) }

      return list.reject { |element| element[ID_FIELD] == key } if op == "delete"

      row = delta["row"]
      return nil unless row.is_a?(Hash)

      existing = list.index { |element| element[ID_FIELD] == key }
      merged = list.dup

      if existing.nil?
        merged.insert(insertion_index_for(merged, row), row)
      else
        merged[existing] = row
      end

      merged
    end

    # The merged value, or nil when +delta+ cannot be applied to +current+. A
    # paginated result keeps every field outside +page+; a bare array stays one.
    def apply_delta(current, delta)
      list = row_list_of(current)
      return nil if list.nil?

      merged = merge_rows(list, delta)
      return merged if merged.nil? || current.is_a?(Array)

      current.merge(PAGE_FIELD => merged)
    end

    # What a frame's decoded payload becomes. +is_data+ frames replace the base.
    # A row change with no cached base is the legacy broadcast and passes
    # through; with a base it merges, or is UNMERGEABLE_DELTA when it cannot.
    def resolve_data_payload(value, is_data, server_base)
      return value if is_data || !mutation_delta?(value)
      return value if server_base.nil?

      apply_delta(server_base, value) || UNMERGEABLE_DELTA
    end
  end
end
