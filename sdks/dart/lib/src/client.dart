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

import 'key.dart';
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

/// A coded error from an RPC error envelope.
class LunoraApiException implements Exception {
  const LunoraApiException(this.code, this.message, [this.data]);

  final String code;
  final String message;
  final Object? data;

  @override
  String toString() => '$code: $message';
}

/// A subscription-scoped error the server pushed.
class LunoraSubscriptionError {
  const LunoraSubscriptionError(this.code, this.message);

  final String? code;
  final String message;

  @override
  String toString() => '${code ?? 'ERROR'}: $message';
}

class _Subscription {
  _Subscription(this.functionPath, this.args, this.onData, this.onError);

  final String functionPath;
  final Object? args;
  final LunoraDataCallback? onData;
  final LunoraErrorCallback? onError;
  Object? cursor;
  Object? epoch;
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
  LunoraClient({required String url, LunoraHttpPoster? post, this.authToken})
      : _baseUrl = url,
        _post = post;

  final String _baseUrl;
  final LunoraHttpPoster? _post;

  /// The bearer token sent on every RPC. Rotate it at any time; the next call
  /// picks it up.
  String? authToken;

  LunoraFrameSender? _send;
  final Map<String, _Subscription> _subscriptions = <String, _Subscription>{};
  final Map<String, _ShapeSubscription> _shapes = <String, _ShapeSubscription>{};
  final Map<String, Map<String, List<Map<String, Object?>>>> _pokes = <String, Map<String, List<Map<String, Object?>>>>{};
  int _nextId = 0;
  int _nextShapeId = 0;

  /// Registers the sender used for subscription frames. Call once the socket is
  /// open.
  void attachSocket(LunoraFrameSender sender) {
    _send = sender;
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

  Future<Object?> query(String functionPath, {Object? args, String? shardKey}) => _rpc(functionPath, args: args, shardKey: shardKey);

  Future<Object?> mutation(String functionPath, {Object? args, String? shardKey, String? mutationId}) =>
      _rpc(functionPath, args: args, shardKey: shardKey, mutationId: mutationId);

  /// Same envelope as a mutation, but never an idempotency key: an action
  /// performs external side effects and is not replayed against the shard, so
  /// claiming mutation-style de-duplication for it would be a lie.
  Future<Object?> action(String functionPath, {Object? args, String? shardKey}) => _rpc(functionPath, args: args, shardKey: shardKey);

  Future<Object?> _rpc(String functionPath, {Object? args, String? shardKey, String? mutationId}) async {
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

    return parseRpcResponse(decoded is Map<String, Object?> ? decoded : const <String, Object?>{}, status: response.status);
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
          _advance(entry, frame);
          entry.onData?.call(value);
        }

        return kind;
      case 'resume':
      case 'settled':
        final entry = id == null ? null : _subscriptions[id];

        if (entry != null) {
          _advance(entry, frame);
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

/// The stable subscription key for a call, as `protocol/README.md` §3 defines
/// it. Exposed because a caller de-duplicating its own subscriptions needs the
/// same key the server and the reference client compute.
String lunoraSubscriptionKey(String functionPath, Object? args, {String? shardKey}) => '$functionPath::${stableWireKey(args)}::${shardKey ?? ''}';
