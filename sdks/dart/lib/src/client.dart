/// The Lunora RPC + WebSocket client, ported from `packages/client`.
///
/// HTTP and sockets are INJECTED rather than owned, as in every sibling port:
/// the conformance suite runs with no network, and a consumer keeps its own
/// package (`http`, `dio`, `web_socket_channel`, `dart:io`), timeouts and retry
/// policy rather than inheriting ours. It is also what makes this transport
/// dependency-free and therefore usable on every Flutter target — mobile,
/// desktop and web — with no FFI and no conditional imports.
///
/// ## Concurrency
///
/// The sibling ports hold a lock over the subscription registry, the shape views
/// and the id counters, because a socket read loop and application code run on
/// different OS threads there. This one holds none, and needs none: Dart
/// isolates share no mutable memory, so the socket read loop and the code that
/// calls [subscribe] are the same isolate's event loop. Every method below is
/// synchronous end to end — no `await` between reading [_nextId] and writing it —
/// so there is no interleaving point for a second event to land in. Reaching
/// this client from another isolate is not supported; give each isolate its own,
/// as one would with any Dart object.
library;

import 'dart:async';
import 'dart:convert';

import 'errors.dart';
import 'key.dart';
import 'offline_queue.dart';
import 'optimistic.dart';
import 'wire.dart';

/// The single endpoint every query/mutation/action posts to.
const String lunoraRpcPath = '/_lunora/rpc';

/// The live-subscription endpoint.
const String lunoraWsPath = '/_lunora/ws';

/// Which RPC method a call dispatches to. Generated code emits these cases
/// rather than raw strings, so a typo in a target template is a compile error
/// instead of a read silently sent over the write path.
enum LunoraVerb { query, mutation, action }

/// One HTTP response, as the injected poster reports it.
class LunoraHttpResponse {
  const LunoraHttpResponse(this.status, this.body);

  final int status;
  final String body;
}

/// Performs one POST. Injected — see the library comment.
typedef LunoraHttpPoster = Future<LunoraHttpResponse> Function(String url, Map<String, String> headers, String body);

/// Writes one JSON frame to an open socket. Injected for the same reason.
typedef LunoraFrameSender = void Function(Map<String, Object?> frame);

/// Cancels a subscription and tells the server to stop.
typedef LunoraUnsubscribe = void Function();

/// Receives a subscription's value on every push.
typedef LunoraDataCallback = void Function(Object? value);

/// Receives a shape view's full contents on every applied poke.
typedef LunoraRowsCallback = void Function(List<Object?> rows);

/// Receives a subscription-scoped error.
typedef LunoraErrorCallback = void Function(LunoraSubscriptionError error);

class _Subscription implements OptimisticTarget {
  _Subscription(this.functionPath, this.args, this.onData, this.onError) : argsKey = lunoraSubscriptionKey(functionPath, args);

  final String functionPath;
  final Object? args;

  /// The `(functionPath, args)` key this subscription is matched by when a
  /// mutation's optimistic update looks for the queries to patch. Computed once
  /// here rather than per mutation, so a write does not re-serialise every
  /// subscription's args to find its targets.
  final String argsKey;

  final LunoraDataCallback? onData;
  final LunoraErrorCallback? onError;

  /// The resume watermark, kept as the raw wire value because that is what goes
  /// straight back out as `sinceSeq`.
  Object? cursor;
  Object? epoch;

  @override
  Object? serverBase;

  @override
  Object? lastValue;

  @override
  bool delivered = false;

  @override
  List<OptimisticLayer> layers = <OptimisticLayer>[];

  /// The resume watermark narrowed to an integer, which is what an optimistic
  /// layer's `commitCursor` is compared against. A non-numeric or absent cursor
  /// reads as null, which keeps every layer pending rather than dropping one on
  /// a comparison that cannot be made.
  @override
  int? get serverCursor => cursor is int ? cursor! as int : null;

  @override
  void deliver(Object? value) => onData?.call(value);
}

class _ShapeSubscription {
  _ShapeSubscription(this.name, this.onRows, this.onError);

  final String name;
  final LunoraRowsCallback? onRows;
  final LunoraErrorCallback? onError;
  final Map<String, Object?> rows = <String, Object?>{};
  final List<String> order = <String>[];
  Object? checkpoint;
  Object? epoch;
}

/// A Lunora deployment client.
class LunoraClient {
  LunoraClient({required String url, LunoraHttpPoster? post, this.authToken, this.authSubject, OfflineQueue? offlineQueue})
      : _baseUrl = url,
        _post = post,
        _queue = offlineQueue ?? OfflineQueue();

