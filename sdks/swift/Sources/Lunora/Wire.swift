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

    /// Largest integer a `Double` holds exactly (2^53 - 1). JSON numbers are
    /// doubles, so an integer past this cannot cross the wire as a number
    /// without changing value — ``WireBigInt`` and its tag exist for that case.
    public static let maxExactInteger = 9_007_199_254_740_991.0

    /// Largest epoch a `Date` holds (ECMAScript TimeClip). Past this, and for
    /// any non-finite epoch, `new Date(v)` is an Invalid Date.
    public static let maxTimeValue = 8.64e15

    /// `new Date(epoch).getTime()` — ECMAScript TimeClip.
    ///
    /// A `Date` truncates its argument toward zero, and anything non-finite or
    /// past ±8.64e15 becomes an Invalid Date, which the reference re-encodes as
    /// a NaN tag. Kept verbatim, the epoch went back on the wire as a date the
    /// reference's own `Date` can never hold.
    static func timeClip(_ epoch: Double) -> Double {
        guard epoch.isFinite, abs(epoch) <= maxTimeValue else { return Double.nan }

        let truncated = epoch.rounded(.towardZero)

        // TimeClip is ToIntegerOrInfinity, not truncation, and the two differ on
        // exactly one window: an epoch in (-1, 0] gives +0 there and -0 here,
        // because rounding toward zero keeps the sign of zero. The window is one
        // value wide, and the stable subscription key spells -0 as the bare
        // token `-0`, distinct from `0` — so without this a Date built from -0.5
        // opens a different subscription than the TS client's does.
        return truncated == 0 ? 0 : truncated
    }

    /// Whether an href carries a URL scheme, per RFC 3986: an ASCII letter
    /// followed by letters, digits, `+`, `-` or `.`, then `:`.
    ///
    /// The reference builds a real `URL`, which throws on anything unparseable,
    /// while every port stored the string verbatim and accepted `"not a url"` —
    /// a frame that kills a JS peer's subscription and is waved through here.
    /// Reproducing WHATWG URL parsing in eight languages is not on offer (their
    /// own parsers disagree with it in the deep end), so the contract, and
    /// `protocol/README.md` §2.1, is the floor of it: an href must be ABSOLUTE.
    static func isAbsoluteHref(_ href: String) -> Bool {
        guard let colon = href.firstIndex(of: ":") else { return false }

        let scheme = href[href.startIndex..<colon]

        guard let first = scheme.first, first.isASCII, first.isLetter else { return false }

        return scheme.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "-" || $0 == ".") }
    }

    /// Bytes per element for the typed-array views the codec round-trips. A view
    /// whose payload is not a whole number of elements is not a view the
    /// reference can rebuild — `Float32Array(buffer)` raises a `RangeError`
    /// there — so accepting it would hand the consumer bytes it cannot
    /// reconstruct. `ArrayBuffer` is absent deliberately: it is untyped, so
    /// there is nothing to align.
    static let typedArrayElementSizes: [String: Int] = [
        "BigInt64Array": 8,
        "BigUint64Array": 8,
        "Float32Array": 4,
        "Float64Array": 8,
        "Int16Array": 2,
        "Int32Array": 4,
        "Int8Array": 1,
        "Uint16Array": 2,
        "Uint32Array": 4,
        "Uint8Array": 1,
        "Uint8ClampedArray": 1,
    ]
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
    case outOfExactRange(String)

    public var description: String {
        switch self {
        case .depthExceeded:
            return "wire-codec: value nesting exceeds the \(Wire.maxDepth)-level limit"
        case .invalidBigInt:
            return "wire-codec: invalid or over-long bigint (max \(Wire.maxBigIntDigits) digits)"
        case .unsupported(let type):
            return "wire-codec: cannot encode a \(type) over the Lunora wire — only plain values, arrays, dictionaries, Data, and the Wire* wrappers round-trip"
        case .malformed(let tag):
            return "wire-codec: malformed \(tag) tag"
        case .outOfExactRange(let value):
            return "wire-codec: integer \(value) exceeds the exact Double range — wrap it in WireBigInt so it crosses the wire as a bigint tag"
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
            if isIntegral(number) {
                // `Int64` holds integers a `Double` cannot, so letting one
                // through meant the SERVER's own JSON.parse rounded it and the
                // value that arrived was quietly a different integer. Refuse, as
                // the Go port does, and name the way across.
                guard abs(number.doubleValue) <= maxExactInteger else {
                    throw WireFormatError.outOfExactRange(number.stringValue)
                }
                return number
            }
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
            // `Bool` bridges to `NSNumber` under `as?` (true -> 1), so the
            // CoreFoundation type is checked first — the same trap `encode`,
            // `mapKeyIdentity` and `parseCommitCursor` already guard. Without
            // it `[TAG,"date",true]` decoded as epoch 1 where the reference,
            // whose check is `typeof epoch !== "number"`, refuses the frame.
            guard value.count >= 3,
                let epoch = try decode(value[2], depth: depth + 1) as? NSNumber,
                CFGetTypeID(epoch) != CFBooleanGetTypeID()
            else {
                throw WireFormatError.malformed("date")
            }
            return WireDate(timeClip(epoch.doubleValue))
        case "url":
            guard value.count >= 3, let href = value[2] as? String, isAbsoluteHref(href) else { throw WireFormatError.malformed("url") }
            return WireURL(href)
        case "map": return try decodeMap(value, depth: depth)
        case "set":
            guard value.count >= 3, let items = value[2] as? [Any] else { throw WireFormatError.malformed("set") }
            return try decodeSet(items, depth: depth)
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
        // Canonicalise on the way in. The reference decodes to a real `bigint`
        // and re-encodes with `toString()`, so `"007"` and `"-0"` leave it as
        // `"7"` and `"0"`. Carrying the digits verbatim re-encoded a spelling
        // the reference never emits, and keyed a subscription differently on a
        // value the two ends agree about.
        return WireBigInt(normaliseBigInt(raw))
    }

    /// Decode a `set` payload, collapsing duplicates the way a real `Set` does.
    ///
    /// The reference builds a `new Set`, which de-duplicates by SameValueZero
    /// and keeps the FIRST occurrence's position — the same rule as a `Map`'s
    /// keys, so the same identity helper decides it. Carrying both copies
    /// re-encoded a set the reference would never emit.
    private static func decodeSet(_ raw: [Any], depth: Int) throws -> WireSet {
        var items: [Any] = []
        var seen: Set<String> = []

        for entry in raw {
            let item = try decode(entry, depth: depth + 1)

            if let identity = mapKeyIdentity(item) {
                if seen.contains(identity) { continue }
                seen.insert(identity)
            }

            items.append(item)
        }
        return WireSet(items)
    }

    private static func decodeMap(_ value: [Any], depth: Int) throws -> Any {
        guard value.count >= 3, let raw = value[2] as? [Any] else { throw WireFormatError.malformed("map") }

        var entries: [(key: Any, value: Any)] = []
        var seen: [String: Int] = [:]

        for item in raw {
            guard let pair = item as? [Any], pair.count == 2 else { throw WireFormatError.malformed("map entry") }

            let key = try decode(pair[0], depth: depth + 1)
            let entry = (key: key, value: try decode(pair[1], depth: depth + 1))

            // Last write wins, at the FIRST occurrence's position — the reference
            // builds a real Map, and `Map.prototype.set` on a key already present
            // overwrites the value in place rather than appending. Keeping both
            // entries left two peers of one deployment reading a different value
            // from identical bytes.
            if let identity = mapKeyIdentity(key) {
                if let index = seen[identity] {
                    // Only the VALUE. `Map.prototype.set` on a key already
                    // present keeps the key it holds, so a later `-0` never
                    // replaces the `0` stored under it.
                    entries[index].value = entry.value
                    continue
                }

                seen[identity] = entries.count
            }

            entries.append(entry)
        }
        return WireMap(entries)
    }

    /// A map key's collapse identity, or `nil` when it never collapses.
    ///
    /// The reference's `Map` compares keys by SameValueZero: primitives by value
    /// (`NaN` equal to itself), everything else by reference — so two
    /// structurally identical `WireDate`/bytes keys stay two entries there and
    /// must stay two here.
    private static func mapKeyIdentity(_ key: Any) -> String? {
        if key is NSNull { return "null" }
        if key is WireUndefined { return "undefined" }
        if let bigInt = key as? WireBigInt { return "big:\(normaliseBigInt(bigInt.digits))" }
        if let text = key as? String { return "str:\(text)" }

        // NSNumber bridges Bool, Int and Double indistinguishably under `as?`, so
        // booleans are identified by their CoreFoundation type first — `as? Bool`
        // would collapse 0 and 1 onto false and true.
        if let number = key as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return "bool:\(number.boolValue)" }
            return number.doubleValue.isNaN ? "num:nan" : "num:\(number.doubleValue + 0.0)"
        }

        // `+ 0.0` clears the sign of a zero and changes nothing else: SameValueZero
        // holds -0 equal to 0, while interpolating a Double keeps the sign ("-0.0").
        if let double = key as? Double { return double.isNaN ? "num:nan" : "num:\(double + 0.0)" }

        return nil
    }

    /// Strip a bigint literal's leading zeros and a sign that only reaches zero,
    /// so `01` and `1` are one key here as they are to the reference.
    private static func normaliseBigInt(_ digits: String) -> String {
        let negative = digits.hasPrefix("-")
        let body = negative ? String(digits.dropFirst()) : digits
        let trimmed = String(body.drop(while: { $0 == "0" }))

        if trimmed.isEmpty { return "0" }

        return negative ? "-" + trimmed : trimmed
    }

    private static func decodeError(_ value: [Any], depth: Int) throws -> Any {
        guard value.count >= 4 else { throw WireFormatError.malformed("error") }

        // The props slot is NOT optional, NOT nullable and NOT a primitive: the
        // reference reads it with `Object.keys`, which throws on a null or
        // missing slot and ENUMERATES a string/number/boolean/array — so
        // `[TAG,"error","E","m","ab"]` would decode there with the invented
        // props {0:"a",1:"b"} while substituting an empty map accepted the same
        // frame here.
        guard value.count > 4, !(value[4] is NSNull) else { throw WireFormatError.malformed("error") }
        guard let props = (try decode(value[4], depth: depth + 1)) as? [String: Any] else {
            throw WireFormatError.malformed("error")
        }
        // Both label slots are type-CHECKED, like every other slot. Substituting
        // "" for a non-string accepted the frame while erasing the error's
        // identity, and the ports did not even agree on that: two carried the
        // non-string through verbatim. A slot that must hold a string and does
        // not is a malformed frame.
        guard let name = value[2] as? String, let message = value[3] as? String else {
            throw WireFormatError.malformed("error")
        }

        let cause = value.count > 5 ? try decode(value[5], depth: depth + 1) : nil
        return WireError(
            name: name,
            message: message,
            props: props,
            cause: cause
        )
    }

    private static func decodeBytes(_ value: [Any]) throws -> Any {
        // The payload must be CANONICAL, not merely decodable: exactly the
        // string a conforming encoder would have written for these bytes.
        // `Data(base64Encoded:)` ignores the unused low bits of a short final
        // quantum, so `"AQJ="` decoded to two bytes that re-encode as `"AQI="` —
        // different bytes than the peer wrote, accepted silently. Re-encoding
        // and comparing is the whole rule, and the same one line in every port.
        guard value.count >= 3, let encoded = value[2] as? String, let data = Data(base64Encoded: encoded),
            data.base64EncodedString() == encoded
        else {
            throw WireFormatError.malformed("bytes")
        }

        let ctor = value.count > 3 ? (value[3] as? String ?? "Uint8Array") : "Uint8Array"
        // A plain Uint8Array is `Data` and re-encodes to the 2-element form;
        // every other view keeps its constructor name.
        if ctor == "Uint8Array" { return data }

        if ctor != "ArrayBuffer" {
            // An UNKNOWN ctor name decodes to raw bytes, dropping the name — the
            // forward-compat rule in protocol/README.md §2.1. Keeping it
            // re-encoded a 4-element form the reference emits as 3, so the same
            // value relayed through JS and through here produced different bytes,
            // and therefore different stable subscription keys.
            guard let size = typedArrayElementSizes[ctor] else { return data }

            guard data.count % size == 0 else { throw WireFormatError.malformed("typed-array bytes") }
        }

        return WireBytes(data: data, ctor: ctor)
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
