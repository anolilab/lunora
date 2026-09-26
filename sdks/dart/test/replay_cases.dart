/// How a flush classifies what the server sent back: routing, undecodable
/// results, the single-versus-batch predicate and the envelope-less 413.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

Map<String, Object?> _scenario(String name) => (fixture('offline-optimistic.json')['offlineQueue']! as Map<String, Object?>)[name]! as Map<String, Object?>;

List<String> _strings(Object? value) => (value! as List<Object?>).cast<String>();

/// A [MemoryPersistence] recording which ids were removed, in order.
class _RemovalLog extends MemoryPersistence {
  final List<String> removed = <String>[];

  @override
  Future<void> remove(String id) {
    removed.add(id);

    return super.remove(id);
  }
}

/// One flush of [queued] over [post], and everything a fixture asserts about it.
class _Run {
  _Run(this.post, {void Function(QueuedMutation entry, Object? error)? observe}) {
    queue = OfflineQueue(
      persistence: store,
      onSettled: (entry, error) {
        if (error is LunoraApiException) {
          codes[entry.id] = error.code;
        }

        observe?.call(entry, error);
      },
    );
    replayer = OfflineReplayer(
      transport: LunoraTransport(url: 'https://app.example', post: post),
      queue: queue,
      isClosed: () => false,
      isConnected: (_) => true,
    );
  }

  final LunoraHttpPoster post;
  final _RemovalLog store = _RemovalLog();
  late final OfflineQueue queue;
  late final OfflineReplayer replayer;
  final List<String> committed = <String>[];
  final List<String> rejected = <String>[];
  final Map<String, String> codes = <String, String>{};

  void enqueue(String id, {String? shardKey}) => queue.enqueue(
        QueuedMutation(
          id: id,
          functionPath: 'messages:send',
          args: const <String, Object?>{},
          shardKey: shardKey,
          onCommit: (_) => committed.add(id),
          onReject: (_) => rejected.add(id),
        ),
      );

  /// Flushes, letting the unawaited durable `append`s land first so only the
  /// flush's own removals are recorded.
  Future<void> flush() async {
    await Future<void>.delayed(Duration.zero);
    store.removed.clear();
    await replayer.flush();
    await Future<void>.delayed(Duration.zero);
  }

  List<String> get queued => <String>[for (final item in queue.items) item.id];

  List<String> decodeFailed(String code) => <String>[
        for (final entry in codes.entries)
          if (entry.value == code) entry.key,
      ];
}

/// A write refused for its CREDENTIAL is held, and a fresh token set for the
/// same user replays it — with no flush of the caller's own, because nothing
/// else would: the socket stays up, and only a reconnect flushes.
Future<void> caseHeldWriteReplaysAfterTokenRefresh() async {
  covers('offline_write_held_for_credential_replays_after_token_refresh');

  final scenario = _scenario('credentialRefresh');
  final identity = scenario['identity']! as String;
  final stale = scenario['staleToken']! as String;
  final refusal = scenario['refusal']! as Map<String, Object?>;
  final afterRefusal = scenario['afterRefusal']! as Map<String, Object?>;
  final afterRefresh = scenario['afterRefresh']! as Map<String, Object?>;
  final headers = <String>[];
  final committed = <String>[];
  final rejected = <String>[];
  final store = _RemovalLog();
  final queue = OfflineQueue(
    persistence: store,
    onSettled: (entry, error) => (error == null ? committed : rejected).add(entry.id),
  );
  final client = LunoraClient(
    url: 'https://app.example',
    authToken: stale,
    authSubject: identity,
    offlineQueue: queue,
    post: (url, sent, body) async {
      headers.add(sent['authorization'] ?? '');

      return sent['authorization'] == 'Bearer $stale'
          ? LunoraHttpResponse(refusal['status']! as int, jsonEncode(refusal['body']))
          : const LunoraHttpResponse(200, '{"result":null}');
    },
  )
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  for (final id in _strings(scenario['queued'])) {
    unawaited(client.mutation('messages:send', args: const <String, Object?>{}, mutationId: id).then((_) {}, onError: (_) {}));
  }

  client.setConnected(true);
  await Future<void>.delayed(Duration.zero);

  List<String> queued() => <String>[for (final item in queue.items) item.id];

  equals(canonical(committed), canonical(afterRefusal['committed']), 'a refused credential commits nothing');
  equals(canonical(rejected), canonical(afterRefusal['rejected']), 'and settles nothing');
  equals(canonical(queued()), canonical(afterRefusal['queuedAfterFlush']), 'the write is held');
  equals(store.removed.length, 0, 'and stays persisted');

  // A refresh: the new token, and the subject set again beside it.
  client
    ..authToken = scenario['freshToken']! as String
    ..authSubject = identity;

  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);

  equals(canonical(committed), canonical(afterRefresh['committed']), 'the new token replays the held write by itself');
  equals(canonical(rejected), canonical(afterRefresh['rejected']), 'nothing is rejected');
  equals(canonical(queued()), canonical(afterRefresh['queuedAfterFlush']), 'nothing is left queued');
  equals(canonical(headers), canonical(scenario['authorizationHeaders']), 'the replay carries the token current when it is sent');
}

