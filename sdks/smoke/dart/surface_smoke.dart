// Calls every function of the `sdk-surface` spec through a generated SDK.
//
// generated_smoke.dart proves a call reaches the wire. This proves the surface
// handles every SHAPE a model backend renders differently: a no-arg function,
// an object / id / number / array / record / null result, a nullable object,
// an array of objects, a union, an unset optional, bigint arguments and results
// (top level and nested), and keyword-named functions. A list, record or
// nullable result once went through `fromJson(… as Map)` and failed at run time
// ("List<Object?> is not a subtype of Map…", "Null is not a subtype…"), which
// `dart analyze` cannot see.
//
// Run by `sdks/generated-check.sh dart` from a consumer package outside this repo.

import 'dart:convert';

import 'package:lunora_sdk/lunora_api.dart';

const bigFive = r'["$lunora.wire$","bigint","5"]';

void expect(String what, Object? got, Object? want) {
  final gotKey = stableStringify(got);
  final wantKey = stableStringify(want);

  if (gotKey != wantKey) {
    throw StateError('$what: got $gotKey, want $wantKey');
  }
}

Future<void> main() async {
  final frames = <String>[];
  var reply = 'null';

  final client = LunoraClient(
    url: 'https://app.example',
    post: (url, headers, body) async {
      // Canonical JSON of the raw body, NOT `stableStringify` over it: the body
      // is already wire-encoded, and the key function would escape its tagged
      // arrays a second time.
      frames.add(_canonical(jsonDecode(body)));
      return LunoraHttpResponse(200, '{"result":$reply}');
    },
  );
  final api = Api(client);
  final items = api.items;
  final five = BigInt.from(5);

  reply = '2';
  expect('count', await items.count(<String, Object?>{}), 2);
  reply = '{"size":2,"title":"t"}';
  final summary = await items.summary(<String, Object?>{});
  expect('summary', '${summary.size} ${summary.title}', '2.0 t');
  reply = '{"title":"t","value":"x"}';
  final detail = await items.detail(<String, Object?>{});
  expect('detail', '${detail.title} ${detail.value}', 't x');
  reply = '"items_1"';
  expect('create', await items.create(ItemsCreateArgs(title: 't')), 'items_1');
  reply = 'null';
  expect('clear', await items.clear(<String, Object?>{}), null);
  reply = '["a"]';
  expect('tags', await items.tags(<String, Object?>{}), <Object?>['a']);
  reply = '["b"]';
  expect('labels', await items.labels(<String, Object?>{}), <Object?>['b']);
  reply = '{"a":1}';
  expect('stats', await items.stats(<String, Object?>{}), <String, Object?>{'a': 1});
  reply = '{"b":2}';
  expect('totals', await items.totals(<String, Object?>{}), <String, Object?>{'b': 2});
  reply = 'null';
  expect('find', await items.find(ItemsFindArgs(id: 'items_1')), null);
  reply = '[{"kind":"a","title":"t"}]';
  expect('page', await items.page(<String, Object?>{}), <Object?>[
    <String, Object?>{'kind': 'a', 'title': 't'},
  ]);
  reply = '"x"';
  expect('pick', await items.pick(ItemsPickArgs(choice: Choice(a: 1, kind: ChoiceKind.X))), 'x');
  reply = '1';
  expect('match', await items.match(ItemsMatchArgs(pattern: 'p')), 1);
  expect('type', await items.type(<String, Object?>{}), 1);
  expect('self', await items.self(<String, Object?>{}), 1);

  reply = bigFive;
  final charged = await api.ledger.charge(<String, Object?>{'amount': five});
  if (charged != five) {
    throw StateError('charge: got $charged, want a BigInt 5');
  }
  reply = '{"rows":[{"amount":$bigFive}],"total":$bigFive}';
  final balances = await api.ledger.balances(<String, Object?>{
    'accounts': <Object?>[
      <String, Object?>{'id': 'acc', 'limit': five},
    ],
  });
  expect('balances', balances, <String, Object?>{
    'rows': <Object?>[
      <String, Object?>{'amount': five},
    ],
    'total': five,
  });

  final want = <String>[
    '{"args":{},"functionPath":"items:count"}',
    '{"args":{},"functionPath":"items:summary"}',
    '{"args":{},"functionPath":"items:detail"}',
    '{"args":{"title":"t"},"functionPath":"items:create"}',
    '{"args":{},"functionPath":"items:clear"}',
    '{"args":{},"functionPath":"items:tags"}',
    '{"args":{},"functionPath":"items:labels"}',
    '{"args":{},"functionPath":"items:stats"}',
    '{"args":{},"functionPath":"items:totals"}',
    '{"args":{"id":"items_1"},"functionPath":"items:find"}',
    '{"args":{},"functionPath":"items:page"}',
    '{"args":{"choice":{"a":1,"kind":"x"}},"functionPath":"items:pick"}',
    '{"args":{"pattern":"p"},"functionPath":"items:match"}',
    '{"args":{},"functionPath":"items:type"}',
    '{"args":{},"functionPath":"items:self"}',
    '{"args":{"amount":$bigFive},"functionPath":"ledger:charge"}',
    '{"args":{"accounts":[{"id":"acc","limit":$bigFive}]},"functionPath":"ledger:balances"}',
  ];

  expect('frame count', frames.length, want.length);

  for (var index = 0; index < want.length; index++) {
    if (frames[index] != want[index]) {
      throw StateError('frame $index: got ${frames[index]}, want ${want[index]}');
    }
  }

  print('OK — every sdk-surface shape reaches the wire and decodes');
}

/// JSON with object keys sorted at every depth.
String _canonical(Object? value) {
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();

    return '{${keys.map((key) => '${jsonEncode(key)}:${_canonical(value[key])}').join(',')}}';
  }

  if (value is List) {
    return '[${value.map(_canonical).join(',')}]';
  }

  return jsonEncode(value);
}
