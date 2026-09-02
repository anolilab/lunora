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
/// different OS threads there. This one holds none, and needs none for THAT
/// state: Dart isolates share no mutable memory, so the socket read loop and the
/// code that calls [subscribe] are the same isolate's event loop, and every
/// method touching the registry is synchronous end to end — no `await` between
/// reading [_nextId] and writing it, so no interleaving point for a second event
/// to land in.
///
/// The offline queue is a different matter, and the guards that look redundant
/// are not. Replaying awaits the network, so a caller CAN run between two of its
/// steps: [flushOfflineQueue] is single-flight via `_flushing` and coalesces a
/// reconnect that arrives mid-flush into `_flushAgain`, and every place that
/// touches shared state after an `await` re-checks `_closed` — because a flush
/// has already DRAINED the queue, so `close()` cannot see those writes and they
/// have to be settled where they are.
///
/// Reaching this client from another isolate is not supported; give each isolate
/// its own, as one would with any Dart object.
library;

import 'dart:async';
import 'dart:convert';

import 'errors.dart';
import 'key.dart';
import 'offline_queue.dart';
import 'optimistic.dart';
import 'replay.dart';
import 'transport.dart';
import 'shapes.dart';
import 'wire.dart';

/// Which RPC method a call dispatches to. Generated code emits these cases
/// rather than raw strings, so a typo in a target template is a compile error
/// instead of a read silently sent over the write path.
enum LunoraVerb { query, mutation, action }

/// Receives a subscription's value on every push.
typedef LunoraDataCallback = void Function(Object? value);

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

/// A Lunora deployment client.
class LunoraClient {
  LunoraClient({required String url, LunoraHttpPoster? post, String? authToken, String? authSubject, String? clientId, OfflineQueue? offlineQueue})
      : transport = LunoraTransport(url: url, post: post, authToken: authToken, authSubject: authSubject, clientId: clientId),
        _queue = offlineQueue ?? OfflineQueue() {
    _replayer = OfflineReplayer(transport: transport, queue: _queue, isClosed: () => _closed, isConnected: connectedTo);
  }

  /// Where this deployment lives, who is calling, and how a request is made.
  final LunoraTransport transport;

  final OfflineQueue _queue;

  late final OfflineReplayer _replayer;

  /// The bearer token sent on every RPC. Rotate it at any time; the next call
  /// picks it up.
  String? get authToken => transport.authToken;

  set authToken(String? value) => transport.authToken = value;

  /// A stable subject — a user id — identifying who the client is acting as.
  /// See [LunoraTransport.authSubject].
  String? get authSubject => transport.authSubject;

  set authSubject(String? value) => transport.authSubject = value;

  /// Identifies this client to the server's idempotency bookkeeping — see
  /// [LunoraTransport.clientId].
  String get clientId => transport.clientId;

  /// Builds the `POST /_lunora/rpc` body — see [LunoraTransport.buildRpcBody].
  static Map<String, Object?> buildRpcBody(String functionPath, Object? args, {String? shardKey}) =>
      LunoraTransport.buildRpcBody(functionPath, args, shardKey: shardKey);

  /// Decodes one RPC response — see [LunoraTransport.parseRpcResponse].
  static Object? parseRpcResponse(Map<String, Object?> body, {required int status}) => LunoraTransport.parseRpcResponse(body, status: status);

  /// The identity a queued write is stamped with — see
  /// [LunoraTransport.identityFingerprint].
  String? identityFingerprint() => transport.identityFingerprint();

  /// The socket URL — see [LunoraTransport.wsUrl].
  String wsUrl({String? shardKey, String? token}) => transport.wsUrl(shardKey: shardKey, token: token);

  LunoraFrameSender? _send;
  final Map<String, _Subscription> _subscriptions = <String, _Subscription>{};
  final ShapeRegistry _shapeRegistry = ShapeRegistry();
  int _nextId = 0;

  /// The shards whose socket is currently up, normalised so `null` and `''` are
  /// the one default shard (see `sameShard`). A SET rather than one flag: an app
  /// sharded by room or tenant holds several sockets, and treating a single
  /// reconnect as "connected" would replay every shard's writes down whichever
  /// connection happened to come back.
  final Set<String> _connectedShards = <String>{};
  bool _wasEverConnected = false;
  bool _closed = false;

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
  void setConnected(bool connected, {String? shardKey}) {
    final shard = shardKey ?? '';

    if (connected == _connectedShards.contains(shard)) {
      return;
    }

    if (!connected) {
      _connectedShards.remove(shard);

      return;
    }

    _connectedShards.add(shard);
    _wasEverConnected = true;

    unawaited(flushOfflineQueue(shardKey: shardKey));
  }

  /// Whether ANY shard's socket is up. A sharded app wanting one shard's answer
  /// asks [connectedTo].
  bool get connected => _connectedShards.isNotEmpty;

  /// Whether the socket for one shard is up. `null` and `''` are the same shard.
  bool connectedTo(String? shardKey) => _connectedShards.contains(shardKey ?? '');