/// What a new token does to a held write, by what it can say about WHO holds it.
///
/// A token alone, with a subject set, may be a refresh or another user's
/// sign-in: the write is held, not sent under it. The same token with the
/// subject set again replays it; another subject rejects it without sending it.
/// With no subject at all the identity IS the token, so a new one is a different
/// identity and the write is rejected, as the reference client rejects it. A
/// write queued under a token before a subject named it replays once one does.
Future<void> caseTokenChangeGatesHeldWrites() async {
  const refusal = LunoraHttpResponse(401, '{"error":{"code":"TOKEN_EXPIRED","message":"expired"}}');

  Future<(LunoraClient, List<String>, List<String>)> held({String? subject}) async {
    final sent = <String>[];
    final settled = <String>[];
    final client = LunoraClient(
      url: 'https://app.example',
      authToken: 'stale',
      authSubject: subject,
      offlineQueue: OfflineQueue(onSettled: (entry, error) => settled.add(error == null ? 'committed' : (error as LunoraApiException).code)),
      post: (url, headers, body) async {
        sent.add(headers['authorization'] ?? '');

        return headers['authorization'] == 'Bearer stale' ? refusal : const LunoraHttpResponse(200, '{"result":null}');
      },
    )
      ..attachSocket((_) {})
      ..setConnected(true)
      ..setConnected(false);
    unawaited(client.mutation('messages:send', args: const <String, Object?>{}).then((_) {}, onError: (_) {}));

    client.setConnected(true);
    await Future<void>.delayed(Duration.zero);

    return (client, sent, settled);
  }

  Future<void> settle() async {
    for (var index = 0; index < 3; index += 1) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  final (unconfirmed, unconfirmedSent, unconfirmedSettled) = await held(subject: 'user-a');

  unconfirmed.authToken = 'fresh';
  await settle();
  equals(canonical(unconfirmedSent), canonical(<String>['Bearer stale']), 'a token alone does not send the write under it');
  equals(canonical(unconfirmedSettled), canonical(<String>[]), 'and does not settle it');
  equals(unconfirmed.pendingWrites, 1, 'it is held');

  unconfirmed.authSubject = 'user-a';
  await settle();
  equals(canonical(unconfirmedSent), canonical(<String>['Bearer stale', 'Bearer fresh']), 'the subject set again replays it');
  equals(canonical(unconfirmedSettled), canonical(<String>['committed']), 'and it commits');

  final (switched, switchedSent, switchedSettled) = await held(subject: 'user-a');

  switched
    ..authToken = 'fresh'
    ..authSubject = 'user-b';
  await settle();
  equals(canonical(switchedSent), canonical(<String>['Bearer stale']), 'another user\'s token never carries the write');
  equals(canonical(switchedSettled), canonical(<String>[offlineIdentityChanged]), 'it is rejected');

  final (bare, bareSent, bareSettled) = await held();

  bare.authToken = 'fresh';
  await settle();
  equals(canonical(bareSent), canonical(<String>['Bearer stale']), 'with no subject a new token is a new identity: nothing is sent');
  equals(canonical(bareSettled), canonical(<String>[offlineIdentityChanged]), 'and the write is rejected, as the reference rejects it');

  final namedSent = <String>[];
  final namedSettled = <String>[];
  final named = LunoraClient(
    url: 'https://app.example',
    authToken: 'fresh',
    offlineQueue: OfflineQueue(onSettled: (entry, error) => namedSettled.add(error == null ? 'committed' : (error as LunoraApiException).code)),
    post: (url, headers, body) async {
      namedSent.add(headers['authorization'] ?? '');

      return const LunoraHttpResponse(200, '{"result":null}');
    },
  )
    ..attachSocket((_) {})
    ..setConnected(true)
    ..setConnected(false);

  unawaited(named.mutation('messages:send', args: const <String, Object?>{}).then((_) {}, onError: (_) {}));
  named
    ..authSubject = 'user-a'
    ..setConnected(true);
  await settle();
  equals(canonical(namedSent), canonical(<String>['Bearer fresh']), 'queued under the token a subject now names: sent once');
  equals(canonical(namedSettled), canonical(<String>['committed']), 'and committed, not rejected as another identity');
}

/// An EMPTY shard key is the default shard on BOTH replay paths: no body the
/// flush sends — a single call or a batch entry — may carry a `shardKey` at all.
Future<void> caseEmptyShardKeyRoutesToDefault() async {
  covers('offline_flush_empty_shard_key_routes_to_default');

  final scenario = _scenario('emptyShardKey');

  for (final path in <String>['batch', 'lone']) {
    final case_ = scenario[path]! as Map<String, Object?>;
    final poster = Poster(commitCursor: 1);
    final run = _Run(poster.call);

    for (final entry in objectList(case_['queued'])) {
      run.enqueue(entry['id']! as String, shardKey: entry['shardKey'] as String?);
    }

    await run.flush();

    equals(canonical(run.committed), canonical(case_['committed']), '$path: every write commits on the default shard');

    final sent = <Map<String, Object?>>[
      for (final (index, body) in poster.bodies.indexed)
        if (body.containsKey('calls')) ...poster.callsAt(index) else body,
    ];

    equals(sent.length, run.committed.length, '$path: every write was sent');

    for (final body in sent) {
      check(!body.containsKey('shardKey'), '$path: a request body carries shardKey ${jsonEncode(body['shardKey'])} for an empty shard key');
    }
  }
}

/// A write the server COMMITTED whose result does not decode is committed: it
/// settles once, carrying the coded decode error, and is never retried. In a
/// batch the bad slot settles alone and every other slot settles as usual.
Future<void> caseUndecodableResultSettlesCommitted() async {
  covers('offline_flush_undecodable_result_settles_committed');

  final scenario = _scenario('undecodableResult');
  final raw = jsonEncode(scenario['rawResult']);
  final code = scenario['code']! as String;
  final batch = scenario['batch']! as Map<String, Object?>;
  final badSlot = batch['undecodableSlot']! as int;
  final batchIds = _strings(batch['queued']);
  final poster = Poster()
    ..batchReply = '{"results":[${<String>[
      for (var index = 0; index < batchIds.length; index += 1) '{"id":$index,"body":{"result":${index == badSlot ? raw : '"ok"'},"commitCursor":${index + 1}}}',
    ].join(',')}]}';
  final batchRun = _Run(poster.call);

  batchIds.forEach(batchRun.enqueue);

  try {
    await batchRun.flush();
  } on Object catch (error) {
    failures.add('batch: the flush threw $error instead of settling the undecodable slot');
  }

  _assertSettled('batch', batchRun, batch, code);

  final lone = scenario['lone']! as Map<String, Object?>;
  final lonePoster = Poster(result: raw, commitCursor: 1);
  final loneRun = _Run(lonePoster.call);

  _strings(lone['queued']).forEach(loneRun.enqueue);
  await loneRun.flush();
  _assertSettled('lone', loneRun, lone, code);
  await loneRun.flush();
  equals(lonePoster.bodies.length, lone['requestsAfterSecondFlush'], 'lone: a second flush sends nothing');
}

