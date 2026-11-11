import Foundation

/// Merges a row-change `delta` frame into a subscription's cached result.
///
/// A port of the reference client's `delta-merge` and `shared/page-result`
/// rules. Insert placement (protocol §5.1.1) is normative: the server replays the
/// same rule before it sends the delta, so a different one desyncs silently.
enum LunoraRowDelta {
    /// The connect capability that makes the server send row deltas. `refreshBatch`
    /// is deliberately not announced: this port does not handle batch frames.
    static let pageDeltaCapability = "pageDelta"

    private static let idField = "_id"
    private static let creationField = "_creationTime"
    private static let pageField = "page"

    enum Resolution {
        /// Publish this value as the new server base.
        case value(Any)
        /// The delta could not be merged: keep the previous value.
        case unmergeable
    }

    /// A row change `{ key, op, table, row }`, or nil for any other payload (which
    /// then replaces the value outright).
    private struct Change {
        let key: String
        let op: String
        let row: [String: Any]?
    }

    private static func change(_ value: Any) -> Change? {
        guard let object = value as? [String: Any], let key = object["key"] as? String, object["table"] is String,
            let op = object["op"] as? String, op == "insert" || op == "update" || op == "delete"
        else { return nil }

        return Change(key: key, op: op, row: object["row"] as? [String: Any])
    }

    /// What a data/delta frame's decoded `payload` does to `base`.
    ///
    /// A `data` frame replaces the base. A row change with no cached base is the
    /// legacy broadcast and is published as-is. With a base it is merged; when it
    /// cannot be merged the envelope is NOT published and the previous value stays.
    /// The reference re-snapshots there; this port has no resubscribe-for-snapshot
    /// path, so the gap is kept visible only by the value not advancing.
    static func resolve(kind: String?, payload: Any, base: Any, hasBase: Bool) -> Resolution {
        guard kind == "delta", let delta = change(payload) else { return .value(payload) }
        guard hasBase else { return .value(payload) }
        guard let merged = apply(base, delta) else { return .unmergeable }

        return .value(merged)
    }

    private static func apply(_ current: Any, _ delta: Change) -> Any? {
        if let array = current as? [Any] {
            return mergeRows(array, delta)
        }

        guard let object = current as? [String: Any], let page = object[pageField] as? [Any],
            let next = mergeRows(page, delta)
        else { return nil }

        var result = object
        result[pageField] = next

        return result
    }

    private static func mergeRows(_ list: [Any], _ delta: Change) -> [[String: Any]]? {
        var next: [[String: Any]] = []
        var existingIndex = -1

        for element in list {
            guard let row = element as? [String: Any], let id = row[idField] as? String else { return nil }

            if id == delta.key {
                if delta.op == "delete" { continue }
                if existingIndex == -1 { existingIndex = next.count }
            }

            next.append(row)
        }

        if delta.op == "delete" { return next }
        guard let row = delta.row else { return nil }

        if existingIndex == -1 {
            next.insert(row, at: insertionIndex(next, row))
        } else {
            next[existingIndex] = row
        }

        return next
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }

        return number.doubleValue
    }

    /// Descending only when the first strictly-ordered numeric adjacent pair falls;
    /// ascending when indeterminate.
    private static func isDescending(_ list: [[String: Any]]) -> Bool {
        var previous: Double?

        for row in list {
            guard let existing = number(row[creationField]) else { continue }

            if let previous {
                if existing < previous { return true }
                if existing > previous { return false }
            }

            previous = existing
        }

        return false
    }

    private static func insertionIndex(_ list: [[String: Any]], _ row: [String: Any]) -> Int {
        guard let creation = number(row[creationField]) else { return list.count }

        let descending = isDescending(list)

        for (index, existingRow) in list.enumerated() {
            guard let existing = number(existingRow[creationField]) else { continue }
            if descending ? existing < creation : existing > creation { return index }
        }

        return list.count
    }
}