  /// How many writes are queued for replay. Drives a "N pending" indicator; see
  /// `OfflineQueue.onSizeChange` for a push-based version.
  int get pendingWrites => _queue.size;

  /// The queue backing this client, for a caller that needs its observers or
  /// its persistence adapter's `clear()`.
  OfflineQueue get offlineQueue => _queue;

  /// Restore writes persisted in a prior session, returning how many came back.
  ///
  /// Call it once at startup, before or after connecting — either way the
  /// restored writes replay. Before, they go out on the first [setConnected];
  /// after, this flushes them itself, because `setConnected(true)` early-returns
  /// when already connected and would otherwise leave them queued until the
  /// socket happened to drop and come back.
  ///
  /// A restored write has no awaiter — the caller that issued it is gone — so its
  /// verdict surfaces through `OfflineQueue.onSettled` rather than a Future.
  Future<int> hydrate() async {
    final restored = await _queue.hydrate();

    if (restored == 0) {
      return restored;
    }

    // One flush per SHARD the restored writes belong to, and only for the ones
    // already connected. A single global flush would drain another shard's
    // writes down this shard's connection.
    for (final shard in <String>{for (final item in _queue.items) item.shardKey ?? ''}) {
      if (_connectedShards.contains(shard)) {
        unawaited(flushOfflineQueue(shardKey: shard.isEmpty ? null : shard));
      }
    }

    return restored;
  }

  /// Whether [close] has been called. A closed client accepts no further calls.
  bool get closed => _closed;

  /// Reject every queued write so no caller is left awaiting one, and drop every
  /// subscription.
  ///
  /// Terminal: a call made afterwards fails fast rather than being queued
  /// against a client that will never flush again. Without that, a write issued
  /// after `close` re-entered the queue this method had just drained and its
  /// Future never settled — the exact hang `close` exists to prevent.
  ///
  /// Durable storage is deliberately left intact: closing an app must not
  /// discard writes the next session will restore.
  void close() {
    _closed = true;
    _connectedShards.clear();
    _send = null;
    _subscriptions.clear();
    _shapeRegistry.clear();
    _queue.clear();
  }

  // ─── RPC ──────────────────────────────────────────────────────────────────

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
    _assertOpen();

    // One stable idempotency key per logical write, shared by the direct send
    // and any replay of it, so the server can deduplicate a write it already
    // committed rather than applying it twice.
    final id = mutationId ?? nextMutationId();
    final handles = _applyOptimistic(functionPath, args, optimistic, optimisticUpdate);

