# frozen_string_literal: true

module Lunora
  # The cursor-gated, rebaseable optimistic-update engine — a port of
  # packages/client/src/optimistic-layers.ts.
  #
  # An optimistic transform is recorded as a LAYER on its subscription rather
  # than written once and forgotten, so the displayed value is always
  # +server_base+ folded through the active layers. Two things follow, and both
  # are the reason for the design:
  #
  # 1. An incoming server frame re-folds the still-pending layers onto the new
  #    authoritative base ("rebasing") instead of clobbering them, so a queued
  #    offline write's predicted value survives an unrelated delta on the query.
  # 2. A layer is dropped the moment a frame whose +cursor+ has reached the
  #    write's committed +commit_cursor+ arrives (its effect is now in the base),
  #    so the confirming frame cannot double-count it. The drop is keyed on the
  #    SERVER-confirmed cursor, never on RPC-response timing, which races the
  #    socket broadcast.
  #
  # Both optimistic APIs route through this one engine: the single-query per-call
  # transform registers a TRANSFORM layer (re-derived from the new base on every
  # delta — true rebasing), and the multi-query local store registers a CONSTANT
  # layer per +set_query+. They compose on a shared subscription by fold order,
  # and a constant layer MASKS rather than merges — while pending it re-clamps to
  # its predicted value and hides a concurrent server change to that query, which
  # is the intended absolute-override semantics.
  #
  # Callbacks are never invoked from here. Every method that would notify appends
  # a lambda to a +deferred+ array instead, because this state is mutated under
  # the client's Mutex and running a consumer's handler inside that critical
  # section is how the read loop deadlocks against a handler that subscribes —
  # +Mutex+ is not reentrant. The caller drains +deferred+ once it has unlocked,
  # the same discipline +handle_frame+ already uses.
  #
  # Divergence from @lunora/client: the TypeScript engine suppresses a
  # notification whose folded result is identical to the value already displayed.
  # Reference identity has no portable meaning across the seven ports, so they
  # notify on every fold instead — a consumer sees at most a few redundant
  # callbacks carrying the same value, never a missing one.
  module Optimistic
    # One active optimistic transform layered onto a subscription.
    #
    # +commit_cursor+ is the CDC cursor the write committed at, from the
    # mutation's response. It stays nil while the write is queued or in flight,
    # which is what keeps the overlay alive across unrelated deltas until it is
    # confirmed.
    Layer = Struct.new(:id, :transform, :commit_cursor)

    # The layered value a subscription displays.
    #
    # +server_base+ is the authoritative value with NO overlay; it tracks
    # +last_value+ exactly while no layer is active and diverges only while an
    # optimistic write is pending. +last_value+ is the DISPLAYED value:
    # +server_base+ folded through +layers+.
    State = Struct.new(:server_base, :server_cursor, :last_value, :layers, :callbacks) do
      def self.build(base = nil, callbacks = [])
        new(base, nil, base, [], callbacks)
      end
    end

    @next_layer_id = 0
    @id_mutex = Mutex.new

    class << self
      # A process-unique layer id. Removal compares by id rather than by object,
      # so two layers holding the same lambda stay distinguishable.
      def next_layer_id
        @id_mutex.synchronize { @next_layer_id += 1 }
      end

      # Fold +base+ through +layers+ in order, returning the displayed value.
      #
      # A layer whose transform raises is SKIPPED rather than aborting the fold:
      # one buggy optimistic update must not blank the whole query for every
      # other layer. The mutation that registered it surfaces the failure itself.
      def fold(base, layers)
        layers.reduce(base) { |value, layer| apply_or_skip(layer, value) }
      end

      # Runs one layer's transform, returning its input unchanged if it raised.
      def apply_or_skip(layer, value)
        layer.transform.call(value)
      rescue StandardError
        value
      end

      # Set the displayed value and queue the subscription's handlers.
      def notify(state, value, deferred)
        state.last_value = value

        state.callbacks.each do |callback|
          deferred << lambda {
            begin
              callback.call(value)
            rescue StandardError
              # A consumer's handler raising is not this client's failure, and
              # must not stop the remaining handlers from being told.
              nil
            end
          }
        end
      end

      # Layer one transform onto +state+, returning its settle Handle — or nil,
      # leaving the state untouched, when the transform raises on the value it is
      # first handed: there is nothing to display and nothing to settle.
      def apply_layer(state, transform, deferred)
        # Same input as the reference client: the current DISPLAYED value, i.e.
        # server_base already folded through any prior layers.
        predicted = predict(transform, state.last_value)

        return nil if predicted == NO_PREDICTION

        layer = Layer.new(next_layer_id, transform, nil)
        state.layers << layer
        notify(state, predicted, deferred)

        Handle.new(state, layer)
      end

      # The sentinel a transform that raised on first application yields. A plain
      # nil cannot serve: nil is a value a transform may legitimately predict.
      NO_PREDICTION = Object.new

      # The predicted value, or NO_PREDICTION when the transform raised.
      def predict(transform, current)
        transform.call(current)
      rescue StandardError
        NO_PREDICTION
      end

      # Drop every layer whose write has committed at or before +cursor+,
      # reporting whether anything was removed.
      #
      # Called on each data/delta frame: a layer confirmed at a cursor the frame
      # has reached is now reflected in +server_base+, so keeping it would
      # double-count. Layers with no commit cursor yet (still queued or in
      # flight) are kept, so their overlay survives the frame.
      def drop_confirmed?(state, cursor)
        return false if cursor.nil? || state.layers.empty?

        before = state.layers.length
        state.layers = state.layers.reject { |layer| !layer.commit_cursor.nil? && layer.commit_cursor <= cursor }

        state.layers.length != before
      end

      # Confirm every layer a write registered, against its committed cursor.
      def confirm_all(confirms, commit_cursor, deferred)
        confirms.each { |confirm| confirm.call(commit_cursor, deferred) }
      end

      # Unwind a write's layers, most-recent-first.
      #
      # LIFO, not FIFO: layers compose by fold order, so removing an earlier one
      # first would re-fold the later ones onto a base they never saw.
      def rollback_all(rollbacks, deferred)
        rollbacks.reverse_each { |rollback| rollback.call(deferred) }
      end
    end

    # Settles one layer: +confirm+ on success, +rollback+ on failure.
    class Handle
      def initialize(state, layer)
        @state = state
        @layer = layer
      end

      # Gate the layer's removal on the server-confirmed cursor.
      #
      # A nil cursor (CDC off on this shard, so nothing was echoed) drops the
      # layer immediately but does NOT re-fold: +confirm+ runs on SUCCESS, so the
      # displayed value reflects a write that just committed, and re-folding here
      # would visibly revert it to the pre-write base until the authoritative
      # frame supersedes it. +rollback+ is the path that re-folds.
      def confirm(commit_cursor, deferred)
        if commit_cursor.nil?
          remove?
          return
        end

        @layer.commit_cursor = commit_cursor

        # A confirming (or later) frame already advanced past the commit cursor,
        # so the write is in server_base — drop the overlay now rather than
        # leaving it until the next frame.
        return if @state.server_cursor.nil? || @state.server_cursor < commit_cursor

        refold(deferred) if remove?
      end

      # Remove the layer and re-fold, so the bad value disappears.
      def rollback(deferred)
        refold(deferred) if remove?
      end

      private

      def remove?
        index = @state.layers.index { |entry| entry.id == @layer.id }
        return false if index.nil?

        @state.layers.delete_at(index)
        true
      end

      def refold(deferred)
        Optimistic.notify(@state, Optimistic.fold(@state.server_base, @state.layers), deferred)
      end
    end

    # A read/write handle over the client's live query cache, handed to a write's
    # +optimistic_update+ so ONE mutation can patch MANY subscribed queries.
    #
    # Each +set_query+ registers a constant layer through the same engine the
    # single-query path uses, so the whole batch rebases onto incoming deltas and
    # settles together — confirmed on the mutation's commit cursor, or rolled
    # back on failure.
    class LocalStore
      # The settle closures every +set_query+ produced, in application order, for
      # the caller to run when the mutation settles.
      attr_reader :confirms, :rollbacks

      def initialize(find, matching, deferred)
        @find = find
        @matching = matching
        @deferred = deferred
        @confirms = []
        @rollbacks = []
      end

      # The current cached value for a subscribed query, or nil when nothing is
      # subscribed for it. Reflects any override already written in this batch.
      def get_query(function_path, args = nil)
        @find.call(function_path, args).first&.last_value
      end

      # Every loaded subscription on +function_path+ as [args, value] pairs — for
      # a write that must patch every variant of a list query without enumerating
      # their args up front.
      def get_all_queries(function_path)
        @matching.call(function_path)
      end

      # Write an optimistic override for a subscribed query. A no-op when nothing
      # is subscribed for it: you only patch queries the consumer is watching.
      def set_query(function_path, args, value)
        @find.call(function_path, args).each do |state|
          handle = Optimistic.apply_layer(state, ->(_current) { value }, @deferred)
          next if handle.nil?

          @confirms << handle.method(:confirm)
          @rollbacks << handle.method(:rollback)
        end
      end
    end
  end
end
