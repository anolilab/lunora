/// The WebSocket session: the `connect` frame, the close codes that drive token
/// expiry, and whisper rooms.
///
/// Part of the conformance suite; `conformance.dart` owns `main()`.
library;

import 'dart:convert';

import 'package:lunora/lunora.dart';

import 'harness.dart';

Map<String, Object?> _frameGoldens() => fixture('ws-frames.json')['clientFrames']! as Map<String, Object?>;

// ─── Connect ─────────────────────────────────────────────────────────────────

/// `connect` opens every socket, before any subscription or whisper join, and
/// carries the session credential as `token`. That credential is not the RPC
/// bearer, and neither one ever appears in the socket URL.
void caseConnectFrameFirstAndCarriesSessionToken() {
  covers('connect_frame_first_and_carries_session_token');

  final frames = _frameGoldens();

  equals(
    canonical(LunoraClient.buildConnectFrame(clientId: 'client-test', token: 'session-token')),
    canonical(frames['connect-with-token']),
    'the connect builder carries the session credential',
  );
  equals(
    canonical(LunoraClient.buildConnectFrame(clientId: 'client-test', context: <String, Object?>{'roomId': 'general'}, token: 'session-token')),
    canonical(frames['connect-with-token-and-context']),
    'and with a context alongside it',
  );

  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example', authToken: 'rpc-bearer', clientId: 'client-test')
    ..sessionToken = 'session-token'
    ..subscribe('messages:list', args: <String, Object?>{'channel': 'general'});

  client.attachSocket(sent.add);
  client.resendSubscriptions();

  equals(canonical(sent.first), canonical(frames['connect-with-token']), 'frame 0 is connect, carrying the session credential as token');
  equals(sent[1]['type'], 'subscribe', 'the subscription goes out after connect');

  final anonymous = <Map<String, Object?>>[];

  LunoraClient(url: 'https://app.example', clientId: 'client-test').attachSocket(anonymous.add);

  equals(canonical(anonymous.single), canonical(frames['connect']), 'with no session credential, connect is the plain frame');
  check(!anonymous.single.containsKey('token'), 'and carries no token key at all');

  for (final url in <String>[client.wsUrl(), client.wsUrl(ticket: 'ticket-1')]) {
    check(!url.contains('session-token') && !url.contains('rpc-bearer'), 'neither credential rides the socket URL: $url');
  }
}

/// protocol/README.md section 6: `?token=` carries the admin ticket and nothing
/// else. The session credential travels in `connect`, so it is never a URL
/// parameter, with or without a ticket.
void caseWsUrlCarriesOnlyTheAdminTicket() {
  covers('ws_url_carries_only_the_admin_ticket');

  final client = LunoraClient(url: 'https://app.example', authToken: 'rpc-bearer')..sessionToken = 'session-token';

  equals(canonical(Uri.parse(client.wsUrl()).queryParametersAll), canonical(<String, List<String>>{}), 'no ticket, so no ?token= on the socket URL');
  equals(
    canonical(Uri.parse(client.wsUrl(ticket: 'ticket-1')).queryParametersAll),
    canonical(<String, List<String>>{
      'token': ['ticket-1'],
    }),
    'the ticket is the only ?token=',
  );
}

/// The connection context rides `connect` when the socket is attached with one,
/// and is omitted otherwise.
void caseAttachSocketCarriesConnectionContext() {
  covers('attach_socket_carries_connection_context');

  final frames = _frameGoldens();
  final withContext = <Map<String, Object?>>[];

  LunoraClient(url: 'https://app.example', clientId: 'client-test').attachSocket(withContext.add, context: <String, Object?>{'roomId': 'general'});

  equals(canonical(withContext.single), canonical(frames['connect-with-context']), 'the connect frame carries the context');

  final bare = <Map<String, Object?>>[];

  LunoraClient(url: 'https://app.example', clientId: 'client-test').attachSocket(bare.add);

  check(!bare.single.containsKey('context'), 'without a context, connect omits it');
  equals(canonical(bare.single), canonical(frames['connect']), 'and is otherwise the plain connect frame');
}

// ─── Token expiry ────────────────────────────────────────────────────────────

