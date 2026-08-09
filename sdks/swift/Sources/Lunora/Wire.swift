import Foundation

/// The tagged value codec for Lunora's client↔server wire, ported from
/// `shared/wire-codec.ts`.
///
/// The wire is JSON with no reviver; values JSON cannot carry (big integers,
/// bytes, dates, maps/sets, ±Infinity/NaN, `undefined` in an array position)
/// become self-delimiting tagged arrays whose first element is ``Wire/tag``.
/// Pure-JSON values encode to a structurally identical tree.
///
/// Swift has no `Map`/`Set`/`bigint` on the wire and — importantly — **no
/// arbitrary-precision integer in its standard library**, so ``WireBigInt``
/// carries its decimal digits as a `String`. Converting to `Int64` would cap
/// the range at 2⁶³ and silently corrupt anything larger, which is exactly what
/// `v.bigint()` exists to avoid.
///
/// `decode` returns these wrappers so `encode(decode(x)) == x` holds for every
/// golden fixture — the conformance contract, asserted in `ConformanceTests`.
///
/// See `protocol/README.md` §2 for the normative grammar.
public enum Wire {
    /// Marks a JSON array as a tagged wire value. An array is significant to the
    /// codec only when its first element is exactly this string.
    public static let tag = "$lunora.wire$"

    /// Bounds recursion so a hostile deeply-nested payload cannot exhaust the stack.
    public static let maxDepth = 64

    /// Bounds a decoded big integer. Decimal parsing is superlinear, so an
    /// unbounded digit string from an untrusted peer is a denial of service.
    /// Applied only on decode — the untrusted direction.
    public static let maxBigIntDigits = 1024
}

/// JavaScript's `undefined`, distinct from JSON null.
///
/// As an object field it is dropped on encode (matching `JSON.stringify`); in an
/// array position it is preserved, because dropping it there would silently
/// shift every later element.
public struct WireUndefined: Equatable, Sendable {
    public static let shared = WireUndefined()
    public init() {}
}

/// A `v.bigint()`. Digits are kept as text — see ``Wire`` for why.
public struct WireBigInt: Equatable, Sendable {
    public let digits: String
    public init(_ digits: String) { self.digits = digits }
}

/// A `Date`, as epoch milliseconds. An invalid Date carries `.nan`, which
/// round-trips exactly rather than collapsing to epoch 0.
public struct WireDate: Equatable, Sendable {
    public let epochMs: Double
    public init(_ epochMs: Double) { self.epochMs = epochMs }
}

/// A `URL`, carried as its href.
public struct WireURL: Equatable, Sendable {
    public let href: String
    public init(_ href: String) { self.href = href }
}

/// A `Map`: ordered pairs whose keys may be non-string, which is why a Swift
/// dictionary cannot represent it.
public struct WireMap {
    public let entries: [(key: Any, value: Any)]
    public init(_ entries: [(key: Any, value: Any)]) { self.entries = entries }
}

/// A `Set`: ordered items.
public struct WireSet {
    public let items: [Any]
    public init(_ items: [Any]) { self.items = items }
}

/// A typed-array view that is NOT a plain `Uint8Array`, carrying its constructor
/// name so the exact view type survives. Plain `Uint8Array` bytes use `Data` and
/// the 2-element wire form.
public struct WireBytes: Equatable, Sendable {
    public let data: Data
    public let ctor: String
    public init(data: Data, ctor: String) {
        self.data = data
        self.ctor = ctor
    }
}

/// An `Error`: name, message, own enumerable props, optional cause. `stack` is
/// deliberately absent — the peer is untrusted.
public struct WireError {
    public let name: String
    public let message: String
    public let props: [String: Any]
    public let cause: Any?
    public init(name: String, message: String, props: [String: Any] = [:], cause: Any? = nil) {
        self.name = name
        self.message = message
        self.props = props
        self.cause = cause
    }
}

public enum WireFormatError: Error, CustomStringConvertible {
    case depthExceeded
    case invalidBigInt
    case unsupported(String)
    case malformed(String)

