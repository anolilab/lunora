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

/// Per-slot codes a batch reply uses for a shard or transport failure rather
/// than an application verdict — the server never decided anything about the
/// write.
///
/// They are the batch's counterpart of an uncoded throw on the single-call path,
/// and the distinction is load-bearing: a replay treats every OTHER coded error
/// as terminal, so without this list a shard that was briefly unreachable would
/// permanently reject a durable write the server never even saw.
const Set<String> transientBatchErrorCodes = <String>{'SHARD_ERROR', 'SHARD_UNAVAILABLE'};