/// Every entry in `closeSequences` is driven through the port's own calls: a
/// socket open is `attachSocket`, a close is `detachSocket(code, reason)`, an
/// inbound frame is `handleFrame`, and a credential change is the session
/// setter. The counts are the reference client's.
void caseCloseCodesDriveTokenExpiry() {
  covers('close_codes_drive_token_expiry');

  final sequences = fixture('ws-frames.json')['closeSequences']! as Map<String, Object?>;

  for (final testCase in objectList(sequences['cases'])) {
    final name = testCase['name'];
    var notifications = 0;
    var subscriptionErrors = 0;
    var credentials = 0;

    final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');

    // Registered first and throwing: the counting listener after it must still run,
    // and the close and the frame must still be handled.
    client
      ..onTokenExpired(() => throw StateError('a listener that fails'))
      ..onTokenExpired(() => notifications += 1)
      ..subscribe('messages:list', onError: (_) => subscriptionErrors += 1);

    for (final step in objectList(testCase['steps'])) {
      if (step.containsKey('attach')) {
        client.attachSocket((_) {});
      } else if (step.containsKey('frame')) {
        client.handleFrame(jsonEncode(step['frame']));
      } else if (step.containsKey('close')) {
        final close = step['close']! as Map<String, Object?>;

        client.detachSocket(close['code']! as int, close['reason']! as String);
      } else if (step.containsKey('credentialChange')) {
        credentials += 1;
        client.sessionToken = 'session-$credentials';
      }
    }

    equals(notifications, testCase['tokenExpiredNotifications'], 'token-expired notifications for $name');

    if (testCase.containsKey('subscriptionErrors')) {
      equals(subscriptionErrors, testCase['subscriptionErrors'], 'subscription errors for $name');
    }
  }
}

// ─── Whisper and rooms ───────────────────────────────────────────────────────

/// A whisper topic is joined with `whisper_subscribe` and left with
/// `whisper_unsubscribe`, and a whisper is sent with its wire-encoded data. An
/// inbound whisper reaches its topic's listeners only, and a malformed one
/// reaches none and raises nothing.
void caseWhisperFramesJoinSendAndDeliver() {
  covers('whisper_frames_join_send_and_deliver');

  final document = fixture('ws-frames.json');
  final frames = _frameGoldens();
  final whisper = document['whisperFrames']! as Map<String, Object?>;

  equals(canonical(LunoraClient.buildWhisperSubscribeFrame('room:general')), canonical(frames['whisper-subscribe']), 'the join builder');
  equals(canonical(LunoraClient.buildWhisperUnsubscribeFrame('room:general')), canonical(frames['whisper-unsubscribe']), 'the leave builder');
  equals(
    canonical(LunoraClient.buildWhisperFrame('room:general', <String, Object?>{'text': 'hi'})),
    canonical(frames['whisper-send']),
    'the whisper builder wire-encodes its data',
  );

  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');

  attachRecording(client, sent);

  final leave = client.whisperSubscribe('room:general', (_) {});

  equals(canonical(sent.single), canonical(frames['whisper-subscribe']), 'the first listener on a topic sends whisper_subscribe');

  check(client.whisper('room:general', <String, Object?>{'text': 'hi'}), 'a whisper is sent while a socket is attached');
  equals(canonical(sent.last), canonical(frames['whisper-send']), 'the whisper carries its topic and wire-encoded data');

  final joined = sent.length;
  final room = client.connectRoom('general', (_) {});

  equals(sent.length, joined, 'a second listener on a joined topic sends no second join');
  check(room.send('ping'), 'a room sends while attached');
  equals(sent.last['topic'], 'room:general', 'a room sends on room:<name>');

  room.close();
  equals(sent.last['type'], 'whisper', 'leaving the room leaves the topic joined, since another listener remains');

  leave();
  equals(canonical(sent.last), canonical(frames['whisper-unsubscribe']), 'the last listener to leave sends whisper_unsubscribe');

  client.detachSocket();
  check(!client.whisper('room:general', 'after close'), 'a whisper with no socket attached is refused, not queued');

  for (final testCase in objectList(whisper['serverFrames'])) {
    final name = testCase['name'];
    final delivered = <Object?>[];
    final inbound = LunoraClient(url: 'https://app.example')..attachSocket((_) {});

    inbound.whisperSubscribe('room:general', delivered.add);
    inbound.handleFrame(jsonEncode(testCase['frame']));

    final expected = <Object?>[
      for (final entry in objectList(testCase['delivered']))
        if (entry['topic'] == 'room:general') entry['value'],
    ];

    equals(canonical(delivered), canonical(expected), 'values delivered to room:general for $name');
  }
}