    public var description: String {
        switch self {
        case .depthExceeded:
            return "wire-codec: value nesting exceeds the \(Wire.maxDepth)-level limit"
        case .invalidBigInt:
            return "wire-codec: invalid or over-long bigint (max \(Wire.maxBigIntDigits) digits)"
        case let .unsupported(type):
            return "wire-codec: cannot encode a \(type) over the Lunora wire — only plain values, arrays, dictionaries, Data, and the Wire* wrappers round-trip"
        case let .malformed(tag):
            return "wire-codec: malformed \(tag) tag"
        }
    }
}

extension Wire {
    /// Encode `value` into a JSON-safe tree, tagging the leaves JSON cannot carry.
    public static func encode(_ value: Any?, depth: Int = 0) throws -> Any {
        guard depth <= maxDepth else { throw WireFormatError.depthExceeded }

        switch value {
        case nil: return NSNull()
        case is NSNull: return NSNull()
        case is WireUndefined: return [tag, "undefined"]
        default: break
        }

        if let bigInt = value as? WireBigInt { return [tag, "bigint", bigInt.digits] }
        if let date = value as? WireDate { return [tag, "date", try encode(date.epochMs, depth: depth + 1)] }
        if let url = value as? WireURL { return [tag, "url", url.href] }
        if let error = value as? WireError { return try encodeError(error, depth: depth) }
        if let map = value as? WireMap {
            return [tag, "map", try map.entries.map { [try encode($0.key, depth: depth + 1), try encode($0.value, depth: depth + 1)] }]
        }
        if let set = value as? WireSet { return [tag, "set", try set.items.map { try encode($0, depth: depth + 1) }] }
        if let bytes = value as? WireBytes { return [tag, "bytes", bytes.data.base64EncodedString(), bytes.ctor] }
        if let data = value as? Data { return [tag, "bytes", data.base64EncodedString()] }

        // NSNumber bridges Bool, Int and Double indistinguishably under `as?`,
        // so booleans are identified by their CoreFoundation type first — a
        // plain `as? Bool` would turn 0 and 1 into false and true.
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            if isIntegral(number) { return number }
            return encodeDouble(number.doubleValue)
        }

        if let boolean = value as? Bool { return boolean }
        if let double = value as? Double { return encodeDouble(double) }
        if let string = value as? String { return string }
        if let array = value as? [Any] { return try encodeArray(array, depth: depth) }
        if let dictionary = value as? [String: Any] { return try encodeDictionary(dictionary, depth: depth) }