void _assertSettled(String path, _Run run, Map<String, Object?> case_, String code) {
  equals(canonical(run.committed), canonical(case_['committed']), '$path: every write is committed');
  equals(canonical(run.decodeFailed(code)), canonical(case_['decodeFailed']), '$path: the undecodable write settles carrying $code');
  equals(canonical(run.rejected), canonical(case_['rejected']), '$path: nothing is rejected');
  equals(canonical(run.queued), canonical(case_['queuedAfterFlush']), '$path: nothing is left queued');
  equals(canonical(run.store.removed), canonical(case_['persistRemoveCalls']), '$path: every durable record is removed');
}

/// ONE predicate for both replay paths: a coded envelope by its code whatever
/// the status, an envelope-less reply by its status.
Future<void> caseReplayClassifiesSingleAndBatchAlike() async {
  covers('offline_flush_classifies_single_and_batch_alike');

  final scenario = _scenario('replayClassification');
  final paths = scenario['paths']! as Map<String, Object?>;

  for (final case_ in objectList(scenario['cases'])) {
    final body = case_.containsKey('rawBody') ? case_['rawBody']! as String : jsonEncode(case_['body']);

    for (final path in <String>['single', 'batch']) {
      final ids = _strings(paths[path]);
      final run = _Run((url, headers, sent) async => LunoraHttpResponse(case_['status']! as int, body));
      final what = '${case_['name']} ($path)';

      ids.forEach(run.enqueue);
      await run.flush();

      if (case_['outcome'] == 'rejected') {
        equals(canonical(run.rejected), canonical(ids), '$what: every write is rejected');
        equals(canonical(run.codes.values.toList()), canonical(<Object?>[for (final _ in ids) case_['code']]), '$what: with the envelope\'s code');
        equals(canonical(run.queued), canonical(<String>[]), '$what: nothing is re-queued');
      } else {
        equals(canonical(run.queued), canonical(ids), '$what: every write is re-queued, in order');
        equals(canonical(run.rejected), canonical(<String>[]), '$what: nothing is rejected');
        equals(canonical(run.store.removed), canonical(<String>[]), '$what: no durable record is removed');
      }
    }
  }
}

