/// Optimistic updates: layering, rebasing and the cursor-gated drop.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── Optimistic updates ──────────────────────────────────────────────────────

/// A layer must survive an unrelated server frame, re-derived from the new base
/// rather than clobbered by it — the whole point of rebasing.
void caseOptimisticLayerRebasesOntoAServerFrame() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  final seen = <Object?>[];

  // Subscribed and mutated on the SAME path, which is what the per-call
  // `optimistic` targets — see `LunoraClient.mutation`.
  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  // No poster is configured, so the send fails and the layer never confirms —
  // which is the state under test: an unconfirmed layer must survive frames.
  unawaited(
    client.mutation('counter:value', optimistic: (current) => <Object?>[...(current! as List<Object?>), 'pending']).catchError((Object _) => null),
  );

  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'the optimistic value shows immediately');

  // An unrelated write lands. The layer has no commit cursor yet, so it must
  // re-fold onto the NEW base rather than be dropped or clobbered.
  pushData(client, 'sub_1', <Object?>['a', 'b'], cursor: 2);

  equals(canonical(seen.last), canonical(<Object?>['a', 'b', 'pending']), 'the pending layer rebases onto the new base');
}

/// The gapless drop: once a frame reaches the write's commit cursor the layer
/// comes off, because its effect is now in the base.
Future<void> caseOptimisticLayerDropsOnItsCommitCursor() async {
  final poster = Poster(commitCursor: 7, result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  await client.mutation('counter:value', optimistic: (current) => <Object?>[...(current! as List<Object?>), 'pending']);

  // Confirmed at cursor 7 but no frame has reached it, so the overlay stays.
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'a confirmed layer survives until a frame reaches its cursor');

  // A frame BEFORE the commit cursor must not drop it either.
  pushData(client, 'sub_1', <Object?>['a'], cursor: 6);
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'a frame short of the commit cursor keeps the layer');

  // The confirming frame carries the write, so the layer must come off — and
  // the value must NOT show 'pending' twice.
  pushData(client, 'sub_1', <Object?>['a', 'pending'], cursor: 7);
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending']), 'the confirming frame drops the layer with no double-count');

  // The proof the layer is really gone rather than merely producing the same
  // text: a later unrelated frame must show no residue of it. Asserted this way
  // and not on a delivery COUNT, because a re-fold builds a fresh list every
  // time — so the unchanged-value skip, which compares collections by identity
  // exactly as the reference client's `===` does, does not suppress it.
  pushData(client, 'sub_1', <Object?>['a', 'pending', 'c'], cursor: 8);
  equals(canonical(seen.last), canonical(<Object?>['a', 'pending', 'c']), 'no overlay residue after the layer is dropped');
}

/// A `settled` frame carries no value — the write's result was byte-identical —
/// but it still advances the cursor, so it must sweep confirmed layers too.
Future<void> caseSettledFrameDropsAConfirmedLayer() async {
  final poster = Poster(commitCursor: 4, result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  await client.mutation('counter:value', optimistic: (_) => <Object?>['a', 'ghost']);

  equals(canonical(seen.last), canonical(<Object?>['a', 'ghost']), 'the overlay is displayed');

  client.handleFrame(jsonEncode(<String, Object?>{'type': 'settled', 'id': 'sub_1', 'cursor': 4}));

  equals(canonical(seen.last), canonical(<Object?>['a']), 'a settled frame past the commit cursor releases the overlay');
}

/// A failed write must leave no trace.
Future<void> caseOptimisticLayerRollsBackOnFailure() async {
  final poster = Poster()..codedFailures = 1;
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final seen = <Object?>[];

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', <Object?>['a'], cursor: 1);

  try {
    await client.mutation('counter:value', optimistic: (_) => <Object?>['a', 'doomed']);
    failures.add('a rejected mutation should rethrow');
  } on LunoraApiException catch (error) {
    equals(error.code, 'CONFLICT', 'the server error reaches the caller');
  }

  equals(canonical(seen.last), canonical(<Object?>['a']), 'the failed write rolls its overlay back');
}

/// The multi-query path: one write patches every subscribed query it names.
Future<void> caseOptimisticUpdatePatchesManyQueries() async {
  final poster = Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final unread = <Object?>[];
  final list = <Object?>[];

  client.subscribe('messages:list', onData: list.add);
  client.subscribe('messages:unread', onData: unread.add);
  pushData(client, 'sub_1', <Object?>['a']);
  pushData(client, 'sub_2', 3);

  await client.mutation(
    'messages:send',
    optimisticUpdate: (store, _) {
      equals(canonical(store.getQuery('messages:list')), canonical(<Object?>['a']), 'getQuery reads the live value');
      store
        ..setQuery('messages:list', <Object?>['a', 'new'])
        ..setQuery('messages:unread', 4);
    },
  );

  equals(canonical(list.last), canonical(<Object?>['a', 'new']), 'the list query is patched');
  equals(unread.last, 4, 'the count query is patched in the same write');
}

/// A buggy update must not fail the mutation, and must not leave half a patch.
Future<void> caseThrowingOptimisticUpdateUnwindsOnlyItsOwnWrites() async {
  final poster = Poster(result: 'null');
  final client = LunoraClient(url: 'https://app.example', post: poster.call)
    ..attachSocket((_) {})
    ..setConnected(true);
  final list = <Object?>[];

  client.subscribe('messages:list', onData: list.add);
  pushData(client, 'sub_1', <Object?>['a']);

  await client.mutation(
    'messages:send',
    optimisticUpdate: (store, _) {
      store.setQuery('messages:list', <Object?>['a', 'half']);

      throw StateError('buggy update');
    },
  );

  equals(canonical(list.last), canonical(<Object?>['a']), 'the partial patch is unwound');
  equals(poster.paths.length, 1, 'the mutation still went out');
}

/// Dart has no `undefined`, so without the explicit delivered flag a query whose
/// first value is null would be suppressed as unchanged and never arrive.
void caseFirstNullValueIsDelivered() {
  final client = LunoraClient(url: 'https://app.example')..attachSocket((_) {});
  var deliveries = 0;

  client.subscribe('messages:list', onData: (_) => deliveries += 1);
  pushData(client, 'sub_1', null);
  pushData(client, 'sub_1', null);

  equals(deliveries, 1, 'a first null is delivered, and a second identical one is not');
}
