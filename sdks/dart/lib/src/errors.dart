/// The coded errors the transport raises.
///
/// Their own file because both the client and the offline queue raise them, and
/// the queue must not import the client — the client imports the queue.
library;

/// A coded error: either an RPC error envelope from the server, or one of the
/// client-side terminal verdicts the offline queue produces.
///
/// The `code` is load-bearing beyond diagnostics. A replay classifies a failure
/// by whether it carries one: a coded error means the server answered and
/// rejected the write, which is terminal; an uncoded throw is a transport
/// failure, which is transient and re-queues.
class LunoraApiException implements Exception {
  const LunoraApiException(this.code, this.message, [this.data, this.transient = false]);

  final String code;
  final String message;
  final Object? data;

  /// The call never reached a verdict — a 5xx, or a non-2xx carrying no error
  /// envelope at all (an edge error page, a WAF block, a proxy).
  ///
  /// Set where the HTTP STATUS is still in scope, because nothing downstream can
  /// recover it: [code] alone cannot tell a `BAD_REQUEST` a function returned
  /// from the `INTERNAL` this client synthesises for a body that never came from
  /// one. Without it a flush of exactly ONE queued write dropped it terminally
  /// on a gateway blip, while the same response with two or more writes was
  /// already classified transient by the batch path — so whether a durable write
  /// survived depended on how deep the queue happened to be.
  final bool transient;

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

/// The queue was over `maxItems` and dropped its oldest entry.
const String offlineQueueOverflow = 'OFFLINE_QUEUE_OVERFLOW';

/// A queued write's `precondition` returned false just before replay, so the
/// write was discarded instead of being sent against state it no longer suits.
const String offlinePreconditionFailed = 'OFFLINE_PRECONDITION_FAILED';

/// The client was closed with writes still queued.
const String clientClosed = 'CLIENT_CLOSED';

/// A queued write's issuing identity no longer matches the client's, so it was
/// discarded rather than replayed as somebody else.
const String offlineIdentityChanged = 'OFFLINE_IDENTITY_CHANGED';

/// A queued write's args cannot be wire-encoded, so it can never succeed and was
/// settled terminally instead of re-queued.
///
/// Coded rather than surfaced as the raw codec exception, matching the sibling
/// ports: every other terminal drop here carries a code, and a consumer
/// classifying by exception type would need each language's codec error
/// hierarchy to spot this one.
const String offlineWriteUnencodable = 'OFFLINE_WRITE_UNENCODABLE';

/// Per-slot codes a batch reply uses for a shard or transport failure rather
/// than an application verdict — the server never decided anything about the
/// write.
///
/// They are the batch's counterpart of an uncoded throw on the single-call path,
/// and the distinction is load-bearing: a replay treats every OTHER coded error
/// as terminal, so without this list a shard that was briefly unreachable would
/// permanently reject a durable write the server never even saw.
const Set<String> transientBatchErrorCodes = <String>{'SHARD_ERROR', 'SHARD_UNAVAILABLE'};

/// Codes that say "not now" rather than "no".
///
/// A rate-limited replay is the one verdict a durable queue must never honour:
/// the write is perfectly valid and the server is asking for it later, so
/// dropping it loses data for being punctual. The delay comes from the
/// envelope's `data.retryAfterMs` — see `protocol/fixtures/rpc.json`'s
/// `responseError.with-data`.
const Set<String> rateLimitErrorCodes = <String>{'RATE_LIMITED', 'TOO_MANY_REQUESTS'};

/// The worker's answer to a request body over its 1 MiB cap
/// (`packages/runtime/src/body-readers.ts`).
///
/// Coded, so it arrives as a whole-batch envelope — and every OTHER coded
/// envelope is a verdict on every entry in the batch, while this one is a verdict
/// on none of them.
const String payloadTooLarge = 'PAYLOAD_TOO_LARGE';

/// A restored record's args are not readable as wire values — the store was
/// corrupted, or written by an incompatible build.
///
/// Terminal: the record is purged and settled under this code rather than
/// replayed with substitute args, which would commit a DIFFERENT write than the
/// caller made.
const String offlineWriteUndecodable = 'OFFLINE_WRITE_UNDECODABLE';

/// Whether a failed replay may be retried, or is a verdict on the write.
///
/// An uncoded throw is a transport failure and always transient. A coded one is
/// transient when the status said so ([LunoraApiException.transient]), when the
/// shard never reached the write, or when the server asked for it later.
bool isTransientFailure(Object error) =>
    error is! LunoraApiException || error.transient || transientBatchErrorCodes.contains(error.code) || rateLimitErrorCodes.contains(error.code);

/// The longest delay a rate limit may hold a flush off for, matching the
/// reference client's own clamp.
///
/// The hint is the server's, but the ceiling is the client's: a limiter that
/// names an hour — a misconfiguration, a bug, a hostile intermediary — would
/// otherwise strand every durable write on the queue for that hour with nothing
/// able to shorten it.
const int maxRetryAfterMs = 60000;

/// How long a rate-limited replay asks the caller to wait, if the envelope said,
/// clamped to [maxRetryAfterMs].
///
/// Null when the server named no delay — the caller then picks its own backoff
/// rather than hammering.
///
/// `protocol/README.md` §4.3 also allows the hint to arrive as a `Retry-After`
/// HEADER in whole seconds. This port cannot read it: the injected
/// [LunoraHttpPoster] surfaces `(status, body)` only, and widening that contract
/// to carry headers would change every consumer's poster for a value the RPC
/// plane's rate-limit envelope already carries.
int? retryAfterMs(Object error) {
  if (error is! LunoraApiException || !rateLimitErrorCodes.contains(error.code)) {
    return null;
  }

  final data = error.data;
  final delay = data is Map<String, Object?> ? data['retryAfterMs'] : null;

  if (delay is! int || delay <= 0) {
    return null;
  }

  return delay < maxRetryAfterMs ? delay : maxRetryAfterMs;
}
