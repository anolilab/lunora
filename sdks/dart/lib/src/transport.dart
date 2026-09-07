/// The HTTP half of the client: where a deployment lives, who is calling, and
/// how one request is made.
///
/// Its own file because none of it is stateful in the way the rest of the client
/// is. It holds the origin, the injected poster and the two auth fields, and
/// every method over them is either pure or one round trip — so the replay
/// engine can take a transport and a queue as its two collaborators instead of
/// half a dozen injected closures.
library;

import 'dart:convert';

import 'errors.dart';
import 'offline_queue.dart' show nextMutationId;
import 'wire.dart';

/// The single endpoint every query/mutation/action posts to.
const String lunoraRpcPath = '/_lunora/rpc';

/// The batched-RPC endpoint, used only to replay a queued flush of more than one
/// write. See `protocol/README.md` §4.3.
const String lunoraRpcBatchPath = '/_lunora/rpc-batch';

/// Hard cap on entries in one batch, mirroring the worker's own. A Durable
/// Object replays a batch sequentially on its single thread, so an unbounded one
/// would pin a shard; a longer flush is chunked.
const int lunoraMaxBatchEntries = 500;

/// Byte budget for one batch body: the worker's own 1 MiB cap
/// (`packages/runtime/src/body-readers.ts`) less 64 KiB of headroom, written as
/// the subtraction so the derivation stays visible.
///
/// The entry cap alone is blind to size: 500 writes carrying bytes or long text
/// exceed a megabyte, the worker answers `413 PAYLOAD_TOO_LARGE`, and a
/// whole-batch coded envelope is a verdict on every entry — so a count-only
/// chunker settles 500 durable writes `rejected` that would each have committed
/// alone. The headroom covers the request line, the headers and the JSON framing
/// the per-entry estimate does not weigh. See `protocol/README.md` §4.3.
const int lunoraMaxBatchBytes = 1048576 - 65536;

/// The live-subscription endpoint.
const String lunoraWsPath = '/_lunora/ws';

/// One HTTP response, as the injected poster reports it.
class LunoraHttpResponse {
  const LunoraHttpResponse(this.status, this.body);

  final int status;
  final String body;
}

/// Performs one POST. Injected so the conformance suite runs with no network and
/// a consumer keeps its own HTTP stack, timeouts and retries.
typedef LunoraHttpPoster = Future<LunoraHttpResponse> Function(String url, Map<String, String> headers, String body);

/// What one RPC returned: the decoded value, and the CDC cursor the write
/// committed at when the server echoed one.
typedef LunoraRpcOutcome = ({Object? result, int? commitCursor});

/// The origin, the credentials and the one request shape everything else is
/// built from.
class LunoraTransport {
  LunoraTransport({required String url, this.post, this.authToken, this.authSubject, String? clientId})
      : baseUrl = url,
        clientId = clientId ?? _randomId();

  final String baseUrl;
  final LunoraHttpPoster? post;

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

  /// Identifies THIS client to the server's idempotency bookkeeping.
  ///
  /// Load-bearing for exactly-once, and only visible when it is missing. The
  /// shard namespaces a caller's idempotency row by its verified user id, and an
  /// ANONYMOUS caller has none — so it falls back to this id, and with neither it
  /// cannot deduplicate at all. Every retry path in the offline queue would then
  /// re-apply a write the server had already committed.
  ///
  /// Minted per client unless supplied. A queued write is stamped with the id
  /// that ISSUED it and replays under that one, so a restart cannot move a
  /// pending write into a different namespace.
  final String clientId;

  /// Whether a request can be made at all.
  bool get canSend => post != null;

