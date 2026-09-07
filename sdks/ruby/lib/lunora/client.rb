# frozen_string_literal: true

require "json"
require "uri"

require_relative "key"
require_relative "offline"
require_relative "optimistic"
require_relative "wire"

module Lunora
  RPC_PATH = "/_lunora/rpc"
  # Where a flush of two or more queued writes goes: one hop carrying
  # independent calls.
  RPC_BATCH_PATH = "/_lunora/rpc-batch"
  WS_PATH = "/_lunora/ws"

  # Hard cap on entries in one batch, matching the server's own
  # (+shared/batch-wire.ts+). A Durable Object is single-threaded and replays a
  # batch's entries sequentially, so an unbounded one could pin a shard for tens
  # of thousands of dispatches. A flush with a larger backlog chunks itself.
  MAX_BATCH_ENTRIES = 500

  # Byte budget for one batch body, under the worker's own 1 MiB body cap
  # (+packages/runtime/src/body-readers.ts+). The entry cap alone is blind to
  # size: 500 writes carrying bytes or long text exceed a megabyte, the worker
  # answers 413 PAYLOAD_TOO_LARGE, and a whole-batch coded envelope is terminal
  # for every entry — so a count-only chunker settles 500 durable writes rejected
  # that would each have committed alone. The 64 KiB of headroom covers the
  # request line, the headers and the JSON framing this estimate does not weigh.
  MAX_BATCH_BYTES = 1_048_576 - 65_536

  # The worker's answer to a body over its cap. Coded, so it arrives as a
  # whole-batch envelope — which every other coded envelope is a verdict on every
  # entry, and this one is not.
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"

  # Ceiling on a delay this client will actually sit out, matching the browser
  # client's own clamp. A server (or a proxy inventing one) that names an hour
  # would otherwise strand a durable queue for an hour, with no way for the
  # consumer to tell a deliberate backoff from a stuck client.
  MAX_RETRY_AFTER_MS = 60_000

  # How many un-applied poke buffers to retain before evicting the oldest. A
  # buffer is only released at its +pokeEnd+; a socket that drops mid-poke never
  # sends one, so without a bound the abandoned buffers accumulate for the life
  # of the client — one per reconnect, and unbounded against a peer that opens
  # pokes it never closes. Concurrent in-flight pokes number in the low single
  # digits, so this is far above any legitimate working set.
  MAX_PENDING_POKES = 64

  # A coded error from an RPC error envelope.
  #
  # +transient+ says the call did not reach a verdict — a 5xx, or a non-2xx
  # carrying no envelope at all (an edge error page, a WAF block, a proxy). It is
  # set where the STATUS is still in scope, because nothing downstream can
  # recover it: +code+ alone cannot tell a BAD_REQUEST the function returned from
  # the INTERNAL this client synthesises for a body that never came from one.
  class ApiError < StandardError
    attr_reader :code, :data, :transient

    def initialize(code, message, data = nil, transient = false)
      super(message)
      @code = code
      @data = data
      @transient = transient
    end
  end

  # A subscription-scoped error the server pushed.
  SubscriptionError = Struct.new(:code, :message)

  # What +Client#submit+ did with a write: :committed (it went out and the server
  # answered) or :queued (the socket was down and it was enqueued for replay).
  #
  # This is the deliberate divergence from @lunora/client, whose +mutation()+
  # returns a promise that stays PENDING until a queued write finally replays. A
  # pending promise is a fine thing to hold in a browser event loop and a bad
  # thing to hold on a Ruby thread, so the ports return the outcome immediately
  # and report the eventual verdict through +on_settled+ (per write) or
  # +Client#on_mutation_settled+ (per client). A caller that must not report
  # success early checks +status+.
  MutationOutcome = Struct.new(:status, :mutation_id, :value, :commit_cursor, keyword_init: true) do
    def queued? = status == :queued
  end

  # The terminal verdict on a queued write, once it replays.
  #
  # +had_awaiter+ is false for a write restored from durable storage: the caller
  # that submitted it is gone, so this event is the ONLY report it produces. It
  # is always read from the entry's +live_awaiter+ rather than restated at the
  # settle site, so the two cannot drift apart.
  MutationSettled = Struct.new(:mutation_id, :status, :value, :error, :had_awaiter, keyword_init: true)

  # Everything +Client#submit+ was asked to do with one write.
  #
  # A struct rather than a parameter list threaded through three private methods:
  # a new option is then one field here instead of three signature edits, and the
  # write path reads the same in every port.
  SubmitOptions = Struct.new(
    :function_path, :args, :shard_key, :mutation_id, :optimistic,
    :optimistic_update, :precondition, :on_settled,
    keyword_init: true
  )

  # What one +Client#flush_offline_queue+ pass achieved: the ids the server
  # accepted, the ids dropped on a verdict/identity change/stale precondition,
  # the ids left queued for the next reconnect, and the subset of the rejected
  # that failed their precondition.
  # +retry_after_ms+ is how long the server asked the caller to wait before
  # flushing again, when a replay came back rate-limited; nil otherwise. The
  # client enforces it too — a flush inside the window is a no-op — so this is
  # for a caller that schedules its own retry.
  FlushReport = Struct.new(:committed, :rejected, :requeued, :conflicted, :retry_after_ms, keyword_init: true) do
    def self.empty = new(committed: [], conflicted: [], rejected: [], requeued: [])
  end

  module_function

  # A clock that only moves forward, for the rate-limit window. Monotonic, so a
  # wall-clock adjustment cannot strand a queue for hours.
  def monotonic_now = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  # Build the POST /_lunora/rpc body. +shard_key+ is omitted when nil OR empty,
  # which routes to the default shard.
  #
  # Empty is omitted rather than sent: the runtime treats an empty string as a
  # valid NAMED shard with its own Durable Object, while this client treats it as
  # the default one (+same_shard?+). Sending it would flush a write on the
  # default shard's socket and then replay it against a different shard from the
  # subscription its optimistic overlay updated.
  def build_rpc_body(function_path, args = nil, shard_key = nil)
    body = { "args" => encode_wire(args.nil? ? {} : args), "functionPath" => function_path }
    key = normalize_shard_key(shard_key)
    body["shardKey"] = key unless key.nil?
    body
  end

  # Return the decoded result, or raise ApiError.
  #
  # +status+ is required — not defaulted — for correctness: protocol/README.md
  # §4.2 says a non-2xx whose body carries no +error+ envelope surfaces as an
  # INTERNAL transport error. Without it a 502 with body {"message":"..."}
  # returns nil and raises nothing — the caller believes its mutation committed.
  def parse_rpc_response(body, status)
    if body.key?("error")
      envelope = body["error"]
      data = envelope["data"].nil? ? nil : decode_wire(envelope["data"])
      # A 5xx is the shard or the edge failing under the call, not a verdict on
      # it, so a queued write replayed under the same idempotency key is still
      # good. See +Client#transient?+.
      raise ApiError.new(envelope.fetch("code", "INTERNAL"), envelope.fetch("message", "request failed"), data,
                         status >= 500)
    end

    # No envelope at all, so this body never came from a Lunora function: an edge
    # error page, a WAF block, a proxy. Nothing reached the shard, which makes it
    # transport rather than a verdict — the batch path already classified the
    # identical response that way, and a lone queued write must not be dropped
    # for being alone.
    raise ApiError.new("INTERNAL", "HTTP #{status} without an error envelope", nil, true) unless (200..299).cover?(status)

    decode_wire(body["result"])
  end

  # The CDC cursor a write committed at, echoed on a mutation's response.
  #
  # nil when the call was a read, or when the shard has CDC off — the degraded
  # case the optimistic engine falls back to one-shot behaviour for.
  def parse_commit_cursor(body)
    cursor = body["commitCursor"]
    cursor.is_a?(Integer) ? cursor : nil
  end

  def build_connect_frame(client_id = nil, context = nil)
    frame = { "id" => "connect", "type" => "connect" }
    frame["clientId"] = client_id unless client_id.nil?
    frame["context"] = context unless context.nil?
    frame
  end

  def build_subscribe_frame(id, function_path, args = nil, table: nil, since_seq: nil, since_epoch: nil)
    query = {
      "args" => encode_wire(args.nil? ? {} : args),
      "functionPath" => function_path,
      "table" => table || function_path
    }
    query["sinceSeq"] = since_seq unless since_seq.nil?
    query["sinceEpoch"] = since_epoch unless since_epoch.nil?
    { "id" => id, "query" => query, "type" => "subscribe" }
  end

  def build_unsubscribe_frame(id) = { "id" => id, "type" => "unsubscribe" }

  def build_shape_subscribe_frame(id, name, args = nil, since_checkpoint: nil, since_epoch: nil)
    shape = { "name" => name }
    shape["args"] = encode_wire(args) unless args.nil?
    frame = { "id" => id, "shape" => shape, "type" => "shape_subscribe" }
    frame["sinceCheckpoint"] = since_checkpoint unless since_checkpoint.nil?
    frame["sinceEpoch"] = since_epoch unless since_epoch.nil?
    frame
  end

  def build_shape_unsubscribe_frame(id) = { "id" => id, "type" => "shape_unsubscribe" }

  # A Lunora deployment client.
  #
  # The HTTP poster and the socket frame sender are injected rather than
  # assumed, so the conformance suite runs with no network and a consumer keeps
  # its own transport, timeouts and socket library instead of inheriting ours.
  #
  # Safe to share across threads. One lock covers the subscription registry, the
  # shape views, the id counters and the socket sender, because the topology
  # every consumer has is a socket read loop on one thread and application code
  # subscribing on others. Frames and user callbacks are dispatched with the
  # lock RELEASED: +Mutex+ is not reentrant, so a callback that subscribes or a
  # sender that unsubscribes on a write failure would otherwise deadlock.
  class Client
    attr_accessor :auth_token

    # An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id,
    # not a bearer token. It is persisted alongside every queued write and
    # re-checked before that write replays, so a restart cannot push one user's
    # queued writes as another. nil means signed out, which is itself an identity
    # a write can be stamped with.
    #
    # Read and written under the same mutex the flush snapshots it under, rather
    # than through +attr_accessor+: a consumer setting it from a sign-in handler
    # while the socket thread is mid-flush is the ordinary case, and the write
    # path binds every queued write to whatever it reads here.
    def identity = @mutex.synchronize { @identity }

    def identity=(value)
      @mutex.synchronize { @identity = value }
    end

    # The durable write queue backing +submit+.
    attr_accessor :offline_queue

    # +client_id+ defaults to a FRESH id per client instance, and must: the shard
    # namespaces an anonymous caller's idempotency rows by it
    # (+anon:<clientId>+), so a per-language constant would put every
    # unauthenticated user of this SDK in one key space — two of them submitting
    # the same caller-supplied +mutation_id+ and the second write silently
    # short-circuits to the first user's cached result.
    #
    # Pin one when the queue is DURABLE: a write replays under the id that issued
    # it, which is persisted with the record, and a stable per-device id is what
    # keeps a restarted client's de-duplication namespace the one it wrote under.
    def initialize(url, http_post: nil, auth_token: nil, client_id: nil, offline_queue: nil, identity: nil)
      @url = url
      @http_post = http_post
      @auth_token = auth_token
      @client_id = client_id || Lunora.random_id
      @offline_queue = offline_queue || OfflineQueue.new
      @identity = identity
      @send = nil
      @subscriptions = {}
      @shapes = {}
      @pokes = {}
      @next_id = 0
      @next_shape_id = 0
      @was_ever_connected = false
      # The monotonic instant before which a flush is a no-op, set when a replay
      # came back rate-limited and the envelope named a delay.
      @flush_not_before = 0.0
      @closed = false
      @settled_listeners = []
      @mutex = Mutex.new
    end

    # Register the sender subscription frames go out on; marks the client online.
    #
    # It also latches "has connected at least once", which is what the write
    # queue gates on: a write made before the FIRST connect fails fast by
    # default, so a misconfigured endpoint surfaces on the first write instead of
    # silently filling a queue that will never flush.
    def attach_socket(sender)
      @mutex.synchronize do
        @send = sender
        @was_ever_connected = true
      end
    end

    # Forget the sender, so subsequent writes queue rather than fail.
    def detach_socket = @mutex.synchronize { @send = nil }

    def online? = @mutex.synchronize { !@send.nil? }

    # How many writes are waiting for the socket.
    def pending_mutation_count = @mutex.synchronize { @offline_queue.size }

    # Observe every queued write's terminal verdict; returns an unsubscribe.
    #
    # This is the ONLY report a write restored from durable storage produces —
    # its original caller did not survive the restart.
    def on_mutation_settled(listener)
      @mutex.synchronize { @settled_listeners << listener }
      -> { @mutex.synchronize { @settled_listeners.delete(listener) } }
    end

    # Reject every queued write so no caller waits on a dead client. Durable
    # storage is untouched: the next session restores those writes.
    def close
      discarded = @mutex.synchronize do
        @closed = true
        @send = nil
        @offline_queue.clear
      end

      report_discarded(discarded)
    end

    def query(function_path, args = nil, shard_key = nil) = rpc(function_path, args, shard_key, nil)

    # Invoke a mutation over HTTP, right now.
    #
    # This is the direct write path and it raises when the deployment is
    # unreachable. For a write that should survive a dropped socket — queued,
    # replayed in order, optionally with an optimistic overlay — use +submit+.
    def mutation(function_path, args = nil, shard_key = nil, mutation_id: nil)
      rpc(function_path, args, shard_key, mutation_id)
    end

    # Same envelope as a mutation, but never an idempotency key: an action
    # performs external side effects and is not replayed against the shard, so
    # claiming mutation-style de-duplication for it would be a lie.
    def action(function_path, args = nil, shard_key = nil) = rpc(function_path, args, shard_key, nil)

    # +shard_key+ does NOT ride the subscribe frame: the protocol selects a
    # shard per SOCKET, via the +?shard=+ parameter +ws_url+ builds. It is
    # accepted so the generated surface is identical across languages, and it is
    # recorded so a write's optimistic overlay can target the right subscription
    # — this client holds one socket, so it must already be the shard that socket
    # was opened against.
    def subscribe(function_path, args, on_data, on_error = nil, shard_key = nil)
      id = nil

      locked_send do
        @next_id += 1
        id = "sub_#{@next_id}"
        @subscriptions[id] = {
          args: args, args_key: Lunora.stable_wire_key(args.nil? ? {} : args), cursor: nil, epoch: nil,
          function_path: function_path, on_data: on_data, on_error: on_error, shard_key: shard_key,
          state: Optimistic::State.build(nil, on_data.nil? ? [] : [on_data])
        }
        Lunora.build_subscribe_frame(id, function_path, args)
      end

      lambda do
        locked_send do
          @subscriptions.delete(id)
          Lunora.build_unsubscribe_frame(id)
        end
      end
    end

    # A live query as an +Enumerator+, for +each+ and everything built on it.
    #
    # Each call opens its OWN subscription — at CALL time, so a frame arriving
    # before the first +next+ is not lost — and tears it down when the enumerator
    # is finished with: +break+ out of an +each+, or call +stop+ on the returned
    # unsubscribe. Returns +[enumerator, unsubscribe]+; use +subscribe+ directly
    # when the value outlives one loop.
    #
    # A subscription error is RAISED into the loop rather than yielded, which is
    # what stops a caller mistaking it for data. Backed by a +Thread::Queue+, so
    # a consumer on one thread and the frame dispatcher on another is the normal
    # case rather than a hazard.
    def stream(function_path, args = nil, shard_key = nil)
      values = Thread::Queue.new
      unsubscribe = subscribe(function_path, args, ->(value) { values << [:value, value] },
                              ->(error) { values << [:error, error] }, shard_key)
      stop = lambda do
        unsubscribe.call
        # Wakes a consumer blocked in `pop` so `each` returns instead of hanging
        # on a subscription nothing will ever push to again.
        values.close
      end

      enumerator = Enumerator.new do |yielder|
        loop do
          kind, payload = values.pop
          break if kind.nil?
          raise ApiError.new(payload.code || "INTERNAL", payload.message) if kind == :error

          yielder << payload
        end
      end

      [enumerator, stop]
    end

    # Open a partially-replicated keyed view. +on_rows+ fires once per applied
    # poke with the view's full contents, in insertion order.
    def subscribe_shape(name, args, on_rows, on_error = nil)
      id = nil

      locked_send do
        @next_shape_id += 1
        id = "shape_#{@next_shape_id}"
        @shapes[id] = { args: args, checkpoint: nil, epoch: nil, name: name, on_error: on_error, on_rows: on_rows,
                        order: [], rows: {} }
        Lunora.build_shape_subscribe_frame(id, name, args)
      end

      lambda do
        locked_send do
          @shapes.delete(id)
          Lunora.build_shape_unsubscribe_frame(id)
        end
      end
    end

    # Re-subscribe everything — queries AND shape views — after a reconnect,
    # carrying each subscription's resume cursor or checkpoint so the server can
    # skip results that have not changed.
    #
    # Without this the cursor/epoch tracked on every +data+ frame would be
    # write-only state and a reconnect would silently re-seed from scratch.
    # The frames are BUILT under the lock, not merely collected: each one carries
    # a +cursor+ the frame handler writes, so snapshotting the entries and
    # reading their cursors afterwards resends a torn frame.
    def resend_subscriptions
      sender = nil

      frames = @mutex.synchronize do
        sender = @send
        next [] if sender.nil?

        queries = @subscriptions.map do |id, entry|
          Lunora.build_subscribe_frame(
            id, entry[:function_path], entry[:args],
            since_seq: entry[:cursor], since_epoch: entry[:epoch]
          )
        end

        # BOTH registries. A resend that walks only the queries leaves every
        # shape view subscribed to a socket that no longer exists — silently, and
        # for the rest of the process's life.
        queries + @shapes.map do |id, entry|
          Lunora.build_shape_subscribe_frame(
            id, entry[:name], entry[:args],
            since_checkpoint: entry[:checkpoint], since_epoch: entry[:epoch]
          )
        end
      end

      frames.each { |frame| sender.call(frame) }
    end

    # Apply one server frame and return its type. Unknown types are ignored,
    # per the protocol's forward-compatibility rule.
    def handle_frame(raw)
      return nil if %w[lunora-ping lunora-pong].include?(raw)

      frame = parse_frame(raw)

      # Non-JSON frames are ignored by the client parser, not fatal.
      return nil if frame.nil?

      deferred = []
      kind = @mutex.synchronize { dispatch(frame, deferred) }
      deferred.each(&:call)
      kind
    end

    # Write, sending it now or queueing it until the socket is back.
    #
    # +optimistic+ is the single-query shortcut: the transform is layered onto
    # the subscription registered under the SAME (function_path, args, shard_key)
    # as this write, mirroring @lunora/client's per-call +optimistic+.
    # +optimistic_update+ is the general form — it receives an
    # +Optimistic::LocalStore+ and may patch any number of subscribed queries.
    # Both settle together, against the same commit cursor.
    #
    # +precondition+ is re-evaluated just before a QUEUED write replays; a false
    # verdict drops it (the row it edited was deleted meanwhile) rather than
    # replaying a write that can only fail.
    #
    # Returns as soon as the write is either committed or durably queued.
    def submit(function_path, args = nil, shard_key: nil, mutation_id: nil, optimistic: nil,
               optimistic_update: nil, precondition: nil, on_settled: nil)
      options = SubmitOptions.new(
        args: args, function_path: function_path, mutation_id: mutation_id || Lunora.random_id,
        on_settled: on_settled, optimistic: optimistic, optimistic_update: optimistic_update,
        precondition: precondition, shard_key: shard_key
      )

      # The consumer's transforms run with the lock RELEASED. Mutex is not
      # reentrant, so one that touches the client it was handed — another submit,
      # +pending_mutation_count+, +identity+ — would otherwise deadlock its own
      # thread.
      planned = plan_optimistic(options)
      deferred = []
      entry = nil

      confirms, rollbacks, evicted = @mutex.synchronize do
        # Checked here rather than on the way in, so a close cannot land between
        # the check and the enqueue and strand the write in a queue that was just
        # emptied.
        raise OfflineError.new(CLIENT_CLOSED, "client is closed") if @closed

        handles = Optimistic.install(planned, deferred)
        confirmers = handles.map { |handle| handle.method(:confirm) }
        rollbackers = handles.map { |handle| handle.method(:rollback) }

        # ONE critical section for the offline decision AND the enqueue: a socket
        # that attaches between the two carries its flush past this write, which
        # then sits in a queue nothing will drain until the next disconnect —
        # after +submit+ has already answered "queued".
        next [confirmers, rollbackers, []] unless @send.nil? && (@was_ever_connected || @offline_queue.queue_before_first_connect)

        entry = queued_write(options, confirmers, rollbackers)
        [confirmers, rollbackers, @offline_queue.enqueue(entry)]
      end

      deferred.each(&:call)
      report_discarded(evicted)

      return MutationOutcome.new(mutation_id: options.mutation_id, status: :queued) unless entry.nil?

      begin
        value, commit_cursor = rpc_full(options.function_path, options.args, options.shard_key, options.mutation_id)
      rescue StandardError
        settle_layers([], rollbacks, nil)
        raise
      end

      # Confirmed against the write's COMMITTED cursor, so the overlay drops when
      # (or once) a frame at that cursor lands — never on this call's return,
      # which races the socket broadcast.
      settle_layers(confirms, [], commit_cursor)

      MutationOutcome.new(commit_cursor: commit_cursor, mutation_id: options.mutation_id, status: :committed, value: value)
    end

    # Restore writes persisted in a prior session; returns their shard keys.
    #
    # Open a socket for each returned key and flush it to replay them. A restored
    # write has no live caller, so its verdict arrives only through
    # +on_mutation_settled+ — including one the capacity cap drops here, which is
    # why the eviction is reported rather than left to a per-entry handler a
    # restored record does not have.
    def hydrate_offline_queue
      restored, evicted = @mutex.synchronize { @offline_queue.hydrate }

      report_discarded(evicted)

      restored
    end

    # Replay one shard's queued writes, in order, over HTTP. Call it when that
    # shard's socket comes back.
    #
    # Each write replays under its own idempotency key, so one the server already
    # committed is de-duplicated rather than applied twice. Per write: success
    # confirms its optimistic overlay against the ECHOED commit cursor; a coded
    # verdict is terminal (replaying it would only re-trigger the same failure);
    # a transient failure — a raw transport error, or one of
    # TRANSIENT_ERROR_CODES — stops the flush and re-queues that write and every
    # unreplayed one, in order, for the next attempt.
    #
    # A queued write whose args cannot be wire-encoded is settled terminally
    # first: a codec failure is deterministic, so classifying it as transient
    # would re-queue it on every reconnect forever, never settling its caller,
    # never rolling its overlay back, and — since a requeue goes to the FRONT —
    # blocking every write behind it in the FIFO.
    def flush_offline_queue(shard_key = nil)
      report = FlushReport.empty

      queue, current_identity, remaining = @mutex.synchronize do
        [@offline_queue, @identity, @flush_not_before - Lunora.monotonic_now]
      end

      # A server that answered "not now" gets waited out. Without this the
      # caller's own reconnect loop replays the identical burst immediately and
      # earns the same 429, indefinitely.
      if remaining.positive?
        report.retry_after_ms = (remaining * 1000).to_i + 1
        return report
      end

      conflicted = drain_conflicted(queue)

      @mutex.synchronize { conflicted.each { |discarded| queue.unpersist(discarded.entry.id) } }
      conflicted.each do |discarded|
        report.conflicted << discarded.entry.id
        report.rejected << discarded.entry.id
      end
      report_discarded(conflicted)

      drained = @mutex.synchronize { queue.drain { |item| Lunora.same_shard?(item.shard_key, shard_key) } }
      return report if drained.empty?

      gated = gate_identity(queue, drained, current_identity, report)

      replay(queue, encodable(queue, gated, report), report)
    end

    private

    # Mutate the guarded state, then send the frame the block returns with the
    # lock released. A nil frame sends nothing.
    def locked_send
      frame = nil

      sender = @mutex.synchronize do
        frame = yield
        @send
      end

      sender.call(frame) unless sender.nil? || frame.nil?
    end

    # Runs with the lock held. Anything that calls back into user code is pushed
    # onto +deferred+ for +handle_frame+ to run once it has released the lock.
    def dispatch(frame, deferred)
      kind = frame["type"]
      entry = @subscriptions[frame["id"]]

      case kind
      when "ack" then kind
      when "data", "delta" then deliver(entry, frame, kind, deferred)
      when "resume", "settled" then sweep(entry, frame, kind, deferred)
      when "error" then deliver_error(frame, kind, deferred)
      when "complete"
        @subscriptions.delete(frame["id"])
        kind
      when "pokeStart"
        # Evict oldest-first at the cap. A Hash preserves insertion order, so
        # the first key is the oldest buffer; one that old is no longer going to
        # see its +pokeEnd+.
        @pokes.shift while @pokes.size >= MAX_PENDING_POKES
        @pokes[frame["pokeId"]] = { parts: {}, resets: [] }
        kind
      when "pokePart" then buffer_poke_part(frame)
      when "pokeEnd" then apply_poke(frame, deferred)
      else kind
      end
    end

    def parse_frame(raw)
      JSON.parse(raw)
    rescue JSON::ParserError
      nil
    end

    def deliver(entry, frame, kind, deferred)
      payload = frame.key?("data") && !frame["data"].nil? ? frame["data"] : frame["delta"]

      begin
        value = Lunora.decode_wire(payload)
      rescue WireFormatError => e
        # Delivered to the ONE subscription the frame is addressed to, never
        # raised out of +handle_frame+: the caller is a socket read loop, so a
        # raise here ends it and with it every other subscription on this client
        # — one malformed payload silently killing the whole stream.
        return deliver_error(
          { "error" => { "code" => "INVALID_FRAME", "message" => e.message }, "id" => frame["id"] },
          "error", deferred
        )
      end

      if entry
        advance(entry, frame)
        state = entry[:state]
        state.server_base = value
        state.server_cursor = entry[:cursor] if entry[:cursor].is_a?(Integer)
        # Drop the overlays this frame has caught up with, then RE-FOLD the rest
        # onto the new authoritative base rather than clobbering them: a
        # still-queued write's predicted value has to survive an unrelated delta
        # on the same query.
        Optimistic.drop_confirmed?(state, state.server_cursor)
        Optimistic.notify(state, Optimistic.fold(state.server_base, state.layers), deferred)
      end

      kind
    end

    # A resume/settled frame advances the cursor without a value change — but a
    # write whose result was byte-identical for this query still committed at or
    # under this cursor, so its overlay is confirmed. Sweep here too, not just on
    # data frames, or a no-visible-change write leaves its prediction on screen
    # until some unrelated write happens to produce a data frame — indefinitely
    # on a quiet query. Only re-fold when something was actually dropped.
    def sweep(entry, frame, kind, deferred)
      if entry
        advance(entry, frame)
        state = entry[:state]
        state.server_cursor = entry[:cursor] if entry[:cursor].is_a?(Integer)

        Optimistic.notify(state, Optimistic.fold(state.server_base, state.layers), deferred) if Optimistic.drop_confirmed?(state, state.server_cursor)
      end

      kind
    end

    def deliver_error(frame, kind, deferred)
      envelope = frame["error"] || {}
      message = frame["message"] || envelope["message"] || "subscription error"
      error = SubscriptionError.new(envelope["code"], message)
      id = frame["id"]

      [@subscriptions[id]&.fetch(:on_error, nil), @shapes[id]&.fetch(:on_error, nil)].compact.each do |handler|
        deferred << -> { handler.call(error) }
      end

      kind
    end

    def advance(entry, frame)
      return if entry.nil?

      entry[:cursor] = frame["cursor"] if frame.key?("cursor")
      entry[:epoch] = frame["epoch"] if frame.key?("epoch")
    end

    # Parts buffer until pokeEnd: a poke is defined as an atomic batch, so
    # applying them as they arrive would expose a torn view, and a socket
    # dropping mid-poke would leave it permanently half-applied.
    def buffer_poke_part(frame)
      buffer = @pokes[frame["pokeId"]]
      # A part for an unknown poke is dropped — without its pokeStart there is
      # no batch to join, and guessing would apply a fragment of one.
      if buffer
        shape_id = frame["shapeId"]
        buffer[:parts][shape_id] = (buffer[:parts][shape_id] || []) + (frame["rowsPatch"] || [])
        # A shape gets at most one part per poke, but record the flag sticky
        # (never cleared) so a server that splits a seed across parts still
        # replaces the view rather than merging into it.
        buffer[:resets] << shape_id if frame["reset"] == true
      end
      "pokePart"
    end

    def apply_poke(frame, deferred)
      buffer = @pokes.delete(frame["pokeId"])
      return "pokeEnd" if buffer.nil?

      buffer[:parts].each do |shape_id, operations|
        shape = @shapes[shape_id]
        next if shape.nil?

        # A reset part carries the shape's COMPLETE membership, so it REPLACES
        # the view rather than patching it. Merging one keeps every row that left
        # the shape while this client was away: a (re)seed is inserts-only, so
        # nothing already held can ever be removed by it, and the stale row
        # renders for the life of the client. Nothing else on the wire says so —
        # a retention re-seed keeps the epoch, and most pokes carry no
        # +baseCheckpoint+ either.
        if buffer[:resets].include?(shape_id)
          shape[:rows].clear
          shape[:order].clear
        end

        operations.each { |operation| apply_row_op(shape, operation) }
        shape[:checkpoint] = frame["checkpoint"] if frame.key?("checkpoint")
        shape[:epoch] = frame["epoch"] if frame.key?("epoch")
        handler = shape[:on_rows]
        next if handler.nil?

        # Snapshot under the lock, for the same reason the resend frames are
        # built under it: the callback must see the view THIS poke produced, not
        # whatever a later one leaves behind while it is queued.
        rows = shape[:order].map { |key| shape[:rows][key] }
        deferred << -> { handler.call(rows) }
      end

      "pokeEnd"
    end

    def apply_row_op(shape, operation)
      key = operation["key"]

      if operation["op"] == "delete"
        shape[:order].delete(key) if shape[:rows].delete(key)
        return
      end

      # A value-less upsert is membership-only; it must not blank an existing row.
      return if operation["value"].nil?

      shape[:order] << key unless shape[:rows].key?(key)
      shape[:rows][key] = Lunora.decode_wire(operation["value"])
    end

    def rpc(function_path, args, shard_key, mutation_id)
      rpc_full(function_path, args, shard_key, mutation_id).first
    end

    # One round-trip, returning [result, commit_cursor].
    #
    # The cursor is what gates an optimistic overlay's removal, so it has to
    # survive the call rather than be discarded by +parse_rpc_response+.
    # +client_id+ overrides this session's, so a replayed write namespaces
    # server-side under the id that ISSUED it.
    def rpc_full(function_path, args, shard_key, mutation_id, client_id = nil)
      raise ApiError.new("INTERNAL", "no http_post configured") if @http_post.nil?

      headers = { "content-type" => "application/json" }
      headers["authorization"] = "Bearer #{@auth_token}" if @auth_token

      if mutation_id
        headers["x-lunora-mutation-id"] = mutation_id
        # Rides WITH the idempotency key, never alone. An anonymous caller has no
        # server-minted user id, so the shard namespaces its de-duplication rows
        # by this client id instead; without one every anonymous client shares a
        # single key space and a colliding mutation id suppresses another
        # client's write.
        headers["x-lunora-client-id"] = client_id || @client_id
      end

      status, body = @http_post.call(join_url(RPC_PATH), headers,
                                     JSON.generate(Lunora.build_rpc_body(function_path, args, shard_key)))
      [Lunora.parse_rpc_response(body, status), Lunora.parse_commit_cursor(body)]
    end

    # The socket URL: the origin with its scheme swapped, plus the shard and
    # credential query parameters when present.
    #
    # An empty shard key is omitted, for the reason +build_rpc_body+ gives: to
    # the runtime it names its own shard, to this client it is the default one.
    def ws_url(shard_key = nil, token = nil)
      endpoint = join_url(WS_PATH).sub(%r{\Ahttps://}, "wss://").sub(%r{\Ahttp://}, "ws://")
      params = []
      shard_key = Lunora.normalize_shard_key(shard_key)
      params << "shard=#{URI.encode_www_form_component(shard_key)}" unless shard_key.nil?
      params << "token=#{URI.encode_www_form_component(token)}" unless token.nil?
      return endpoint if params.empty?

      "#{endpoint}#{endpoint.include?("?") ? "&" : "?"}#{params.join("&")}"
    end

    def join_url(path) = "#{@url.sub(%r{/\z}, "")}#{path}"

    # --- Offline-capable writes ------------------------------------------

    # Drop the queued writes whose precondition no longer holds.
    #
    # The predicates are the CONSUMER's, so they are evaluated with the lock
    # RELEASED; only the drain that acts on their verdicts runs under it.
    def drain_conflicted(queue)
      pending = @mutex.synchronize { queue.items }
      failed = pending.select { |item| !item.precondition.nil? && !item.precondition.call }
      return [] if failed.empty?

      @mutex.synchronize { queue.drain_conflict(failed.map(&:id)) }
    end

    # Partition already-drained writes by the identity gate, rejecting the ones
    # stamped under another identity.
    #
    # Gated against ONE identity snapshot: a flush is a single authenticated
    # burst, so every write in it necessarily runs under one identity.
    def gate_identity(queue, drained, current_identity, report)
      drained.select do |item|
        next true if Lunora.identity_allows_replay?(item.identity, current_identity)

        settle_terminal(queue, item, OfflineError.new(OFFLINE_IDENTITY_CHANGED,
                                                      "offline mutation skipped: auth identity changed before replay"), report)
        false
      end
    end

    # Partition already-gated writes into the encodable ones (returned) and
    # settle the rest terminally. Encoding is cheap and the flush is the slow
    # reconnect path, so it is checked BEFORE the replay loop rather than being
    # discovered as an uncoded — and so transient-looking — mid-flush raise.
    def encodable(queue, gated, report)
      gated.select do |item|
        failure = encoding_failure(item)
        next true if failure.nil?

        settle_terminal(queue, item, failure, report)
        false
      end
    end

    # The coded error a write's args settle with, or nil when they encode.
    def encoding_failure(item)
      Lunora.encode_wire(item.args.nil? ? {} : item.args)
      nil
    rescue WireFormatError => e
      OfflineError.new(OFFLINE_WRITE_UNENCODABLE, "offline mutation dropped: its args cannot be wire-encoded (#{e.message})")
    end

    # A lone write rides the single-call path, which is the proven one. Two or
    # more coalesce into batch round trips — the flaky-reconnect win, where N
    # queued writes cost a handful of hops instead of N.
    def replay(queue, sendable, report)
      return replay_sequential(queue, sendable, report) if sendable.length <= 1

      to_requeue = []
      chunks = chunk_batches(sendable)

      chunks.each_with_index do |chunk, chunk_index|
        # Chunks replay sequentially, which is what preserves FIFO across a
        # flush longer than one batch.
        requeue, stop = replay_batched(queue, chunk, report)
        to_requeue.concat(requeue)

        next unless stop

        # A whole-chunk transport failure. Leave every write not yet sent
        # queued, in order, rather than sending on into a connection that just
        # failed.
        chunks[(chunk_index + 1)..].each { |later| to_requeue.concat(later) }
        break
      end

      unless to_requeue.empty?
        @mutex.synchronize { queue.requeue(to_requeue) }
        report.requeued.concat(to_requeue.map(&:id))
      end

      report
    end

    # A batch entry's contribution to the request body, in bytes.
    #
    # The args dominate and are the only part that can be large; the constant
    # covers the entry's fixed keys and the comma joining it to the next one.
    # Encoding twice (here and in +batch_calls+) is deliberate — the flush is the
    # slow path, and carrying the encoded form through the chunker would put a
    # second representation of every queued write in memory.
    def entry_bytes(item)
      JSON.generate(Lunora.encode_wire(item.args.nil? ? {} : item.args)).bytesize +
        item.function_path.to_s.bytesize + item.id.to_s.bytesize + 160
    end

    # Split a flush into batch bodies the worker will accept.
    #
    # By BYTES as well as by count: the worker reads a batch body under a 1 MiB
    # budget and answers 413 PAYLOAD_TOO_LARGE past it, so 500 writes carrying
    # bytes or long text are one request the server refuses whole. A single write
    # over the budget still forms its own chunk — splitting cannot help it, and
    # +replay_batched+ settles it on the answer.
    def chunk_batches(items)
      chunks = []
      current = []
      size = 0

      items.each do |item|
        cost = entry_bytes(item)

        if !current.empty? && (current.length >= MAX_BATCH_ENTRIES || size + cost > MAX_BATCH_BYTES)
          chunks << current
          current = []
          size = 0
        end

        current << item
        size += cost
      end

      chunks << current unless current.empty?

      chunks
    end

    # Replay writes one at a time. FIFO is preserved by the loop itself.
    def replay_sequential(queue, sendable, report)
      sendable.each_with_index do |item, index|
        begin
          value, commit_cursor = rpc_full(item.function_path, item.args, item.shard_key, item.id, item.client_id)
        rescue StandardError => e
          unless transient?(e)
            settle_terminal(queue, item, e, report)
            next
          end

          note_retry_after(report, e)

          # Nothing after this write may go out ahead of it: replaying out of
          # order is how a durable queue corrupts the data it was protecting.
          pending = sendable[index..]
          @mutex.synchronize { queue.requeue(pending) }
          report.requeued.concat(pending.map(&:id))
          return report
        end

        @mutex.synchronize { queue.unpersist(item.id) }
        settle_committed(item, value, commit_cursor)
        report.committed << item.id
      end

      report
    end

    # Replay one chunk over +POST /_lunora/rpc-batch+.
    #
    # The worker forwards the entries to their shard, which dispatches each
    # through its ordinary single-call path — so per-entry +mutationId+
    # idempotency and in-order application are inherited from the proven route
    # rather than re-implemented here.
    #
    # Returns +[requeue, stop]+: the writes to put back, and whether the caller
    # should STOP because the whole chunk failed at the transport level.
    # Re-queuing is the caller's, once and in order, so a write cannot land twice
    # in the queue.
    def replay_batched(queue, items, report)
      body =
        begin
          rpc_batch(batch_calls(items))
        rescue StandardError
          # Transport failure — nothing committed, so retry everything.
          nil
        end

      return [items, true] if body.nil?

      results = body["results"]
      return [settle_batch_slots(queue, items, results, report), false] if results.is_a?(Array)

      # No per-slot results. A coded envelope is a verdict on the WHOLE batch — a
      # bad request, an authorization denial — and therefore terminal for every
      # entry; anything else is transport, and transient. The two exceptions are
      # below: a body the worker refused for SIZE, and a code that says "not now"
      # rather than "no".
      envelope = body["error"]
      return [items, true] unless envelope.is_a?(Hash)

      error = batch_error(envelope, "batch rejected")

      # The body was too big, not wrong — every entry in it would have committed
      # alone. Halve and retry; the estimate the chunker used cannot see the
      # framing the worker actually measured, and only the answer can.
      if error.code == PAYLOAD_TOO_LARGE && items.length > 1
        middle = items.length / 2
        left, stop = replay_batched(queue, items[0...middle], report)
        return [left + items[middle..], true] if stop

        right, stop = replay_batched(queue, items[middle..], report)
        return [left + right, stop]
      end

      # A shard blip or a rate limit is not a verdict on the batch's contents.
      # Requeue it whole and stop the flush, exactly as the single-call path does
      # for the same codes.
      if transient?(error)
        note_retry_after(report, error)
        return [items, true]
      end

      items.each { |item| settle_terminal(queue, item, error, report) }

      [[], false]
    end

    # One batch entry per write, in input order.
    def batch_calls(items)
      items.each_with_index.map do |item, index|
        call = {
          "args" => Lunora.encode_wire(item.args || {}),
          "functionPath" => item.function_path,
          # The slot this entry's result comes back in.
          "id" => index,
          # The same stable key the single-call replay sends, beside the id that
          # namespaces its de-duplication row for an anonymous caller. Per ENTRY,
          # not on the outer request: a batch is one hop, but its entries are
          # dispatched as independent single calls.
          "mutationId" => item.id,
          "clientId" => item.client_id || @client_id
        }
        shard_key = item.shard_key
        call["shardKey"] = shard_key if shard_key && !shard_key.empty?
        call
      end
    end

    # POST one chunk. No +x-lunora-mutation-id+ on the request: a batch is ONE
    # transport hop carrying independent calls, so each entry carries its own key
    # in the body, and a single outer header would de-duplicate the whole chunk
    # against one write.
    def rpc_batch(calls)
      raise ApiError.new("INTERNAL", "no http_post configured") if @http_post.nil?

      headers = { "content-type" => "application/json" }
      headers["authorization"] = "Bearer #{@auth_token}" if @auth_token

      _status, body = @http_post.call(join_url(RPC_BATCH_PATH), headers, JSON.generate({ "calls" => calls }))
      body.is_a?(Hash) ? body : {}
    end

    # Demux a batch reply back onto the writes it replayed, in input order,
    # classifying each slot exactly as +replay_sequential+ classifies a whole
    # response. Returns the writes the caller must re-queue.
    def settle_batch_slots(queue, items, results, report)
      by_slot = {}
      results.each do |entry|
        next unless entry.is_a?(Hash) && entry["id"].is_a?(Integer) && entry["body"].is_a?(Hash)

        by_slot[entry["id"]] = entry["body"]
      end

      requeue = []

      items.each_with_index do |item, index|
        slot = by_slot[index]

        # The server never returned this slot. It may or may not have committed,
        # so retry it — the +mutationId+ makes that safe.
        if slot.nil?
          requeue << item
          next
        end

        envelope = slot["error"]

        if envelope.is_a?(Hash)
          error = batch_error(envelope, "request failed")

          # A transient shard failure or a rate limit is the batch's counterpart
          # of a raw error on the single-call path: the server never reached a
          # verdict on this entry, so the write goes back on the queue rather
          # than being reported as failed. Classified through the SAME predicate
          # the whole-batch and single-call paths use — a second code set here is
          # how a slot came to be terminal for a code the other two retried.
          if transient?(error)
            note_retry_after(report, error)
            requeue << item
            next
          end

          settle_terminal(queue, item, error, report)
          next
        end

        cursor = slot["commitCursor"]
        @mutex.synchronize { queue.unpersist(item.id) }
        settle_committed(item, Lunora.decode_wire(slot["result"]), cursor.is_a?(Integer) ? cursor : nil)
        report.committed << item.id
      end

      requeue
    end

    # Rebuild an ApiError from a slot's or a batch's error envelope, defaulting
    # the way +parse_rpc_response+ does.
    def batch_error(envelope, fallback)
      ApiError.new(
        envelope["code"].is_a?(String) ? envelope["code"] : "INTERNAL",
        envelope["message"].is_a?(String) ? envelope["message"] : fallback,
        envelope["data"].nil? ? nil : Lunora.decode_wire(envelope["data"])
      )
    end

    # Forget a write's durable record under the lock, then settle it outside one.
    def settle_terminal(queue, item, error, report)
      @mutex.synchronize { queue.unpersist(item.id) }
      settle_rejected(item, error)
      report.rejected << item.id
    end

    # Whether a failed replay may be retried rather than dropped.
    #
    # A raw error from the injected poster is the network, not the server: no
    # verdict was reached, so the write is still good.
    def transient?(error)
      if error.is_a?(ApiError)
        return error.transient || TRANSIENT_ERROR_CODES.include?(error.code) ||
               RATE_LIMIT_ERROR_CODES.include?(error.code)
      end

      true
    end

    # How long a rate-limited replay asks to wait, if the envelope said.
    #
    # nil when the server named no delay — the caller then decides its own
    # backoff rather than hammering, which is what +FlushReport#retry_after_ms+
    # reports.
    def retry_after_ms(error)
      return nil unless error.is_a?(ApiError) && RATE_LIMIT_ERROR_CODES.include?(error.code)

      delay = error.data.is_a?(Hash) ? error.data["retryAfterMs"] : nil
      return nil unless delay.is_a?(Integer) && delay.positive?

      [delay, MAX_RETRY_AFTER_MS].min
    end

    # Record a rate limit's delay, and hold the next flush off until it passes.
    def note_retry_after(report, error)
      delay = retry_after_ms(error)
      return if delay.nil?

      report.retry_after_ms = delay
      @mutex.synchronize do
        @flush_not_before = [@flush_not_before, Lunora.monotonic_now + (delay / 1000.0)].max
      end
    end

    # Run both optimistic APIs' CONSUMER code and return the layers to install.
    #
    # Runs with the lock RELEASED, and takes it only for the short registry reads
    # the store performs: a transform or an +optimistic_update+ that touches the
    # client it was handed must not deadlock on a non-reentrant Mutex.
    def plan_optimistic(options)
      planned = []

      unless options.optimistic.nil?
        states = @mutex.synchronize { find_states(options.function_path, options.args, options.shard_key) }
        planned.concat(Optimistic.plan_all(states, options.optimistic))
      end

      return planned if options.optimistic_update.nil?

      store = Optimistic::LocalStore.new(
        ->(path, query_args) { @mutex.synchronize { find_states(path, query_args, options.shard_key) } },
        ->(path) { @mutex.synchronize { matching_queries(path, options.shard_key) } }
      )

      begin
        options.optimistic_update.call(store, options.args)
        planned.concat(store.planned)
      rescue StandardError
        # A raising update installs NOTHING — its writes were only planned — so
        # the cache is left exactly as it was found and the write itself proceeds.
        nil
      end

      planned
    end

    # The live subscriptions registered under exactly this (path, args, shard).
    #
    # A linear scan, unlike @lunora/client's keyed registry, and deliberately:
    # this client does not de-duplicate subscriptions, so several can share one
    # triple and all of them must receive the overlay. The scan is over a handful
    # of entries on the write path, never the frame path.
    def find_states(function_path, args, shard_key)
      args_key = Lunora.stable_wire_key(args.nil? ? {} : args)
      matches = @subscriptions.each_value.select do |entry|
        entry[:function_path] == function_path && entry[:args_key] == args_key &&
          Lunora.same_shard?(entry[:shard_key], shard_key)
      end

      matches.map { |entry| entry[:state] }
    end

    def matching_queries(function_path, shard_key)
      matches = @subscriptions.each_value.select do |entry|
        entry[:function_path] == function_path && Lunora.same_shard?(entry[:shard_key], shard_key)
      end

      matches.map { |entry| [entry[:args], entry[:state].last_value] }
    end

    # The durable form of a write, built under the lock so its identity stamp and
    # the enqueue that follows cannot straddle a sign-in.
    def queued_write(options, confirms, rollbacks)
      QueuedMutation.new(
        args: options.args,
        client_id: @client_id,
        confirms: confirms,
        function_path: options.function_path,
        id: options.mutation_id,
        # Bound at enqueue time, so the write can only ever replay as whoever
        # made it.
        identity: @identity,
        live_awaiter: true,
        on_settled: options.on_settled,
        precondition: options.precondition,
        rollbacks: rollbacks,
        shard_key: options.shard_key
      )
    end

    # Confirm the overlay BEFORE the caller is told, so the gapless drop is
    # already in place when the confirming frame lands.
    def settle_committed(item, value, commit_cursor)
      settle_layers(item.confirms || [], [], commit_cursor)
      emit_settled(MutationSettled.new(had_awaiter: item.awaited?, mutation_id: item.id, status: :committed, value: value),
                   item.on_settled)
    end

    def settle_rejected(item, error)
      settle_layers([], item.rollbacks || [], nil)
      emit_settled(MutationSettled.new(error: error, had_awaiter: item.awaited?, mutation_id: item.id, status: :rejected),
                   item.on_settled)
    end

    # Settle every write the queue let go of without sending it.
    #
    # Runs with the lock RELEASED: a rejection rolls optimistic layers back, which
    # re-acquires it, and Ruby's Mutex is not reentrant. Every discard path funnels
    # through here, so an eviction can never drop a durable write in silence —
    # which matters most for a hydrated record, whose original caller did not
    # survive the restart and which therefore has no per-entry handler at all.
    def report_discarded(discarded)
      discarded.each { |item| settle_rejected(item.entry, item.error) }
    end

    # Run a write's confirms or rollbacks under the lock and deliver the
    # resulting notifications outside it.
    def settle_layers(confirms, rollbacks, commit_cursor)
      deferred = []

      @mutex.synchronize do
        Optimistic.confirm_all(confirms, commit_cursor, deferred)
        Optimistic.rollback_all(rollbacks, deferred)
      end

      deferred.each(&:call)
    end

    def emit_settled(event, on_settled)
      listeners = @mutex.synchronize { @settled_listeners.dup }
      listeners.unshift(on_settled) unless on_settled.nil?

      listeners.each do |listener|
        listener.call(event)
      rescue StandardError
        # A write's terminal verdict is the only report a restored write ever
        # produces, so one bad observer must not stop the rest being told.
        nil
      end
    end
  end
end