  final String _baseUrl;
  final LunoraHttpPoster? _post;
  final OfflineQueue _queue;

  /// The bearer token sent on every RPC. Rotate it at any time; the next call
  /// picks it up.
  String? authToken;

  /// A stable subject — a user id — identifying who the client is acting as.
  ///
  /// Supplying it is what makes a token REFRESH keep its queued writes: the
  /// identity a queued write is stamped with is this subject when set, and a
  /// digest of [authToken] otherwise — so refreshing a token without a subject
  /// looks like a different user and discards the queue. Leave it null to fall
  /// back to the token digest; a null token then means signed out.
  String? authSubject;

  LunoraFrameSender? _send;
  final Map<String, _Subscription> _subscriptions = <String, _Subscription>{};
  final Map<String, _ShapeSubscription> _shapes = <String, _ShapeSubscription>{};
  final Map<String, Map<String, List<Map<String, Object?>>>> _pokes = <String, Map<String, List<Map<String, Object?>>>>{};
  int _nextId = 0;
  int _nextShapeId = 0;
  bool _connected = false;
  bool _wasEverConnected = false;
  bool _flushing = false;
  bool _flushAgain = false;

  /// Registers the sender used for subscription frames. Call once the socket is
  /// open.
  void attachSocket(LunoraFrameSender sender) {
    _send = sender;
  }

  // ─── Connectivity ─────────────────────────────────────────────────────────

  /// Tell the client whether its socket is up.
  ///
  /// This transport does not own the socket — the consumer does — so it cannot
  /// observe connectivity for itself, and this is how it learns. Call it with
  /// true when the socket opens and false when it closes or errors; the
  /// transition to true flushes the offline queue.
  ///
  /// The reconnect recipe is three lines, and the order matters — the sender has
  /// to be in place before anything is written to it:
  ///
  /// ```dart
  /// client.attachSocket(send);
  /// client.resendSubscriptions();
  /// client.setConnected(true);
  /// ```
  ///
  /// Kept separate from [resendSubscriptions] rather than folded into it,
  /// because the two are independently useful and a client that did both would
  /// double-send for the callers already invoking the latter.
  void setConnected(bool connected) {
    if (connected == _connected) {
      return;
    }

    _connected = connected;

    if (!connected) {
      return;
    }

    _wasEverConnected = true;

    unawaited(flushOfflineQueue());
  }

  /// Whether the client currently believes its socket is up.
  bool get connected => _connected;

  /// How many writes are queued for replay. Drives a "N pending" indicator; see
  /// `OfflineQueue.onSizeChange` for a push-based version.
  int get pendingWrites => _queue.size;

  /// The queue backing this client, for a caller that needs its observers or
  /// its persistence adapter's `clear()`.
  OfflineQueue get offlineQueue => _queue;

  /// Restore writes persisted in a prior session, returning how many came back.
  ///
  /// Call it once at startup, before or after connecting: restored writes replay
  /// on the next [setConnected] with true. A restored write has no awaiter — the
  /// caller that issued it is gone — so its verdict surfaces through the queue's
  /// observers rather than through a Future.
  Future<int> hydrate() => _queue.hydrate();

  /// Reject every queued write so no caller is left awaiting one, and drop every
  /// subscription.
  ///
  /// Durable storage is deliberately left intact: closing an app must not
  /// discard writes the next session will restore.
  void close() {
    _connected = false;
    _send = null;
    _subscriptions.clear();
    _shapes.clear();
    _pokes.clear();
    _queue.clear();
  }

  // ─── RPC ──────────────────────────────────────────────────────────────────

  /// Builds the `POST /_lunora/rpc` body. `shardKey` is omitted when null, which
  /// routes to the default shard.
  static Map<String, Object?> buildRpcBody(String functionPath, Object? args, {String? shardKey}) {
    final body = <String, Object?>{'args': encodeWire(args ?? const <String, Object?>{}), 'functionPath': functionPath};

    if (shardKey != null) {
      body['shardKey'] = shardKey;
    }

    return body;
  }

  /// Returns the decoded result, or throws [LunoraApiException].
  ///
  /// [status] is required for correctness, not diagnostics: `protocol/README.md`
  /// §4.2 says a non-2xx whose body carries no `error` envelope surfaces as an
  /// INTERNAL transport error. Without it a 502 with body `{"message":"…"}`
  /// returns null and throws nothing — the caller believes its mutation
  /// committed.
  static Object? parseRpcResponse(Map<String, Object?> body, {int status = 200}) {
    final envelope = body['error'];

    if (envelope is Map<String, Object?>) {
      final data = envelope['data'];

      throw LunoraApiException(
        envelope['code'] is String ? envelope['code'] as String : 'INTERNAL',
        envelope['message'] is String ? envelope['message'] as String : 'request failed',
        data == null ? null : decodeWire(data),
      );
    }

    if (status < 200 || status > 299) {
      throw LunoraApiException('INTERNAL', 'HTTP $status without an error envelope');
    }

    return decodeWire(body['result']);
  }

