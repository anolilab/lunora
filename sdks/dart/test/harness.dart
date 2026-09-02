/// Shared machinery for the conformance suite: the assertion helpers, the
/// fixture loader, and the doubles every case builds on.
///
/// Split out because the case files import it, and Dart privacy is per-FILE —
/// so `failures` and `covered` are library-public here rather than underscored.
/// The suite is held together by `conformance.dart`, which owns `main()` and the
/// manifest check.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:lunora/lunora.dart';

/// Every assertion that did not hold. `main()` prints them and exits non-zero.
final List<String> failures = <String>[];

/// The manifest cases this run actually exercised.
final Set<String> covered = <String>{};

/// How many cases this run executed. Counted rather than written down: a
/// hand-maintained total drifts the moment a case is added, and did.
int executed = 0;

/// Run one case, counting it. Every entry in `main()` goes through this, so the
/// summary line is derived from what actually ran.
///
/// The timeout is the gate, not a convenience. A case that awaits a future
/// nothing will ever complete does not hang this process: the isolate's event
/// loop simply drains, `main()` is abandoned part-way, and Dart exits 0 having
/// printed nothing — which is indistinguishable from a full green run. So a case
/// that outstays [caseTimeout] is recorded as a failure naming its ordinal, and
/// the run carries on to the ones after it.
const Duration caseTimeout = Duration(seconds: 30);

Future<void> run(FutureOr<void> Function() body) async {
  executed += 1;

  final ordinal = executed;

  try {
    await Future<void>.sync(body).timeout(caseTimeout);
  } on TimeoutException {
    failures.add('case #$ordinal did not complete within ${caseTimeout.inSeconds}s '
        '(count the `await run(...)` lines in conformance.dart to name it)');
  } on Object catch (error, stack) {
    // A case that THROWS is one failure, not the end of the run. Letting it
    // escape abandoned `main()` part-way: every case after it went unexecuted
    // and the manifest check never ran, so a regression in one area silently
    // stopped testing all the others.
    failures.add('case #$ordinal threw: $error\n$stack');
  }
}

/// Records that the named manifest case actually executed. The evidence is the
/// call, never a list of names a suite claims to cover.
void covers(String name) => covered.add(name);

void check(bool condition, String what) {
  if (!condition) {
    failures.add(what);
  }
}

void equals(Object? got, Object? want, String what) {
  if (got != want) {
    failures.add('$what\n     got: $got\n    want: $want');
  }
}

/// Re-serialises so two structures compare as text with a canonical key order,
/// independent of the order the fixture file happens to use.
String canonical(Object? value) => stableStringify(value);

void throws(void Function() body, String what) {
  try {
    body();
    failures.add('$what — expected a throw, got none');
  } on Object {
    // The throw is the assertion.
  }
}

late final Directory fixtures = _findFixtures();

Directory _findFixtures() {
  var directory = File.fromUri(Platform.script).parent;

  for (var hop = 0; hop < 8; hop += 1) {
    final candidate = Directory('${directory.path}/protocol/fixtures');

    if (candidate.existsSync()) {
      return candidate;
    }

    final parent = directory.parent;

    if (parent.path == directory.path) {
      break;
    }

    directory = parent;
  }

  throw StateError('could not locate protocol/fixtures');
}

/// The directory `protocol/conformance-cases.json` sits in.
Directory get protocolDirectory => fixtures.parent;

Map<String, Object?> fixture(String name) => jsonDecode(File('${fixtures.path}/$name').readAsStringSync()) as Map<String, Object?>;

List<Map<String, Object?>> objectList(Object? value) => (value as List<Object?>).cast<Map<String, Object?>>();

/// A poster that records what it was asked to send and answers from a script.
///
/// Batch-aware, because a flush of more than one write goes to
/// `/_lunora/rpc-batch` rather than `/_lunora/rpc`. By default it answers a batch
/// by echoing a success slot per call, so a case that does not care about
/// batching does not have to know about it.
class Poster {
  Poster({this.commitCursor, this.result = '{"ok":true}'});

