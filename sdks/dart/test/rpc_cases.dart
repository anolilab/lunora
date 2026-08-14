/// The HTTP RPC envelope.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'package:lunora/lunora.dart';

import 'harness.dart';

// ─── RPC ─────────────────────────────────────────────────────────────────────

void caseRpcRequestBodies() {
  covers('rpc_request_bodies');

  final request = fixture('rpc.json')['request'] as Map<String, Object?>;

  for (final testCase in objectList(request['cases'])) {
    final args = testCase.containsKey('args') ? testCase['args'] : decodeWire(testCase['argsWire']);
    final body = LunoraClient.buildRpcBody(testCase['functionPath'] as String, args, shardKey: testCase['shardKey'] as String?);

    equals(canonical(body), canonical(testCase['body']), 'rpc body for ${testCase['name']}');
  }
}

void caseRpcResponses() {
  covers('rpc_responses');

  final document = fixture('rpc.json');

  for (final testCase in objectList(document['responseOk'])) {
    final response = testCase['response'] as Map<String, Object?>;
    final value = LunoraClient.parseRpcResponse(response);

    equals(canonical(encodeWire(value)), canonical(response['result']), 'rpc result for ${testCase['name']}');
  }

  for (final testCase in objectList(document['responseError'])) {
    final response = testCase['response'] as Map<String, Object?>;

    try {
      LunoraClient.parseRpcResponse(response, status: 400);
      failures.add('${testCase['name']} — expected a LunoraApiException, got none');
    } on LunoraApiException catch (error) {
      equals(error.code, testCase['code'], 'error code for ${testCase['name']}');
      equals(error.message, testCase['message'], 'error message for ${testCase['name']}');

      if (testCase.containsKey('dataWire')) {
        equals(canonical(encodeWire(error.data)), canonical(testCase['dataWire']), 'error data for ${testCase['name']}');
      }
    }
  }
}

void caseNon2xxWithoutErrorEnvelopeFails() {
  covers('non_2xx_without_error_envelope_fails');

  // protocol/README.md §4.2. Without the status check this returned a null
  // result and threw nothing — the caller believes its mutation committed.
  throws(
    () => LunoraClient.parseRpcResponse(<String, Object?>{'message': 'bad gateway'}, status: 502),
    'a non-2xx with no error envelope must fail',
  );
}