/// A 413 is a verdict on the REQUEST, envelope or not: a batch splits on any
/// 413, and a lone write still refused settles terminally.
Future<void> caseBatchSplitsOnEnvelopelessPayloadTooLarge() async {
  covers('offline_flush_batch_splits_on_envelopeless_413');

  final scenario = _scenario('envelopelessPayloadTooLarge');
  final refusal = LunoraHttpResponse(413, scenario['rawBody']! as String);

  for (final name in <String>['split', 'alwaysRefused', 'lone']) {
    final case_ = scenario[name]! as Map<String, Object?>;
    final refuseAbove = name == 'split' ? case_['refuseCallsAbove']! as int : -1;
    final accept = Poster(commitCursor: 1);
    final run = _Run((url, headers, body) async {
      final calls = (jsonDecode(body) as Map<String, Object?>)['calls'];
      final count = calls is List ? calls.length : 1;

      return count > refuseAbove ? refusal : accept.call(url, headers, body);
    });

    _strings(case_['queued']).forEach(run.enqueue);
    await run.flush();

    equals(canonical(run.committed), canonical(case_['committed']), '$name: committed');
    equals(canonical(run.rejected), canonical(case_['rejected']), '$name: rejected');
    equals(canonical(run.queued), canonical(case_['queuedAfterFlush']), '$name: nothing loops back onto the queue');

    for (final id in _strings(case_['rejected'])) {
      equals(run.codes[id], scenario['code'], '$name: $id settles with the 413 verdict');
    }
  }
}

/// A flush never loses a drained write. An unexpected exception inside the
/// replay loop — here the consumer's own `onSettled` observer throwing on the
/// first settle — must neither escape the flush (it runs unawaited from
/// `setConnected`, so an escape is an unhandled async error that kills the
/// isolate) nor strand the writes it had drained but not yet settled: they go
/// back on the queue, in order.
Future<void> caseUnexpectedFailureRequeuesUnsettledWrites() async {
  var thrown = false;
  final poster = Poster(commitCursor: 1);
  final run = _Run(poster.call, observe: (entry, error) {
    if (!thrown) {
      thrown = true;

      throw StateError('observer failed');
    }
  });

  <String>['u1', 'u2', 'u3'].forEach(run.enqueue);

  try {
    await run.flush();
  } on Object catch (error) {
    failures.add('an unexpected failure escaped the flush: $error');
  }

  equals(canonical(run.committed.take(1).toList()), canonical(<String>['u1']), 'the first write settled before the failure');
  equals(canonical(run.queued), canonical(<String>['u2', 'u3']), 'the drained writes it never settled are back on the queue, in order');
}