  /// A read. Never queued: a query has nothing to replay and a caller waiting on
  /// stale data it cannot get is worse served than one told the request failed.
  Future<Object?> query(String functionPath, {Object? args, String? shardKey}) async => (await _rpc(functionPath, args: args, shardKey: shardKey)).result;

  /// A write.
  ///
  /// Pass [optimistic] to patch a subscription's value immediately and have it
  /// rebase onto incoming frames until the server confirms the write, or
  /// [optimisticUpdate] to patch any number of subscribed queries. Both unwind
  /// if the write fails. See `optimistic.dart` for the model.
  ///
  /// **Which query [optimistic] patches.** The one subscribed under THIS
  /// mutation's own [functionPath] and [args] — not "whatever the write
  /// affects", which the client has no way to know. That makes it the shorthand
  /// for the case where a query and a mutation share a path and arguments (a
  /// counter, a document by id), and it silently finds nothing to patch
  /// otherwise. To patch a differently-named query — the usual case, a `send`
  /// mutation updating a `list` query — use [optimisticUpdate], whose store
  /// names its targets. This is the reference client's rule, kept verbatim so
  /// the eight SDKs cannot disagree about what a prediction applies to.
  ///
  /// While disconnected the write is QUEUED and this Future stays pending until
  /// it replays — see [setConnected]. [precondition] is evaluated just before
  /// that replay: returning false discards the write rather than sending it
  /// against state it no longer suits.
  Future<Object?> mutation(
    String functionPath, {
    Object? args,
    String? shardKey,
    String? mutationId,
    LunoraOptimistic? optimistic,
    LunoraOptimisticUpdate? optimisticUpdate,
    bool Function()? precondition,
  }) async {
    // One stable idempotency key per logical write, shared by the direct send
    // and any replay of it, so the server can deduplicate a write it already
    // committed rather than applying it twice.
    final id = mutationId ?? nextMutationId();
    final handles = _applyOptimistic(functionPath, args, optimistic, optimisticUpdate);

    // Queue only once the client has been connected at least once, unless the
    // queue was told otherwise: before the first connect a failure is more
    // likely a misconfiguration than a network blip, and failing fast says so.
    if (!_connected && (_wasEverConnected || _queue.queueBeforeFirstConnect)) {
      return _enqueue(functionPath, args, shardKey, id, handles, precondition);
    }

    try {
      final outcome = await _rpc(functionPath, args: args, shardKey: shardKey, mutationId: id);

      // Confirmed against the write's committed CDC cursor, never against this
      // Future resolving — that races the WebSocket broadcast.
      for (final handle in handles) {
        handle.confirm(outcome.commitCursor);
      }

      return outcome.result;
    } on Object {
      rollbackOptimistic(handles);

      rethrow;
    }
  }

  /// Same envelope as a mutation, but never an idempotency key and never
  /// queued: an action performs external side effects and is not replayed
  /// against the shard, so claiming mutation-style de-duplication or offline
  /// replay for it would be a lie.
  Future<Object?> action(String functionPath, {Object? args, String? shardKey}) async => (await _rpc(functionPath, args: args, shardKey: shardKey)).result;

  Future<({Object? result, int? commitCursor})> _rpc(String functionPath, {Object? args, String? shardKey, String? mutationId}) async {
    final post = _post;

    if (post == null) {
      throw const LunoraApiException('INTERNAL', 'no HTTP poster configured');
    }

    final headers = <String, String>{'content-type': 'application/json'};
    final token = authToken;

    if (token != null) {
      headers['authorization'] = 'Bearer $token';
    }
    if (mutationId != null) {
      headers['x-lunora-mutation-id'] = mutationId;
    }

    final response = await post(_join(lunoraRpcPath), headers, jsonEncode(buildRpcBody(functionPath, args, shardKey: shardKey)));
    final decoded = response.body.isEmpty ? null : jsonDecode(response.body);
    final body = decoded is Map<String, Object?> ? decoded : const <String, Object?>{};
    final cursor = body['commitCursor'];

    return (result: parseRpcResponse(body, status: response.status), commitCursor: cursor is int ? cursor : null);
  }