/// A closed room refuses sends, even while another listener keeps its topic joined.
void caseClosedRoomRefusesSends() {
  final sent = <Map<String, Object?>>[];
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');

  attachRecording(client, sent);

  final room = client.connectRoom('general', (_) {});

  client.whisperSubscribe('room:general', (_) {});
  room.close();

  check(!room.send('after close'), 'a closed room must report its send as not sent');
  check(sent.every((frame) => frame['type'] != 'whisper'), 'and must write no whisper frame after close');
}

/// A listener that throws does not stop the others on its topic from receiving the frame.
void caseThrowingWhisperListenerDoesNotEndDispatch() {
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');
  final received = <Object?>[];

  client
    ..whisperSubscribe('room:general', (_) => throw StateError('a listener that fails'))
    ..whisperSubscribe('room:general', received.add);
  client.handleFrame(jsonEncode(<String, Object?>{'type': 'whisper', 'topic': 'room:general', 'data': 'hi'}));

  equals(canonical(received), canonical(<Object?>['hi']), 'the listener after a throwing one still receives the whisper');
}

/// A connect write that throws leaves the client offline: nothing is sent through the failed socket.
void caseFailedConnectLeavesTheClientOffline() {
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');

  try {
    client.attachSocket((_) => throw StateError('the socket is gone'));
  } on StateError {
    // The write failed, as the sender reported.
  }

  check(!client.whisper('room:general', 'after a failed connect'), 'the client must stay offline after a failed connect');
}

/// A sender that detaches during the attach's joins stops the remaining joins from being written.
void caseSupersededAttachWritesNoMoreJoins() {
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');
  final sent = <Map<String, Object?>>[];

  client
    ..whisperSubscribe('room:a', (_) {})
    ..whisperSubscribe('room:b', (_) {});
  client.attachSocket((frame) {
    sent.add(frame);
    if (frame['type'] == 'whisper_subscribe') {
      client.detachSocket();
    }
  });

  equals(sent.where((frame) => frame['type'] == 'whisper_subscribe').length, 1, 'a detach during the joins stops the remaining joins');
}

/// A topic a sender registers while connect is written is joined on that attach, not left unjoined.
void caseTopicRegisteredDuringConnectIsJoined() {
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');
  final sent = <Map<String, Object?>>[];

  client.attachSocket((frame) {
    sent.add(frame);
    if (frame['type'] == 'connect') {
      client.whisperSubscribe('room:general', (_) {});
    }
  });

  equals(
    canonical(<Object?>[for (final frame in sent) frame['type'] == 'whisper_subscribe' ? frame['topic'] : frame['type']]),
    canonical(<Object?>['connect', 'room:general']),
    'the topic registered during connect is joined after it',
  );
}

/// Every reconnect joins each registered topic again, straight after `connect`.
void caseWhisperTopicsRejoinAfterReconnect() {
  covers('whisper_topics_rejoin_after_reconnect');

  final rejoin = (fixture('ws-frames.json')['whisperFrames']! as Map<String, Object?>)['rejoinOnReconnect']! as List<Object?>;
  final client = LunoraClient(url: 'https://app.example', clientId: 'client-test');

  client.whisperSubscribe('room:general', (_) {});

  for (final open in <String>['first', 'second']) {
    final sent = <Map<String, Object?>>[];

    client.attachSocket(sent.add);

    equals(canonical(<Object?>[for (final frame in sent) frame['type']]), canonical(<Object?>['connect', 'whisper_subscribe']),
        '$open open: connect, then the join');
    equals(canonical(<Object?>[for (final frame in sent.skip(1)) frame['topic']]), canonical(rejoin), '$open open: rejoins room:general');

    client.detachSocket();
  }
}
