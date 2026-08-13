// Runs a generated call, rather than only analysing one.
//
// `dart analyze` proves the shapes line up. It does not prove a call reaches the
// wire: Java shipped a surface that compiled and threw on the first invocation,
// Ruby one whose every method raised NoMethodError, and Rust one that sent
// `"limit": null` for an unset optional — all three with the compile-or-parse
// gate green.
//
// That last one is exactly what this leg guards. quicktype's Dart `toJson()`
// emits EVERY field, so `MessagesListArgs(channelId: …)` with no `limit`
// produces `{"channelId": "chan_1", "limit": null}` — and `v.optional()` rejects
// an explicit null. The assertion below is on the frame, so it fails if the
// pruning in `LunoraClient.wireValue` is ever dropped.
//
// `sdks/generated-check.sh dart` copies this into a throwaway consumer package
// whose pubspec carries the one stanza a real consumer writes:
//
//     dependencies:
//       lunora_sdk:
//         path: ../sdk
//
// That is why the import below names `package:lunora_sdk` and not this repo: the
// point of the check is that the generated SDK resolves from OUTSIDE the
// monorepo, where `sdks/dart` is not on any search path.

import 'dart:convert';

import 'package:lunora_sdk/lunora_api.dart';

Future<void> main() async {
  String? captured;

  final client = LunoraClient(
    url: 'https://app.example',
    post: (url, headers, body) async {
      captured = body;

      return const LunoraHttpResponse(200, '{"result":{"ok":true}}');
    },
  );

  await Api(client).messages.list(MessagesListArgs(channelId: 'chan_1'));

  final body = captured;

  if (body == null) {
    throw StateError('the poster was never called');
  }

  final got = stableStringify(jsonDecode(body));
  const want = '{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}';

  if (got != want) {
    throw StateError('generated call produced $got, want $want');
  }

  print('OK — the generated surface reaches the wire');
}
