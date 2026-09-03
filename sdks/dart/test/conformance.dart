/// Protocol-conformance suite: drives the Dart SDK against the shared golden
/// fixtures in `protocol/fixtures/`, the same files the TypeScript client and
/// every sibling port are tested against.
///
/// A plain `main()` rather than a `package:test` suite, matching the java and
/// kotlin legs. `package:test` is not in the SDK, so depending on it would make
/// this package's `dart pub get` reach pub.dev — and the transport is defined to
/// have no dependencies at all (see `pubspec.yaml`). The end of `main` is the
/// after-all hook the manifest check needs, which is the one thing XCTest and
/// libtest could not give the swift and rust ports.
///
/// The cases live beside this file, one module per area; this one is the runner.
///
/// Run it with `dart run test/conformance.dart`, or through `sdks/run-all.sh`.
library;

import 'dart:convert';
import 'dart:io';

import 'frame_cases.dart';
import 'harness.dart';
import 'key_cases.dart';
import 'model_cases.dart';
import 'offline_cases.dart';
import 'optimistic_cases.dart';
import 'rpc_cases.dart';
import 'wire_cases.dart';

// ─── Entry point ─────────────────────────────────────────────────────────────

Future<void> main() async {
  // Red until proven green, because Dart's failure mode here is silence: an
  // abandoned `main()` — a case awaiting a future nothing completes — drains the
  // event loop and exits 0 having printed nothing, which is exactly how this
  // suite once reported PASS with 16 of its 69 cases run. `exitCode` is the
  // status the VM uses when it falls off the end, so setting it here means every
  // path that does not reach the bottom of this function is a failure.
  exitCode = 1;

  await run(caseWireCodecRoundTrip);
  await run(caseUndefinedIsDistinctFromNull);
  await run(caseOverLongBigIntRejected);
  await run(caseMalformedValuesRejected);
  await run(caseDepthCapEnforced);
  await run(caseExactIntegerRangeEnforced);
  await run(caseStableWireKeyFixtures);
  await run(caseFormatNumberMatchesEcmaScript);
  await run(caseKeyOrderMatchesUtf16);
  await run(caseStringEscapingMatchesJsonStringify);
  await run(caseErrorCauseRoundTrips);
  await run(caseEmptyShardKeyIsOmitted);
  await run(caseRpcRequestBodies);
  await run(caseRpcResponses);
  await run(caseNon2xxWithoutErrorEnvelopeFails);
  await run(caseClientFrameBuilders);
  await run(caseServerFrameConsumer);
  await run(caseSubscriptionStreamYieldsFrameValuesInOrder);
  await run(caseShapeSubscribeFrame);
  await run(caseShapeSubscriptionsResendAfterReconnect);
  await run(caseRefusedPayloadReachesTheSubscriptionNotTheReadLoop);
  await run(casePokeSequenceMaterialisesRows);
  await run(casePokePartsDoNotApplyBeforePokeEnd);
  await run(caseResetPokeReplacesTheView);
  await run(casePendingPokeBuffersAreBounded);
  await run(caseWireValuePassesModelJsonThrough);
  await run(caseWatchStreamUnsubscribesOnCancel);
  await run(caseWatchSupportsManyListenersAndReListening);
  await run(caseCallsAfterCloseFailFast);
  await run(caseReplayCarriesTheIssuingClientId);
  await run(caseRestoredWriteKeepsItsOriginalClientId);
  await run(caseHydrateAfterConnectingStillReplays);
  await run(caseCloseDuringAFlushSettlesDrainedWrites);
  await run(caseRestoredWriteVerdictsReachTheObserver);

  // The shared golden scenarios in protocol/fixtures/offline-optimistic.json,
  // which every port asserts the same values from — the manifest names below
  // are covered here.
  await run(caseGoldenOptimisticRebase);
  await run(caseGoldenOptimisticCommitCursorDrop);
  await run(caseGoldenOptimisticSettledFrameDrop);
  await run(caseGoldenOptimisticDecliningLayerSkipped);
  await run(caseGoldenOptimisticConfirmWithoutCursor);
  await run(caseGoldenOptimisticConstantMask);
  await run(caseGoldenOptimisticRollback);
  await run(caseGoldenOptimisticCursorlessFrame);
  await run(caseGoldenOfflineQueueFifo);
  await run(caseGoldenOfflineQueueShardDrain);
  await run(caseGoldenOfflineFlushBatchesMultipleWrites);
  await run(caseGoldenBatchEntryCapMatchesProtocol);
  await run(caseGoldenOfflineQueueRequeue);
  await run(caseGoldenOfflineQueueClear);
  await run(caseGoldenOfflineQueueOverflow);
  await run(caseGoldenOfflineQueuePrecondition);
  await run(caseGoldenOfflineQueueHydrate);
  await run(caseGoldenOfflineQueueHydrateOverflow);
  await run(caseGoldenOfflineQueueIdentityGate);
  await run(caseGoldenOfflineFlushReplay);
  await run(caseGoldenOfflineFlushUnencodableWrite);
  await run(caseTypedArgsSurviveASerialisingStore);
  await run(caseUndecodableRecordSettlesRejected);
  await run(caseBatchSplitsOnPayloadTooLarge);
  await run(caseLoneQueuedWriteSurvivesAnEnvelopeLess502);
  await run(caseRateLimitedReplayRequeuesAndDefers);
  await run(caseRateLimitedBatchSlotIsTransient);

  await run(caseOptimisticLayerRebasesOntoAServerFrame);
  await run(caseOptimisticLayerDropsOnItsCommitCursor);
  await run(caseSettledFrameDropsAConfirmedLayer);
  await run(caseOptimisticLayerRollsBackOnFailure);
  await run(caseOptimisticUpdatePatchesManyQueries);
  await run(caseThrowingOptimisticUpdateUnwindsOnlyItsOwnWrites);
  await run(caseFirstNullValueIsDelivered);

  await run(caseQueuedWritesReplayInOrderOnReconnect);
  await run(caseQueuedWriteKeepsItsOverlayUntilReplay);
  await run(caseQueueOverflowDropsTheOldest);
  await run(caseTransportFailureRequeuesTheRestInOrder);
  await run(caseCodedErrorIsTerminal);
  await run(caseBatchSlotsAreClassifiedIndependently);
  await run(caseBatchMissingSlotIsRetried);
  await run(caseWholeBatchRejectionIsTerminal);
  await run(casePreconditionFailureDiscardsBeforeReplay);
  await run(caseHydrateRestoresAheadOfThisSession);
  await run(caseIdentityChangeDiscardsQueuedWrites);
  await run(caseTokenDigestMatchesTheReferenceClient);
  await run(caseReconnectDuringAFlushIsNotLost);
  await run(caseCloseRejectsPendingWrites);

  // The after-all hook. Adding a name to protocol/conformance-cases.json turns
  // this leg red until a case actually executes under it — the evidence is the
  // `covers` call inside the case, never a list of names this file claims.
  final manifest = jsonDecode(File('${protocolDirectory.path}/conformance-cases.json').readAsStringSync()) as Map<String, Object?>;
  final required = (manifest['required'] as List<Object?>).cast<String>();

  check(required.isNotEmpty, 'the manifest must list at least one required case');

  for (final name in required) {
    check(covered.contains(name), 'protocol/conformance-cases.json requires case $name, which this run did not exercise');
  }

  if (failures.isEmpty) {
    exitCode = 0;
    stdout.writeln('PASS  $executed cases, covering all ${required.length} in the shared manifest');
    return;
  }

  for (final failure in failures) {
    stderr.writeln('FAIL  $failure');
  }

  exit(1);
}