  /// Builds the `POST /_lunora/rpc` body. `shardKey` is omitted when null, which
  /// routes to the default shard.
  static Map<String, Object?> buildRpcBody(String functionPath, Object? args, {String? shardKey}) {
    final body = <String, Object?>{'args': encodeWire(args ?? const <String, Object?>{}), 'functionPath': functionPath};

    // Empty means ABSENT, not "the shard named `''`". The runtime disagrees — it
    // takes any string as a named shard and routes `''` to its own Durable
    // Object — while this client treats `''` and null as one shard everywhere it
    // matches a subscription or drains the queue (see `sameShard`). Sending it
    // would split those two views: a write submitted with `''` would replay
    // against a different shard than the subscription it updated.
    if (shardKey != null && shardKey.isNotEmpty) {
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
  static Object? parseRpcResponse(Map<String, Object?> body, {required int status}) {
    final envelope = body['error'];

    if (envelope is Map<String, Object?>) {
      final data = envelope['data'];

      throw LunoraApiException(
        envelope['code'] is String ? envelope['code'] as String : 'INTERNAL',
        envelope['message'] is String ? envelope['message'] as String : 'request failed',
        data == null ? null : decodeWire(data),
        // A 5xx is the shard or the edge failing UNDER the call, not a verdict
        // on it, so a queued write replayed under the same idempotency key is
        // still good. See `isTransientFailure`.
        status >= 500,
      );
    }

    if (status < 200 || status > 299) {
      // No envelope at all, so this body never came from a Lunora function: an
      // edge error page, a WAF block, a proxy. Nothing reached the shard, which
      // makes it transport rather than a verdict — the batch path already
      // classified the identical response that way, and a lone queued write must
      // not be dropped for being alone.
      throw LunoraApiException('INTERNAL', 'HTTP $status without an error envelope', null, true);
    }

    return decodeWire(body['result']);
  }

  /// The headers every request carries.
  Map<String, String> requestHeaders({String? mutationId, String? issuedBy}) {
    final headers = <String, String>{'content-type': 'application/json', 'x-lunora-client-id': issuedBy ?? clientId};
    final token = authToken;

    if (token != null) {
      headers['authorization'] = 'Bearer $token';
    }
    // Per-entry in a batch, never on the outer request: a batch is one transport
    // hop but its entries are dispatched as independent single calls.
    if (mutationId != null) {
      headers['x-lunora-mutation-id'] = mutationId;
    }

    return headers;
  }

  /// Make one RPC. [issuedBy] overrides the client id, which a REPLAY needs: a
  /// restored write must land in the namespace that issued it.
  Future<LunoraRpcOutcome> rpc(String functionPath, {Object? args, String? shardKey, String? mutationId, String? issuedBy}) async {
    final poster = post;

    if (poster == null) {
      throw const LunoraApiException('INTERNAL', 'no HTTP poster configured');
    }

    final response = await poster(
      join(lunoraRpcPath),
      requestHeaders(mutationId: mutationId, issuedBy: issuedBy),
      jsonEncode(buildRpcBody(functionPath, args, shardKey: shardKey)),
    );
    final decoded = response.body.isEmpty ? null : jsonDecode(response.body);
    final body = decoded is Map<String, Object?> ? decoded : const <String, Object?>{};
    final cursor = body['commitCursor'];

    return (result: parseRpcResponse(body, status: response.status), commitCursor: cursor is int ? cursor : null);
  }

  /// The identity a queued write is stamped with, and gated on at replay.
  ///
  /// The TOKEN branch is digested rather than stored, because the stamp is
  /// written to durable storage and an app's queue file should not become
  /// somewhere a bearer token sits at rest. The digest is the reference client's
  /// — FNV-1a and djb2 side by side, delimited by the token's length so two
  /// distinct tokens cannot encode to one string through variable-width
  /// concatenation. An [authSubject] is stored as given: a user id identifies,
  /// it does not authenticate, so there is nothing there to protect.
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

  /// The socket URL: the origin with its scheme swapped, plus the shard and
  /// credential query parameters when present.
  String wsUrl({String? shardKey, String? token}) {
    var endpoint = join(lunoraWsPath);

    if (endpoint.startsWith('https://')) {
      endpoint = 'wss://${endpoint.substring('https://'.length)}';
    } else if (endpoint.startsWith('http://')) {
      endpoint = 'ws://${endpoint.substring('http://'.length)}';
    }

    final params = <String>[
      if (shardKey != null && shardKey.isNotEmpty) 'shard=${Uri.encodeQueryComponent(shardKey)}',
      if (token != null) 'token=${Uri.encodeQueryComponent(token)}',
    ];

    if (params.isEmpty) {
      return endpoint;
    }

    return '$endpoint${endpoint.contains('?') ? '&' : '?'}${params.join('&')}';
  }

  String join(String path) => '${baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl}$path';

  /// A process-unique id for [clientId] when the caller supplies none.
  static String _randomId() => nextMutationId();
}