    // Per SHARD: a write for a shard whose socket is down queues even while
    // another shard is connected, because the connection that is up cannot
    // reach it.
    if (!connectedTo(shardKey) && _queue.acceptsWhileDisconnected(everConnected: _wasEverConnected)) {
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

  /// One RPC, refusing to start on a closed client.
  Future<LunoraRpcOutcome> _rpc(String functionPath, {Object? args, String? shardKey, String? mutationId, String? issuedBy}) {
    _assertOpen();

    return transport.rpc(functionPath, args: args, shardKey: shardKey, mutationId: mutationId, issuedBy: issuedBy);
  }

  void _assertOpen() {
    if (_closed) {
      throw const LunoraApiException(clientClosed, 'this client is closed');
    }
  }

  /// Projects a generated model into the tree [encodeWire] accepts, through the
  /// `toJson()` quicktype renders on every model.
  ///
  /// A faithful pass-through, deliberately. It used to prune null fields, which
  /// was wrong for half the schemas it saw: an unset `v.optional()` must reach
  /// the wire as an ABSENT key, but a `v.nullable()` set to null must reach it as
  /// a PRESENT key holding null, and nothing at this boundary can tell the two
  /// apart — the model has already flattened both to a null field. Pruning broke
  /// every nullable argument; not pruning broke every unset optional.
  ///
  /// So the distinction is drawn where it is still visible, in the emitter:
  /// `guardOptionalFields` in `targets/dart.ts` makes `toJson()` omit an unset
  /// optional and keep a required null, using the `required` marker quicktype
  /// itself puts in the constructor. By the time a map arrives here it is already
  /// right, and second-guessing it is what caused the bug.
  static Object? wireValue(dynamic model) => model == null || model is Map || model is List ? model : model.toJson();

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

  static Map<String, Object?> buildShapeSubscribeFrame(String id, String name, {Object? args, Object? sinceCheckpoint, Object? sinceEpoch}) =>
      ShapeRegistry.buildSubscribeFrame(id, name, args: args, sinceCheckpoint: sinceCheckpoint, sinceEpoch: sinceEpoch);

  static Map<String, Object?> buildShapeUnsubscribeFrame(String id) => ShapeRegistry.buildUnsubscribeFrame(id);

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
  /// Each listener opens its OWN subscription, which starts when it listens and
  /// is torn down when it cancels — so disposing a widget disposes exactly its
  /// own subscription, with no `dispose()` override to forget, and two
  /// `StreamBuilder`s can watch one query without either interfering with the
  /// other. Use [subscribe] directly when the value's lifetime is not a
  /// widget's.
  ///
  /// `Stream.multi` and not a plain `StreamController`: a single-subscription
  /// controller throws "Stream has already been listened to" on a second
  /// listener AND on a re-listen after cancel, both of which a widget tree does
  /// routinely — a stream held in `State` and handed to two builders, or a
  /// builder that rebuilds after its subscription was cancelled.
  Stream<Object?> watch(String functionPath, {Object? args}) => Stream<Object?>.multi((controller) {
        final cancel = subscribe(functionPath, args: args, onData: controller.add, onError: controller.addError);

        controller.onCancel = cancel;
      });

  /// Opens a partially-replicated keyed view. `onRows` fires once per applied
  /// poke with the view's full contents, in insertion order. See
  /// [ShapeRegistry], which owns the protocol.
  LunoraUnsubscribe subscribeShape(String name, {Object? args, LunoraRowsCallback? onRows, LunoraErrorCallback? onError}) =>
      _shapeRegistry.subscribe(name, sender: () => _send, args: args, onRows: onRows, onError: onError);

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

    // Every frame is BUILT before any is sent. The sender writes a socket this
    // client does not own, and a write that synchronously unsubscribes — or
    // throws into a handler that does — would otherwise mutate `_subscriptions`
    // while it is being iterated. Swift's port serialises this under its lock
    // for the same reason.
    final frames = <Map<String, Object?>>[
      for (final entry in _subscriptions.entries)
        buildSubscribeFrame(entry.key, entry.value.functionPath, entry.value.args, sinceSeq: entry.value.cursor, sinceEpoch: entry.value.epoch),
      // BOTH registries. A resend that walks only the queries leaves every shape
      // view subscribed to a socket that no longer exists, so after the first
      // drop it stops receiving pokes forever and nothing says so.
      ..._shapeRegistry.resendFrames(),
    ];

    for (final frame in frames) {
      sender(frame);
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
        final entry = id == null ? null : _subscriptions[id];
        final Object? value;

        try {
          value = decodeWire(frame['data'] ?? frame['delta']);
        } on WireFormatException catch (error) {
          // A malformed payload belongs on the subscription's error callback,
          // not on the socket read loop's stack. Letting it escape ended that
          // loop — and with it every OTHER subscription on this client — over one
          // bad frame.
          entry?.onError?.call(LunoraSubscriptionError('INVALID_FRAME', error.message));

          return 'error';
        }

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
          _shapeRegistry.reportError(id, error);
        }

        return kind;
      case 'complete':
        if (id != null) {
          _subscriptions.remove(id);
        }

        return kind;
      case 'pokeStart':
        _shapeRegistry.beginPoke(frame);

        return kind;
      case 'pokePart':
        _shapeRegistry.bufferPokePart(frame);

        return kind;
      case 'pokeEnd':
        _shapeRegistry.applyPoke(frame);

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

  /// Replay one shard's queued writes, oldest first.
  ///
  /// Called for you on the transition to connected; public because a caller that
  /// knows connectivity came back some other way may want to trigger it. See
  /// [OfflineReplayer], which owns the ordering and classification rules.
  ///
  /// Returns the milliseconds the server asked the caller to wait before
  /// flushing again, when a replay came back rate-limited, and null otherwise.
  /// The client enforces it too — a flush inside the window is a no-op — so this
  /// is for a caller that schedules its own retry.
  Future<int?> flushOfflineQueue({String? shardKey}) => _replayer.flush(shardKey: shardKey);

  // ─── Optimistic updates ───────────────────────────────────────────────────

  /// Register this write's optimistic layers and return their settle handles,
  /// in application order.
  List<OptimisticLayerHandle> _applyOptimistic(String functionPath, Object? args, LunoraOptimistic? optimistic, LunoraOptimisticUpdate? update) {
    final handles = <OptimisticLayerHandle>[];

    if (optimistic != null) {
      // EVERY subscription on this exact query, not just one — see [_matching].
      for (final entry in _matching(functionPath, args)) {
        final handle = applyOptimisticLayer(entry, optimistic);

        if (handle != null) {
          handles.add(handle);
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

  /// Every subscription watching `(functionPath, args)`.
  ///
  /// The single most subtle rule in this file — which queries a prediction
  /// applies to — so it lives in one place. The reference client de-duplicates
  /// subscriptions by key and therefore always finds at most one; this transport
  /// gives each `subscribe` call its own id, matching its sibling ports, so a
  /// query two widgets are watching has two states and both must see it.
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
        identity: transport.identityFingerprint(),
        // Stamped at enqueue and replayed under, so a write queued by this
        // session keeps its dedup namespace across a restart.
        clientId: transport.clientId,
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
      // A CONSTANT layer — see `optimistic.dart` for what that masks.
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