  /// Projects a generated model into the tree [encodeWire] accepts, through the
  /// `toJson()` quicktype renders on every model.
  ///
  /// The null pruning is the point, not tidiness. quicktype's Dart backend emits
  /// EVERY field in `toJson()`, so an unset optional reaches the wire as
  /// `"limit": null` — which `v.optional()` rejects, failing the call. Two
  /// sibling ports shipped exactly that bug before their smoke tests called a
  /// generated method rather than only compiling one. Swift avoids it because
  /// `JSONEncoder` omits a nil by default; this is that same behaviour, applied
  /// where Dart does not give it for free.
  ///
  /// Scoped to generated models, which is why it lives here and not in
  /// [encodeWire]: a model's unset optional is the ONLY thing null can mean at
  /// this boundary, whereas a null inside a hand-built argument tree is a value
  /// the caller chose and must survive.
  static Object? wireValue(dynamic model) {
    if (model == null) {
      return null;
    }

    return _pruneUnset(model is Map || model is List ? model : model.toJson());
  }

  static Object? _pruneUnset(Object? value) {
    if (value is Map) {
      return <String, Object?>{
        for (final entry in value.entries)
          if (entry.value != null) '${entry.key}': _pruneUnset(entry.value),
      };
    }
    if (value is List) {
      return <Object?>[for (final item in value) _pruneUnset(item)];
    }

    return value;
  }

  // ─── Frame builders ───────────────────────────────────────────────────────

  static Map<String, Object?> buildConnectFrame({String? clientId, Map<String, Object?>? context}) {
    final frame = <String, Object?>{'id': 'connect', 'type': 'connect'};

    if (clientId != null) {
      frame['clientId'] = clientId;
    }
    if (context != null) {
      frame['context'] = context;
    }

    return frame;
  }

  static Map<String, Object?> buildSubscribeFrame(
    String id,
    String functionPath,
    Object? args, {
    String? table,
    Object? sinceSeq,
    Object? sinceEpoch,
  }) {
    final query = <String, Object?>{
      'args': encodeWire(args ?? const <String, Object?>{}),
      'functionPath': functionPath,
      'table': table ?? functionPath,
    };

    if (sinceSeq != null) {
      query['sinceSeq'] = sinceSeq;
    }
    if (sinceEpoch != null) {
      query['sinceEpoch'] = sinceEpoch;
    }

    return <String, Object?>{'id': id, 'query': query, 'type': 'subscribe'};
  }

  static Map<String, Object?> buildUnsubscribeFrame(String id) => <String, Object?>{'id': id, 'type': 'unsubscribe'};

  static Map<String, Object?> buildShapeSubscribeFrame(String id, String name, {Object? args, Object? sinceCheckpoint, Object? sinceEpoch}) {
    final shape = <String, Object?>{'name': name};

    if (args != null) {
      shape['args'] = encodeWire(args);
    }

    final frame = <String, Object?>{'id': id, 'shape': shape, 'type': 'shape_subscribe'};

    if (sinceCheckpoint != null) {
      frame['sinceCheckpoint'] = sinceCheckpoint;
    }
    if (sinceEpoch != null) {
      frame['sinceEpoch'] = sinceEpoch;
    }

    return frame;
  }

  static Map<String, Object?> buildShapeUnsubscribeFrame(String id) => <String, Object?>{'id': id, 'type': 'shape_unsubscribe'};

  // ─── Subscriptions ────────────────────────────────────────────────────────

  LunoraUnsubscribe subscribe(String functionPath, {Object? args, LunoraDataCallback? onData, LunoraErrorCallback? onError}) {
    _nextId += 1;

    final id = 'sub_$_nextId';

    _subscriptions[id] = _Subscription(functionPath, args, onData, onError);
    _send?.call(buildSubscribeFrame(id, functionPath, args));

    return () {
      if (_subscriptions.remove(id) != null) {
        _send?.call(buildUnsubscribeFrame(id));
      }
    };
  }

  /// A live query as a `Stream`, so a Flutter widget can bind it with
  /// `StreamBuilder` and let the framework own the lifecycle.
  ///
  /// The subscription starts when the stream is first listened to and is torn
  /// down when the last listener cancels — which is what makes this the right
  /// default in a widget tree: disposing the widget disposes the subscription,
  /// with no `dispose()` override to forget. Use [subscribe] directly when the
  /// value's lifetime is not a widget's.
  Stream<Object?> watch(String functionPath, {Object? args}) {
    LunoraUnsubscribe? cancel;
    late final StreamController<Object?> controller;

    controller = StreamController<Object?>(
      onListen: () {
        cancel = subscribe(
          functionPath,
          args: args,
          onData: controller.add,
          onError: (error) => controller.addError(error),
        );
      },
      onCancel: () {
        cancel?.call();
        cancel = null;
      },
    );

    return controller.stream;
  }

