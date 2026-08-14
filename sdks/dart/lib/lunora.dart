/// The hand-written Lunora transport for Dart and Flutter.
///
/// The wire codec (`src/wire.dart`), the stable subscription key
/// (`src/key.dart`), the RPC + WebSocket client (`src/client.dart`), and the two
/// pieces that make it usable offline: the optimistic-update engine
/// (`src/optimistic.dart`) and the mutation queue (`src/offline_queue.dart`),
/// with the shape/poke protocol in `src/shapes.dart` and their coded errors in
/// `src/errors.dart`.
///
/// It imports `dart:convert`, `dart:typed_data` and `dart:async` and nothing
/// more, so it runs unchanged on every Flutter target — iOS, Android, web,
/// macOS, Windows, Linux — with no FFI and no conditional import.
///
/// `lunora sdk generate --lang dart` copies this `lib/` into the output beside
/// the generated surface, so nothing here may refer to its own package by name:
/// every import in `src/` is relative, and the copy resolves under whatever
/// package name the generated `pubspec.yaml` declares. See `sdks/README.md`.
library;

export 'src/client.dart';
export 'src/errors.dart';
export 'src/key.dart';
export 'src/offline_queue.dart';
export 'src/optimistic.dart';
export 'src/replay.dart';
export 'src/shapes.dart';
export 'src/transport.dart';
export 'src/wire.dart';
