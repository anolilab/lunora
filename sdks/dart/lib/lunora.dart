/// The hand-written Lunora transport for Dart and Flutter.
///
/// Three pieces, and nothing else: the tagged value codec (`src/wire.dart`), the
/// stable subscription key (`src/key.dart`), and the RPC + WebSocket client
/// (`src/client.dart`). It imports `dart:convert`, `dart:typed_data` and
/// `dart:async` and nothing more, so it runs unchanged on every Flutter target
/// — iOS, Android, web, macOS, Windows, Linux — with no FFI and no conditional
/// import.
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
export 'src/wire.dart';