  /// Opens a partially-replicated keyed view. `onRows` fires once per applied
  /// poke with the view's full contents, in insertion order.
  LunoraUnsubscribe subscribeShape(String name, {Object? args, LunoraRowsCallback? onRows, LunoraErrorCallback? onError}) {
    _nextShapeId += 1;

    final id = 'shape_$_nextShapeId';

    _shapes[id] = _ShapeSubscription(name, onRows, onError);
    _send?.call(buildShapeSubscribeFrame(id, name, args: args));

    return () {
      if (_shapes.remove(id) != null) {
        _send?.call(buildShapeUnsubscribeFrame(id));
      }
    };
  }

  /// Re-subscribes everything after a reconnect, carrying each subscription's
  /// resume cursor so the server can skip results that have not changed.
  ///
  /// Without this the `cursor`/`epoch` tracked on every `data` frame would be
  /// write-only state and a reconnect would silently re-seed from scratch.
  void resendSubscriptions() {
    final sender = _send;

    if (sender == null) {
      return;
    }

    for (final entry in _subscriptions.entries) {
      sender(
        buildSubscribeFrame(
          entry.key,
          entry.value.functionPath,
          entry.value.args,
          sinceSeq: entry.value.cursor,
          sinceEpoch: entry.value.epoch,
        ),
      );
    }
  }

  // ─── Inbound frames ───────────────────────────────────────────────────────

  /// Applies one server frame and returns its type. Unknown types are ignored,
  /// per the protocol's forward-compatibility rule.
  String? handleFrame(String raw) {
    if (raw == 'lunora-ping' || raw == 'lunora-pong') {
      return null;
    }

    final Object? parsed;

    try {
      parsed = jsonDecode(raw);
    } on FormatException {
      // Non-JSON frames are ignored by the client parser, not fatal.
      return null;
    }

    return parsed is Map<String, Object?> ? _dispatch(parsed) : null;
  }

  String? _dispatch(Map<String, Object?> frame) {
    final kind = frame['type'] is String ? frame['type'] as String : null;
    final id = frame['id'] is String ? frame['id'] as String : null;

    switch (kind) {
      case 'data':
      case 'delta':
        final value = decodeWire(frame['data'] ?? frame['delta']);
        final entry = id == null ? null : _subscriptions[id];

        if (entry != null) {
          // Order matters, and matches the reference client: record the
          // authoritative value, advance the cursor, drop the layers the server
          // has now confirmed, and only then display the base re-folded through
          // whatever is still pending. Notifying before the drop would show the
          // confirmed write twice — once in the new base and once in its own
          // overlay.
          entry.serverBase = value;
          _advance(entry, frame);
          dropConfirmedLayers(entry, entry.serverCursor);
          notifyTarget(entry, foldOptimistic(value, entry.layers));
        }

        return kind;
      case 'resume':
      case 'settled':
        final entry = id == null ? null : _subscriptions[id];

        if (entry != null) {
          _advance(entry, frame);

          // A `resume`/`settled` frame advances the cursor without a value
          // change — but a write whose result was byte-identical for this query
          // still committed at or under that cursor, so its layer is now
          // confirmed. Sweeping here too is what stops a no-visible-change write
          // leaving its overlay stuck forever.
          if (dropConfirmedLayers(entry, entry.serverCursor)) {
            notifyTarget(entry, foldOptimistic(entry.serverBase, entry.layers));
          }
        }

        return kind;
      case 'error':
        final envelope = frame['error'];
        final coded = envelope is Map<String, Object?> ? envelope : const <String, Object?>{};
        final error = LunoraSubscriptionError(
          coded['code'] is String ? coded['code'] as String : null,
          frame['message'] is String
              ? frame['message'] as String
              : coded['message'] is String
                  ? coded['message'] as String
                  : 'subscription error',
        );

        if (id != null) {
          _subscriptions[id]?.onError?.call(error);
          _shapes[id]?.onError?.call(error);
        }

        return kind;
      case 'complete':
        if (id != null) {
          _subscriptions.remove(id);
        }

        return kind;
      case 'pokeStart':
        final pokeId = frame['pokeId'];

        if (pokeId is String) {
          _pokes[pokeId] = <String, List<Map<String, Object?>>>{};
        }

        return kind;
      case 'pokePart':
        _bufferPokePart(frame);

        return kind;
      case 'pokeEnd':
        _applyPoke(frame);

        return kind;
      default:
        return kind;
    }
  }

  void _advance(_Subscription entry, Map<String, Object?> frame) {
    if (frame.containsKey('cursor')) {
      entry.cursor = frame['cursor'];
    }
    if (frame.containsKey('epoch')) {
      entry.epoch = frame['epoch'];
    }
  }

