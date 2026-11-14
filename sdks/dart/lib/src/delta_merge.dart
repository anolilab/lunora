/// Row-delta merging, ported from `packages/client/src/delta-merge.ts` and
/// `shared/page-result.ts`.
///
/// A client that announces `pageDelta` can be sent a `delta` frame carrying one
/// row change, `{ key, op, table, row }`, for a bare-array or `.paginate()` query.
/// The change is spliced into the subscription's SERVER BASE, never published as
/// the query's value. Where an inserted row lands is normative (protocol/README.md
/// 5.1.1): the server replays [insertionIndexFor] before it sends the delta, so a
/// different rule desyncs the list silently.
library;

const String _idField = '_id';
const String _creationField = '_creationTime';
const String _pageField = 'page';

/// Whether [value] is a row change this client can merge: string `key` and
/// `table`, and an `op` of insert, update or delete. Anything else, such as an
/// aggregate a query returns verbatim, is an opaque payload that replaces the
/// value.
bool isMutationDelta(Object? value) {
  if (value is! Map<String, Object?>) {
    return false;
  }

  final op = value['op'];

  return value['key'] is String && value['table'] is String && (op == 'insert' || op == 'update' || op == 'delete');
}

/// The row list inside a live query result: the bare array, or the `page` of a
/// plain object. Null when the value carries none.
List<Object?>? rowListOf(Object? value) {
  if (value is List<Object?>) {
    return value;
  }

  if (value is Map<String, Object?>) {
    final page = value[_pageField];

    return page is List<Object?> ? page : null;
  }

  return null;
}

/// True when the list reads newest-first: the FIRST strictly-ordered adjacent
/// numeric `_creationTime` pair decides. Ascending when indeterminate.
bool isDescending(List<Object?> list) {
  num? previous;

  for (final row in list) {
    final existing = (row as Map<String, Object?>)[_creationField];

    if (existing is! num) {
      continue;
    }

    if (previous != null) {
      if (existing < previous) {
        return true;
      }

      if (existing > previous) {
        return false;
      }
    }

    previous = existing;
  }

  return false;
}

/// The index a new [row] is spliced at. A non-numeric creation time appends;
/// otherwise a descending list inserts before the first SMALLER row and an
/// ascending one before the first LARGER, and no such row appends.
int insertionIndexFor(List<Object?> list, Map<String, Object?> row) {
  final creation = row[_creationField];

  if (creation is! num) {
    return list.length;
  }

  final descending = isDescending(list);

  for (var index = 0; index < list.length; index++) {
    final existing = (list[index]! as Map<String, Object?>)[_creationField];

    if (existing is num && (descending ? existing < creation : existing > creation)) {
      return index;
    }
  }

  return list.length;
}

/// Merges one row change into an id-keyed list, returning a new list. Null when
/// some element has no string `_id`, or an insert/update carries no `row`.
List<Object?>? mergeRows(List<Object?> list, Map<String, Object?> delta) {
  final key = delta['key'];
  final op = delta['op'];
  final row = delta['row'];
  final next = <Object?>[];
  var existingIndex = -1;

  for (final element in list) {
    final id = element is Map<String, Object?> ? element[_idField] : null;

    if (id is! String) {
      return null;
    }

    if (id == key) {
      // A delete for an id the list never held is a legitimate no-op.
      if (op == 'delete') {
        continue;
      }

      if (existingIndex == -1) {
        existingIndex = next.length;
      }
    }

    next.add(element);
  }

  if (op == 'delete') {
    return next;
  }

  if (row is! Map<String, Object?>) {
    return null;
  }

  if (existingIndex == -1) {
    next.insert(insertionIndexFor(next, row), row);
  } else {
    next[existingIndex] = row;
  }

  return next;
}

/// Applies [delta] to [current], returning a new value, or null when it cannot
/// be applied. A paginated result keeps every field outside `page`; a bare array
/// stays a bare array.
Object? applyDelta(Object? current, Map<String, Object?> delta) {
  final list = rowListOf(current);

  if (list == null) {
    return null;
  }

  final next = mergeRows(list, delta);

  if (next == null || current is List<Object?>) {
    return next;
  }

  return <String, Object?>{...current! as Map<String, Object?>, _pageField: next};
}