        throw WireFormatError.unsupported(String(describing: type(of: value as Any)))
    }

    private static func isIntegral(_ number: NSNumber) -> Bool {
        let type = CFNumberGetType(number as CFNumber)
        switch type {
        case .float32Type, .float64Type, .floatType, .doubleType, .cgFloatType:
            return false
        default:
            return true
        }
    }

    private static func encodeDouble(_ value: Double) -> Any {
        if value.isNaN { return [tag, "nan"] }
        if value == .infinity { return [tag, "inf"] }
        if value == -.infinity { return [tag, "-inf"] }
        return value
    }

    private static func encodeArray(_ value: [Any], depth: Int) throws -> Any {
        let encoded = try value.map { try encode($0, depth: depth + 1) }
        // Escape a user array whose first element is literally the sentinel, or
        // the decoder would mistake it for a tagged value.
        if let first = encoded.first as? String, first == tag { return [tag, "arr", encoded] }
        return encoded
    }

    private static func encodeDictionary(_ value: [String: Any], depth: Int) throws -> Any {
        var result: [String: Any] = [:]
        for (key, field) in value {
            // Drop undefined fields, matching JSON.stringify, so a pure-JSON
            // object stays byte-identical across the codec.
            if field is WireUndefined { continue }
            result[key] = try encode(field, depth: depth + 1)
        }
        return result
    }

    private static func encodeError(_ error: WireError, depth: Int) throws -> Any {
        var props: [String: Any] = [:]
        for (key, item) in error.props where !(item is WireUndefined) {
            props[key] = try encode(item, depth: depth + 1)
        }

        var encoded: [Any] = [tag, "error", error.name, error.message, props]
        // `cause` rides a positional slot; absent when unset, keeping the
        // 5-element form.
        if let cause = error.cause, !(cause is WireUndefined) {
            encoded.append(try encode(cause, depth: depth + 1))
        }
        return encoded
    }

    /// Inverse of ``encode(_:depth:)``: revive tagged leaves into the wrappers.
    public static func decode(_ value: Any?, depth: Int = 0) throws -> Any {
        guard depth <= maxDepth else { throw WireFormatError.depthExceeded }

        if let array = value as? [Any] {
            if let first = array.first as? String, first == tag { return try decodeTagged(array, depth: depth) }
            return try array.map { try decode($0, depth: depth + 1) }
        }

        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (key, item) in dictionary { result[key] = try decode(item, depth: depth + 1) }
            return result
        }

        return value ?? NSNull()
    }

    private static func decodeTagged(_ value: [Any], depth: Int) throws -> Any {
        guard value.count >= 2, let name = value[1] as? String else {
            return try value.map { try decode($0, depth: depth + 1) }
        }

        switch name {
        case "undefined": return WireUndefined.shared
        case "nan": return Double.nan
        case "inf": return Double.infinity
        case "-inf": return -Double.infinity
        case "bigint": return try decodeBigInt(value)
        case "date":
            guard value.count >= 3, let epoch = try decode(value[2], depth: depth + 1) as? NSNumber else {
                throw WireFormatError.malformed("date")
            }
            return WireDate(epoch.doubleValue)
        case "url":
            guard value.count >= 3, let href = value[2] as? String else { throw WireFormatError.malformed("url") }
            return WireURL(href)
        case "map": return try decodeMap(value, depth: depth)
        case "set":
            guard value.count >= 3, let items = value[2] as? [Any] else { throw WireFormatError.malformed("set") }
            return WireSet(try items.map { try decode($0, depth: depth + 1) })
        case "error": return try decodeError(value, depth: depth)
        case "bytes": return try decodeBytes(value)
        case "arr":
            guard value.count >= 3, let items = value[2] as? [Any] else { throw WireFormatError.malformed("arr") }
            return try items.map { try decode($0, depth: depth + 1) }
        default:
            // Unknown tag (forward compatibility): an ordinary array.
            return try value.map { try decode($0, depth: depth + 1) }
        }
    }

    private static func decodeBigInt(_ value: [Any]) throws -> Any {
        guard value.count >= 3, let raw = value[2] as? String, raw.count <= maxBigIntDigits, isBigIntLiteral(raw) else {
            throw WireFormatError.invalidBigInt
        }
        return WireBigInt(raw)
    }

    private static func decodeMap(_ value: [Any], depth: Int) throws -> Any {
        guard value.count >= 3, let raw = value[2] as? [Any] else { throw WireFormatError.malformed("map") }

        var entries: [(key: Any, value: Any)] = []
        for item in raw {
            guard let pair = item as? [Any], pair.count >= 2 else { throw WireFormatError.malformed("map entry") }
            entries.append((key: try decode(pair[0], depth: depth + 1), value: try decode(pair[1], depth: depth + 1)))
        }
        return WireMap(entries)
    }

    private static func decodeError(_ value: [Any], depth: Int) throws -> Any {
        guard value.count >= 4 else { throw WireFormatError.malformed("error") }

        let props = value.count > 4 ? (try decode(value[4], depth: depth + 1) as? [String: Any] ?? [:]) : [:]
        let cause = value.count > 5 ? try decode(value[5], depth: depth + 1) : nil
        return WireError(
            name: value[2] as? String ?? "",
            message: value[3] as? String ?? "",
            props: props,
            cause: cause
        )
    }

    private static func decodeBytes(_ value: [Any]) throws -> Any {
        guard value.count >= 3, let encoded = value[2] as? String, let data = Data(base64Encoded: encoded) else {
            throw WireFormatError.malformed("bytes")
        }

        let ctor = value.count > 3 ? (value[3] as? String ?? "Uint8Array") : "Uint8Array"
        // A plain Uint8Array is `Data` and re-encodes to the 2-element form;
        // every other view keeps its constructor name.
        return ctor == "Uint8Array" ? data : WireBytes(data: data, ctor: ctor)
    }

    /// Whether `raw` is an optionally-negative run of ASCII digits. Deliberately
    /// not a regex: this runs on untrusted input on every decode.
    private static func isBigIntLiteral(_ raw: String) -> Bool {
        var body = Substring(raw)
        if body.hasPrefix("-") { body = body.dropFirst() }
        if body.isEmpty { return false }
        return body.allSatisfy { $0.isASCII && $0.isNumber }
    }
}