  /// Parts buffer until `pokeEnd`: a poke is an atomic batch, so applying them
  /// as they arrive would expose a torn view, and a socket dropping mid-poke
  /// would leave it permanently half-applied.
  void _bufferPokePart(Map<String, Object?> frame) {
    final pokeId = frame['pokeId'];
    final shapeId = frame['shapeId'];

    if (pokeId is! String || shapeId is! String) {
      return;
    }

    // A part for an unknown poke is dropped: without its pokeStart there is no
    // batch to join, and guessing applies a fragment.
    final buffer = _pokes[pokeId];

    if (buffer == null) {
      return;
    }

    final patch = frame['rowsPatch'];

    if (patch is! List) {
      return;
    }

    buffer.putIfAbsent(shapeId, () => <Map<String, Object?>>[]).addAll(patch.whereType<Map<String, Object?>>());
  }

  void _applyPoke(Map<String, Object?> frame) {
    final pokeId = frame['pokeId'];

    if (pokeId is! String) {
      return;
    }

    final buffer = _pokes.remove(pokeId);

    if (buffer == null) {
      return;
    }

    // The view is mutated first and every callback fires afterwards, with the
    // row snapshot taken before delivery — so a callback that re-enters this
    // client sees one consistent poke rather than a half-applied one.
    final deliveries = <MapEntry<LunoraRowsCallback, List<Object?>>>[];

    for (final shapeEntry in buffer.entries) {
      final shape = _shapes[shapeEntry.key];

      if (shape == null) {
        continue;
      }

      for (final operation in shapeEntry.value) {
        final key = operation['key'];

        if (key is! String) {
          continue;
        }

        if (operation['op'] == 'delete') {
          if (shape.rows.remove(key) != null) {
            shape.order.remove(key);
          }
          continue;
        }

        // A value-less upsert is membership-only; it must not blank an existing
        // row.
        final value = operation['value'];

        if (value == null) {
          continue;
        }

        if (!shape.rows.containsKey(key)) {
          shape.order.add(key);
        }

        shape.rows[key] = decodeWire(value);
      }

      if (frame.containsKey('checkpoint')) {
        shape.checkpoint = frame['checkpoint'];
      }
      if (frame.containsKey('epoch')) {
        shape.epoch = frame['epoch'];
      }

      final onRows = shape.onRows;

      if (onRows != null) {
        deliveries.add(MapEntry(onRows, <Object?>[for (final key in shape.order) shape.rows[key]]));
      }
    }

    for (final delivery in deliveries) {
      delivery.key(delivery.value);
    }
  }

  // ─── Optimistic updates ───────────────────────────────────────────────────

  /// Register this write's optimistic layers and return their settle handles,
  /// in application order.
  List<OptimisticLayerHandle> _applyOptimistic(String functionPath, Object? args, LunoraOptimistic? optimistic, LunoraOptimisticUpdate? update) {
    final handles = <OptimisticLayerHandle>[];

    if (optimistic != null) {
      // Every subscription on this exact query, not just one. The reference
      // client de-duplicates subscriptions by key so there is only ever one to
      // find; this transport gives each `subscribe` call its own id, matching
      // its sibling ports, so a query two widgets are watching has two states
      // and both must see the prediction.
      final key = lunoraSubscriptionKey(functionPath, args);

      for (final entry in _subscriptions.values) {
        if (entry.argsKey == key) {
          final handle = applyOptimisticLayer(entry, optimistic);

          if (handle != null) {
            handles.add(handle);
          }
        }
      }
    }

    if (update != null) {
      final own = <OptimisticLayerHandle>[];

      try {
        update(_LocalStore(this, own), args);
      } on Object {
        // A throwing update unwinds ONLY its own writes, most recent first, and
        // is swallowed — a buggy optimistic update must not fail the mutation
        // and must not leave a partial patch live.
        rollbackOptimistic(own);

        return handles;
      }

      handles.addAll(own);
    }

    return handles;
  }

  /// Every subscription watching `(functionPath, args)`, for the local store.
  List<_Subscription> _matching(String functionPath, Object? args) {
    final key = lunoraSubscriptionKey(functionPath, args);

    return <_Subscription>[
      for (final entry in _subscriptions.values)
        if (entry.argsKey == key) entry
    ];
  }

  // ─── Offline queue ────────────────────────────────────────────────────────

