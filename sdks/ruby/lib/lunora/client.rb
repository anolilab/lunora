# frozen_string_literal: true

require "json"
require "uri"

require_relative "key"
require_relative "wire"

module Lunora
  RPC_PATH = "/_lunora/rpc"
  WS_PATH = "/_lunora/ws"

  # A coded error from an RPC error envelope.
  class ApiError < StandardError
    attr_reader :code, :data

    def initialize(code, message, data = nil)
      super(message)
      @code = code
      @data = data
    end
  end

  # A subscription-scoped error the server pushed.
  SubscriptionError = Struct.new(:code, :message)

  module_function

  # Build the POST /_lunora/rpc body. +shard_key+ is omitted when nil, which
  # routes to the default shard.
  def build_rpc_body(function_path, args = nil, shard_key = nil)
    body = { "args" => encode_wire(args.nil? ? {} : args), "functionPath" => function_path }
    body["shardKey"] = shard_key unless shard_key.nil?
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
      raise ApiError.new(envelope.fetch("code", "INTERNAL"), envelope.fetch("message", "request failed"), data)
    end

    raise ApiError.new("INTERNAL", "HTTP #{status} without an error envelope") unless (200..299).cover?(status)

    decode_wire(body["result"])
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

    def initialize(url, http_post: nil, auth_token: nil, client_id: "ruby-client")
      @url = url
      @http_post = http_post
      @auth_token = auth_token
      @client_id = client_id
      @send = nil
      @subscriptions = {}
      @shapes = {}
      @pokes = {}
      @next_id = 0
      @next_shape_id = 0
      @mutex = Mutex.new
    end

    def attach_socket(sender) = @mutex.synchronize { @send = sender }

    def query(function_path, args = nil, shard_key = nil) = rpc(function_path, args, shard_key, nil)

    def mutation(function_path, args = nil, shard_key = nil, mutation_id: nil)
      rpc(function_path, args, shard_key, mutation_id)
    end

    # Same envelope as a mutation, but never an idempotency key: an action
    # performs external side effects and is not replayed against the shard, so
    # claiming mutation-style de-duplication for it would be a lie.
    def action(function_path, args = nil, shard_key = nil) = rpc(function_path, args, shard_key, nil)

    # +shard_key+ does NOT ride the subscribe frame: the protocol selects a
    # shard per SOCKET, via the +?shard=+ parameter +ws_url+ builds. It is
    # accepted so the generated surface is identical across languages, and is
    # otherwise unused — this client holds one socket, so it must already be the
    # shard that socket was opened against.
    def subscribe(function_path, args, on_data, on_error = nil, shard_key = nil)
      _ = shard_key
      id = nil

      locked_send do
        @next_id += 1
        id = "sub_#{@next_id}"
        @subscriptions[id] = {
          args: args, cursor: nil, epoch: nil, function_path: function_path,
          on_data: on_data, on_error: on_error
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

    # Re-subscribe everything after a reconnect, carrying each subscription's
    # resume cursor so the server can skip results that have not changed.
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

        @subscriptions.map do |id, entry|
          Lunora.build_subscribe_frame(
            id, entry[:function_path], entry[:args],
            since_seq: entry[:cursor], since_epoch: entry[:epoch]
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
      when "resume", "settled"
        advance(entry, frame)
        kind
      when "error" then deliver_error(frame, kind, deferred)
      when "complete"
        @subscriptions.delete(frame["id"])
        kind
      when "pokeStart"
        @pokes[frame["pokeId"]] = {}
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
      value = Lunora.decode_wire(payload)

      if entry
        advance(entry, frame)
        handler = entry[:on_data]
        deferred << -> { handler.call(value) } unless handler.nil?
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
        buffer[shape_id] = (buffer[shape_id] || []) + (frame["rowsPatch"] || [])
      end
      "pokePart"
    end

    def apply_poke(frame, deferred)
      buffer = @pokes.delete(frame["pokeId"])
      return "pokeEnd" if buffer.nil?

      buffer.each do |shape_id, operations|
        shape = @shapes[shape_id]
        next if shape.nil?

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
      raise ApiError.new("INTERNAL", "no http_post configured") if @http_post.nil?

      headers = { "content-type" => "application/json" }
      headers["authorization"] = "Bearer #{@auth_token}" if @auth_token
      headers["x-lunora-mutation-id"] = mutation_id if mutation_id

      status, body = @http_post.call(join_url(RPC_PATH), headers,
                                     JSON.generate(Lunora.build_rpc_body(function_path, args, shard_key)))
      Lunora.parse_rpc_response(body, status)
    end

    # The socket URL: the origin with its scheme swapped, plus the shard and
    # credential query parameters when present.
    def ws_url(shard_key = nil, token = nil)
      endpoint = join_url(WS_PATH).sub(%r{\Ahttps://}, "wss://").sub(%r{\Ahttp://}, "ws://")
      params = []
      params << "shard=#{URI.encode_www_form_component(shard_key)}" unless shard_key.nil?
      params << "token=#{URI.encode_www_form_component(token)}" unless token.nil?
      return endpoint if params.empty?

      "#{endpoint}#{endpoint.include?("?") ? "&" : "?"}#{params.join("&")}"
    end

    def join_url(path) = "#{@url.sub(%r{/\z}, "")}#{path}"
  end
end
