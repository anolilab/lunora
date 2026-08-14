/// Optimistic updates: layering, rebasing and the cursor-gated drop.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

/// One named scenario from the `optimistic` block of
/// `protocol/fixtures/offline-optimistic.json`.
///
/// The manifest cases below read every expectation from there rather than
/// writing their own, so this port and the seven siblings assert the same
/// values instead of each documenting its own behaviour.
Map<String, Object?> _scenario(String name) => (fixture('offline-optimistic.json')['optimistic']! as Map<String, Object?>)[name]! as Map<String, Object?>;

/// The minimal [OptimisticTarget] the engine folds over — the same shape the
/// client's subscription presents, with none of its bookkeeping.
///
/// The fixture asserts LAYER COUNTS as well as displayed values, and a layer
/// count is engine state the client does not expose. So the manifest cases drive
/// the engine directly, exactly as the sibling ports' do; the client-level cases
/// further down cover the wiring.
class _Target implements OptimisticTarget {
  _Target(this.serverBase) : lastValue = serverBase;

  @override
  Object? serverBase;

  @override
  Object? lastValue;

  @override
  bool delivered = false;

  @override
  int? serverCursor;

  @override
  List<OptimisticLayer> layers = <OptimisticLayer>[];

  final List<Object?> seen = <Object?>[];

  @override
  void deliver(Object? value) => seen.add(value);
}

/// The one transform primitive the fixtures use: push onto a COPY of the list.
///
/// A copy, not an in-place add: a transform is re-run on every rebase, so one
/// that mutated its input would compound its own effect on each server frame.
LunoraOptimistic _appender(Object? item) => (current) => <Object?>[...(current as List<Object?>? ?? const <Object?>[]), item];

/// Apply one server `data` frame the way the client's frame handler does.
void _frame(_Target target, Map<String, Object?> frame) {
  target
    ..serverBase = frame['data']
    ..serverCursor = frame['cursor'] as int?;
  dropConfirmedLayers(target, target.serverCursor);
  notifyTarget(target, foldOptimistic(target.serverBase, target.layers));
}

// ─── Optimistic updates: the shared golden scenarios ─────────────────────────

/// A pending layer is re-folded onto each new authoritative base rather than
/// clobbered by it.
void caseGoldenOptimisticRebase() {
  covers('optimistic_layer_rebases_onto_server_frame');

  final case_ = _scenario('rebase');
  final target = _Target(case_['base']);

  applyOptimisticLayer(target, _appender(case_['appended']));

  equals(canonical(target.lastValue), canonical(case_['displayedAfterApply']), 'the optimistic value shows immediately');

  _frame(target, case_['frame']! as Map<String, Object?>);

  equals(canonical(target.lastValue), canonical(case_['displayedAfterFrame']), 'the pending layer rebases onto the new base');
  equals(target.layers.length, case_['layersAfterFrame'], 'an unconfirmed layer survives the frame');
}

/// The overlay drops on the server-confirmed CDC cursor, never on RPC-response
/// timing — and gaplessly, so the confirming frame does not double-count.
void caseGoldenOptimisticCommitCursorDrop() {
  covers('optimistic_layer_drops_on_commit_cursor');

  final case_ = _scenario('commitCursorDrop');
  final target = _Target(case_['base']);

  final handle = applyOptimisticLayer(target, _appender(case_['appended']));

  check(handle != null, 'the layer applies');
  handle!.confirm(case_['commitCursor'] as int?);

  _frame(target, case_['belowFrame']! as Map<String, Object?>);

  equals(canonical(target.lastValue), canonical(case_['displayedAfterBelowFrame']), 'a frame short of the commit cursor keeps the overlay');
  equals(target.layers.length, case_['layersAfterBelowFrame'], 'and keeps the layer');

  _frame(target, case_['atFrame']! as Map<String, Object?>);

  equals(canonical(target.lastValue), canonical(case_['displayedAfterAtFrame']), 'the confirming frame drops the overlay with no double-count');
  equals(target.layers.length, case_['layersAfterAtFrame'], 'and the layer is gone');
}

/// Failure re-folds, so the bad value disappears immediately.
void caseGoldenOptimisticRollback() {
  covers('optimistic_layer_rolls_back_on_failure');

  final case_ = _scenario('rollback');
  final target = _Target(case_['base']);

  final handle = applyOptimisticLayer(target, _appender(case_['appended']));

  check(handle != null, 'the layer applies');
  handle!.rollback();

  equals(canonical(target.lastValue), canonical(case_['displayedAfterRollback']), 'the failed write rolls its overlay back');
  equals(target.layers.length, case_['layersAfterRollback'], 'and leaves no layer behind');
}

/// `cursor` is OPTIONAL on a data frame, and one that omits it must LEAVE the
/// tracked cursor where it was.
///
/// Driven through the real client rather than the engine: the guard is in the
/// frame handler, and nulling the cursor there strands every pending layer —
/// the tracked cursor is what a later `commitCursor` is compared against, so a
/// confirm that should drop the overlay keeps it and the write renders twice.
/// The proof is that confirm drops it, which is only possible if the cursor
/// survived the cursorless frame.
Future<void> caseGoldenOptimisticCursorlessFrame() async {
  covers('optimistic_cursorless_frame_preserves_cursor');

  final case_ = _scenario('cursorlessFrame');
  final gate = Completer<void>();
  final seen = <Object?>[];

  // A poster that holds the mutation's response open, so the frames below land
  // while the write is still in flight and its layer still pending.
  Future<LunoraHttpResponse> post(String url, Map<String, String> headers, String body) async {
    await gate.future;

    return LunoraHttpResponse(200, '{"result":null,"commitCursor":${case_['commitCursor']}}');
  }

  final client = LunoraClient(url: 'https://app.example', post: post)
    ..attachSocket((_) {})
    ..setConnected(true);

  client.subscribe('counter:value', onData: seen.add);
  pushData(client, 'sub_1', case_['base'], cursor: 1);

  final write = client.mutation('counter:value', optimistic: _appender(case_['appended']));

  final cursored = case_['cursoredFrame']! as Map<String, Object?>;
  final cursorless = case_['cursorlessFrame']! as Map<String, Object?>;

  pushData(client, 'sub_1', cursored['data'], cursor: cursored['cursor'] as int?);
  pushData(client, 'sub_1', cursorless['data']);

  equals(canonical(seen.last), canonical(case_['displayedAfterCursorlessFrame']), 'the pending layer still folds onto the cursorless frame');

  gate.complete();
  await write;

  // If the cursorless frame had reset the tracked cursor, this confirm would
  // have nothing to compare against, the layer would survive, and the display
  // would still carry the doubled value asserted above.
  equals(canonical(seen.last), canonical(cursorless['data']), 'the confirm drops the overlay, so the cursorless frame preserved the cursor');
}

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