  Future<Object?> _enqueue(
    String functionPath,
    Object? args,
    String? shardKey,
    String id,
    List<OptimisticLayerHandle> handles,
    bool Function()? precondition,
  ) {
    final completer = Completer<Object?>();

    _queue.enqueue(
      QueuedMutation(
        id: id,
        functionPath: functionPath,
        args: args,
        shardKey: shardKey,
        // Bound at enqueue so the write can only ever replay as whoever issued
        // it — see [flushOfflineQueue].
        identity: identityFingerprint(),
        completer: completer,
        precondition: precondition,
        onCommit: (cursor) {
          for (final handle in handles) {
            handle.confirm(cursor);
          }
        },
        onReject: (_) => rollbackOptimistic(handles),
      ),
    );

    return completer.future;
  }

  /// Replay every queued write, oldest first.
  ///
  /// Called for you on the transition to connected; public because a caller that
  /// knows connectivity came back some other way may want to trigger it.
  ///
  /// A write issued DURING a flush goes straight out rather than behind the
  /// queue, because the client is connected by then. That matches the reference
  /// client, whose gate opens the moment its socket does; if a strict global
  /// order matters, wait for this Future before writing again.
  Future<void> flushOfflineQueue() async {
    if (_flushing) {
      // A reconnect arrived mid-flush. Remembered rather than dropped: the
      // running flush may already have stopped on the very transport failure
      // that caused the disconnect, and its re-queued writes would then sit
      // untouched until some LATER reconnect happened to come along.
      _flushAgain = true;

      return;
    }

    _flushing = true;

    try {
      do {
        _flushAgain = false;

        await _flushOnce();
        // Only while still connected, so a disconnect that lands mid-pass ends
        // the loop instead of retrying into a socket that is down.
      } while (_flushAgain && _connected);
    } finally {
      _flushing = false;
    }
  }

  /// One drain-and-replay pass. See [flushOfflineQueue], which owns the
  /// re-entrancy and the coalesced-reconnect loop around it.
  Future<void> _flushOnce() async {
    // Weed out writes whose assumptions expired while offline before draining
    // the rest. `drainConflict` rejects each one itself.
    for (final stale in _queue.drainConflict()) {
      _queue.unpersist(stale.id);
    }

    final drained = _queue.drain();

    if (drained.isEmpty) {
      return;
    }

    // ONE identity snapshot for the whole batch: a replay is a sequence of
    // authenticated requests and there is no point between them where the
    // token could change without this loop seeing it. A mismatch is rejected
    // rather than silently dropped, so an awaiting caller gets a verdict.
    final identity = identityFingerprint();
    final sendable = <QueuedMutation>[];

    for (final item in drained) {
      if (item.identity == identity) {
        sendable.add(item);
      } else {
        _queue.unpersist(item.id);
        item.reject(const LunoraApiException(offlineIdentityChanged, 'offline mutation discarded: it was queued under a different identity'));
      }
    }

    for (var index = 0; index < sendable.length; index += 1) {
      final item = sendable[index];

      try {
        final outcome = await _rpc(item.functionPath, args: item.args, shardKey: item.shardKey, mutationId: item.id);

        _queue.unpersist(item.id);
        item.onCommit?.call(outcome.commitCursor);
        item.resolve(outcome.result);
      } on LunoraApiException catch (error) {
        // A coded error means the server answered and rejected the write.
        // Terminal: replaying it would fail identically forever.
        _queue.unpersist(item.id);
        item.reject(error);
      } on WireFormatException catch (error) {
        // Also terminal, and the distinction is load-bearing. Args that cannot
        // be wire-encoded fail deterministically, so classifying this as
        // transient would re-queue the write forever — a silent hang where the
        // caller's Future never settles and its optimistic layer never rolls
        // back.
        _queue.unpersist(item.id);
        item.reject(LunoraApiException('BAD_REQUEST', 'offline mutation cannot be encoded: $error'));
      } on Object {
        // Uncoded: a transport failure. Transient — put this write and every
        // one after it back at the front, in order, and stop the flush.
        _queue.requeue(sendable.sublist(index));

        return;
      }
    }
  }

  /// The identity a queued write is stamped with, and gated on at replay.
  ///
  /// A digest rather than the token itself because the stamp is written to
  /// durable storage: an app's queue file should not become somewhere a bearer
  /// token sits at rest. The digest is the reference client's — FNV-1a and djb2
  /// side by side, delimited by the token's length so two distinct tokens cannot
  /// encode to one string through variable-width concatenation.
  String? identityFingerprint() {
    final subject = authSubject;

    if (subject != null) {
      // A distinct namespace from the digest format below, so a subject can
      // never alias a token fingerprint.
      return 'subj:$subject';
    }

    final token = authToken;

    return token == null ? null : _hashToken(token);
  }

