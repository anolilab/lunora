import Foundation

extension Wire {
    /// Canonical JSON encoding of a pure-JSON tree: object keys sorted at every
    /// depth, arrays keeping their order, null fields kept, `WireUndefined`
    /// object fields dropped.
    ///
    /// Runs on the OUTPUT of ``encode(_:depth:)``, so it only ever sees
    /// null/bool/number/string/array/dictionary. Two argument records differing
    /// only in key insertion order collapse to one key — which is the point:
    /// this de-duplicates subscriptions, and it is compared verbatim against a
    /// key produced by the reference TypeScript client.
    public static func stableStringify(_ value: Any?) -> String {
        switch value {
        case nil, is NSNull: return "null"
        case is WireUndefined: return "null"
        default: break
        }

        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            return formatNumber(number)
        }

        if let boolean = value as? Bool { return boolean ? "true" : "false" }
        if let string = value as? String { return jsonString(string) }
        if let double = value as? Double { return formatDouble(double) }
        if let array = value as? [Any] { return "[" + array.map { stableStringify($0) }.joined(separator: ",") + "]" }
        if let dictionary = value as? [String: Any] { return stableObject(dictionary) }

        return "null"
    }

    /// The stable cache/dedup key for `value`.
    public static func stableWireKey(_ value: Any?) throws -> String {
        stableStringify(try encode(value))
    }

    private static func stableObject(_ value: [String: Any]) -> String {
        // JavaScript compares strings by UTF-16 code unit. Swift's `<` compares
        // by Unicode scalar, which agrees inside the BMP but not above it: an
        // astral character is its high surrogate (0xD83D) as UTF-16 yet its
        // full scalar (0x1F600) to Swift, so it sorts before U+FFFD there and
        // after it here. Comparing UTF-16 views reproduces JavaScript exactly.
        let pairs = value.filter { !($0.value is WireUndefined) }
        let sorted = pairs.sorted { lessUTF16($0.key, $1.key) }
        return "{" + sorted.map { "\(jsonString($0.key)):\(stableStringify($0.value))" }.joined(separator: ",") + "}"
    }

    private static func lessUTF16(_ a: String, _ b: String) -> Bool {
        var left = a.utf16.makeIterator()
        var right = b.utf16.makeIterator()
        while true {
            switch (left.next(), right.next()) {
            case (let l?, let r?):
                if l != r { return l < r }
            case (nil, .some): return true
            case (.some, nil): return false
            case (nil, nil): return false
            }
        }
    }

    private static func formatNumber(_ number: NSNumber) -> String {
        let type = CFNumberGetType(number as CFNumber)
        switch type {
        case .float32Type, .float64Type, .floatType, .doubleType, .cgFloatType:
            return formatDouble(number.doubleValue)
        default:
            return number.stringValue
        }
    }

    /// Renders a double exactly as `String(v)` does in JavaScript, which is what
    /// `JSON.stringify` emits for a finite number.
    ///
    /// Swift's default description writes "1e-05" and always keeps a ".0" on
    /// integral values; ECMAScript writes "0.00001", drops the decimal, stays
    /// positional up to 1e21, switches below 1e-7, and never pads the exponent.
    /// A key is compared verbatim, so the spellings must match.
    static func formatDouble(_ value: Double) -> String {
        if value.isNaN || value.isInfinite { return "null" }
        if value == value.rounded(.towardZero), abs(value) < 1e21 {
            return integral(value)
        }

        let magnitude = abs(value)
        if magnitude >= 1e-6, magnitude < 1e21 { return positional(value) }
        return exponential(value)
    }

    /// Positional spelling of an integral double, ECMAScript-style: the
    /// SHORTEST digit string that reads back as the same double, zero-padded out
    /// to the decimal point. `String(2**60)` is "1152921504606847000", not the
    /// exact expansion "1152921504606846976" that `%.0f` prints.
    private static func integral(_ value: Double) -> String {
        for precision in 0...17 {
            let candidate = String(format: "%.\(precision)e", value)
            guard Double(candidate) == value else { continue }

            let parts = candidate.split(separator: "e", maxSplits: 1)

            guard parts.count == 2, let exponent = Int(parts[1]) else { break }

            let sign = parts[0].hasPrefix("-") ? "-" : ""
            let digits = parts[0].filter { $0.isNumber }

            return sign + digits.padding(toLength: max(exponent + 1, digits.count), withPad: "0", startingAt: 0)
        }

        return String(format: "%.0f", value)
    }

    /// Positional rendering at the shortest precision that still parses back to
    /// the same double — ECMAScript's "shortest round-trip" rule.
    private static func positional(_ value: Double) -> String {
        for precision in 0...20 {
            let candidate = String(format: "%.\(precision)f", value)
            if Double(candidate) == value { return trimTrailingZeros(candidate) }
        }
        return trimTrailingZeros(String(format: "%.20f", value))
    }

    private static func exponential(_ value: Double) -> String {
        for precision in 0...17 {
            let candidate = String(format: "%.\(precision)e", value)
            if Double(candidate) == value { return normaliseExponent(candidate) }
        }
        return normaliseExponent(String(format: "%.17e", value))
    }

    /// "1.000000e-07" -> "1e-7": drop trailing mantissa zeros and the exponent's
    /// zero padding, neither of which ECMAScript emits.
    private static func normaliseExponent(_ text: String) -> String {
        let parts = text.split(separator: "e", maxSplits: 1)
        guard parts.count == 2 else { return text }

        let mantissa = trimTrailingZeros(String(parts[0]))
        var exponent = String(parts[1])
        let sign = exponent.hasPrefix("-") ? "-" : "+"
        if exponent.hasPrefix("-") || exponent.hasPrefix("+") { exponent.removeFirst() }
        while exponent.count > 1, exponent.hasPrefix("0") { exponent.removeFirst() }
        return "\(mantissa)e\(sign)\(exponent)"
    }

    private static func trimTrailingZeros(_ text: String) -> String {
        guard text.contains(".") else { return text }
        var trimmed = text
        while trimmed.hasSuffix("0") { trimmed.removeLast() }
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        return trimmed
    }

    /// Quotes a string the way `JSON.stringify` does. Foundation escapes the
    /// same set and leaves `<`, `>`, `&`, U+2028 and U+2029 raw, so no
    /// adjustment is needed here — unlike the Go port.
    static func jsonString(_ value: String) -> String {
        var quoted = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": quoted += "\\\""
            case "\\": quoted += "\\\\"
            case "\n": quoted += "\\n"
            case "\r": quoted += "\\r"
            case "\t": quoted += "\\t"
            case "\u{08}": quoted += "\\b"
            case "\u{0C}": quoted += "\\f"
            default:
                if scalar.value < 0x20 {
                    quoted += String(format: "\\u%04x", scalar.value)
                } else {
                    quoted.unicodeScalars.append(scalar)
                }
            }
        }
        return quoted + "\""
    }
}