  final List<String> urls = <String>[];
  final List<Map<String, Object?>> bodies = <Map<String, Object?>>[];
  final List<Map<String, String>> headers = <Map<String, String>>[];

  int? commitCursor;
  String result;

  /// Fail this many calls with an UNCODED throw — a transport failure.
  int transportFailures = 0;

  /// Answer this many calls with a coded error envelope — a server rejection.
  int codedFailures = 0;

  /// Answer the next batch with this body verbatim, instead of echoing success.
  String? batchReply;

  /// The function paths reached, in order, flattening a batch into its entries.
  List<String> get paths => <String>[
        for (final body in bodies)
          if (body['functionPath'] is String)
            body['functionPath']! as String
          else
            for (final call in (body['calls'] as List<Object?>? ?? const <Object?>[])) ((call! as Map<String, Object?>)['functionPath']! as String),
      ];

  /// The entries of the request at [index], for a batch.
  List<Map<String, Object?>> callsAt(int index) => (bodies[index]['calls']! as List<Object?>).map((call) => call! as Map<String, Object?>).toList();

  /// How many requests went to the batch endpoint.
  int get batchRequests => urls.where((url) => url.endsWith(lunoraRpcBatchPath)).length;

  Future<LunoraHttpResponse> call(String url, Map<String, String> sent, String body) async {
    urls.add(url);
    headers.add(sent);

    final decoded = jsonDecode(body) as Map<String, Object?>;

    bodies.add(decoded);

    if (transportFailures > 0) {
      transportFailures -= 1;

      throw const SocketFailure();
    }

    if (codedFailures > 0) {
      codedFailures -= 1;

      return const LunoraHttpResponse(400, '{"error":{"code":"CONFLICT","message":"nope"}}');
    }

    final cursor = commitCursor == null ? '' : ',"commitCursor":$commitCursor';

    if (decoded['calls'] is! List) {
      return LunoraHttpResponse(200, '{"result":$result$cursor}');
    }

    final reply = batchReply;

    if (reply != null) {
      batchReply = null;

      return LunoraHttpResponse(200, reply);
    }

    final slots = <String>[
      for (var index = 0; index < (decoded['calls']! as List<Object?>).length; index += 1) '{"id":$index,"body":{"result":$result$cursor}}',
    ];

    return LunoraHttpResponse(200, '{"results":[${slots.join(',')}]}');
  }
}

/// Records how a write settles, with the handlers attached AT CREATION.
///
/// A batch settles several callers in one turn, and a Dart Future that fails
/// before anything is listening becomes an unhandled async error — attaching the
/// `await` afterwards is too late. So every queued write a case does not
/// immediately await goes through this.
class Settled {
  Settled(Future<Object?> future) {
    done = future.then((result) => value = result, onError: (Object failure) => error = failure);
  }

  late final Future<void> done;
  Object? value;
  Object? error;

  String? get code => error is LunoraApiException ? (error! as LunoraApiException).code : null;
}

/// An uncoded failure, standing in for a dropped socket. Deliberately NOT a
/// [LunoraApiException]: the replay classifies terminal-versus-transient by
/// exactly that difference.
class SocketFailure implements Exception {
  const SocketFailure();
}

/// Push one `data` frame at [cursor] into [client] for subscription [id].
void pushData(LunoraClient client, String id, Object? data, {int? cursor}) {
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'data', 'id': id, 'data': data, if (cursor != null) 'cursor': cursor}));
}

/// A valueless frame — `resume`/`settled` carry a cursor and nothing else.
void pushCursorFrame(LunoraClient client, String id, String kind, {int? cursor}) {
  client.handleFrame(jsonEncode(<String, Object?>{'type': kind, 'id': id, if (cursor != null) 'cursor': cursor}));
}