  static String _hashToken(String token) {
    var fnv = 0x811c9dc5;
    var djb2 = 5381;

    for (var index = 0; index < token.length; index += 1) {
      // Code UNITS, not runes: it keeps the digest stable across surrogate pairs
      // and identical to the reference client's `charCodeAt` walk.
      final code = token.codeUnitAt(index);

      fnv = _mul32(fnv ^ code, 0x01000193);
      djb2 = (_mul32(djb2, 33) + code) & 0xFFFFFFFF;
    }

    return '${token.length.toRadixString(36)}:${fnv.toRadixString(36)}:${djb2.toRadixString(36)}';
  }

  /// A 32-bit multiply that is exact on every Dart target.
  ///
  /// Not `(a * b) & 0xFFFFFFFF`: compiled to JavaScript a Dart `int` IS a
  /// double, so a product above 2^53 silently loses low bits and the digest
  /// would differ between Flutter web and everywhere else. Splitting the left
  /// operand into 16-bit halves keeps both partial products under 2^48, which is
  /// exact in a double — the same reason the reference client reaches for
  /// `Math.imul`, which Dart has no counterpart to.
  static int _mul32(int a, int b) {
    final low = a & 0xFFFF;
    final high = (a >> 16) & 0xFFFF;

    return (low * b + (((high * b) & 0xFFFF) << 16)) & 0xFFFFFFFF;
  }

  // ─── URLs ─────────────────────────────────────────────────────────────────

  /// The socket URL: the origin with its scheme swapped, plus the shard and
  /// credential query parameters when present.
  String wsUrl({String? shardKey, String? token}) {
    var endpoint = _join(lunoraWsPath);

    if (endpoint.startsWith('https://')) {
      endpoint = 'wss://${endpoint.substring('https://'.length)}';
    } else if (endpoint.startsWith('http://')) {
      endpoint = 'ws://${endpoint.substring('http://'.length)}';
    }

    final params = <String>[
      if (shardKey != null) 'shard=${Uri.encodeQueryComponent(shardKey)}',
      if (token != null) 'token=${Uri.encodeQueryComponent(token)}',
    ];

    if (params.isEmpty) {
      return endpoint;
    }

    return '$endpoint${endpoint.contains('?') ? '&' : '?'}${params.join('&')}';
  }

  String _join(String path) => '${_baseUrl.endsWith('/') ? _baseUrl.substring(0, _baseUrl.length - 1) : _baseUrl}$path';
}

/// The store handed to a mutation's [LunoraOptimisticUpdate].
///
/// Every `setQuery` registers a constant layer through the same engine the
/// per-call `optimistic` transform uses, so the whole multi-query patch rebases
/// onto incoming frames and settles together on the write's commit cursor.
class _LocalStore implements OptimisticLocalStore {
  _LocalStore(this._client, this._handles);

  final LunoraClient _client;

  /// The handles THIS update produced, kept apart from the mutation's own so a
  /// throwing update can unwind exactly its own writes and nothing else.
  final List<OptimisticLayerHandle> _handles;

  @override
  Object? getQuery(String functionPath, {Object? args}) {
    final matches = _client._matching(functionPath, args);

    // Any match will do: they are all watching the same query, so their
    // displayed values agree.
    return matches.isEmpty ? null : matches.first.lastValue;
  }

  @override
  List<({Object? args, Object? value})> getAllQueries(String functionPath) => <({Object? args, Object? value})>[
        for (final entry in _client._subscriptions.values)
          if (entry.functionPath == functionPath) (args: entry.args, value: entry.lastValue),
      ];

  @override
  void setQuery(String functionPath, Object? value, {Object? args}) {
    for (final entry in _client._matching(functionPath, args)) {
      // A CONSTANT layer, which masks rather than merges: while pending it
      // re-clamps to the predicted value and hides concurrent server changes to
      // this query, until the confirming frame drops it. That is the intended
      // absolute-override semantics of a `setQuery`.
      final handle = applyOptimisticLayer(entry, (_) => value);

      if (handle != null) {
        _handles.add(handle);
      }
    }
  }
}

/// The stable subscription key for a call, as `protocol/README.md` §3 defines
/// it. Exposed because a caller de-duplicating its own subscriptions needs the
/// same key the server and the reference client compute.
///
/// Absent args key as `{}`, which is what actually goes on the wire — every
/// frame builder sends `args ?? {}`. Without the normalisation a subscription
/// opened with no args and a mutation fired with an empty map would compute
/// different keys for the same query, and an optimistic update would silently
/// find nothing to patch.
String lunoraSubscriptionKey(String functionPath, Object? args, {String? shardKey}) =>
    '$functionPath::${stableWireKey(args ?? const <String, Object?>{})}::${shardKey ?? ''}';
