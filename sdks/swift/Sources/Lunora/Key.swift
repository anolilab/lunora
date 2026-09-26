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
    ///
    /// It is also the transport's JSON WRITER for RPC and batch bodies: it cannot
    /// fail, and it spells numbers and strings exactly as `JSON.stringify` does.
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
        var left = utf16Units(a).makeIterator()
        var right = utf16Units(b).makeIterator()
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
    /// `JSON.stringify` emits for a finite number (ECMA-262 Number::toString).
    ///
    /// Swift's `description` already finds the SHORTEST digit string that reads
    /// back as the same double; only its layout differs ("1e-05", "1.0",
    /// "1e+16"). So the digits `d1…dk` and the exponent `n` (value = 0.d1…dk ×
    /// 10^n) are taken from it and laid out the ECMAScript way. A fixed-precision
    /// search spelled three adjacent doubles near -6e-6 identically, so a
    /// subscription keyed on one received another's frames.
    static func formatDouble(_ value: Double) -> String {
        if value.isNaN || value.isInfinite { return "null" }
        if value == 0 { return value.sign == .minus ? "-0" : "0" }

        let sign = value < 0 ? "-" : ""
        let text = abs(value).description
        let parts = text.split(separator: "e", maxSplits: 1)
        let mantissa = parts[0].split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let whole = String(mantissa[0])
        var digits = whole + (mantissa.count > 1 ? String(mantissa[1]) : "")
        var n = whole.count + (parts.count > 1 ? Int(parts[1]) ?? 0 : 0)

        while digits.hasPrefix("0") {
            digits.removeFirst()
            n -= 1
        }

        while digits.hasSuffix("0") { digits.removeLast() }

        let k = digits.count

        if k <= n, n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
        if 0 < n, n <= 21 { return sign + digits.prefix(n) + "." + digits.dropFirst(n) }
        if -6 < n, n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }

        let exponent = n - 1
        let fraction = k > 1 ? "." + digits.dropFirst() : ""

        return sign + digits.prefix(1) + fraction + "e" + (exponent >= 0 ? "+" : "-") + String(abs(exponent))
    }

    /// A string's UTF-16 code units as its backing `NSString` holds them.
    ///
    /// Not `value.utf16`: a Swift view repairs a lone surrogate to U+FFFD, while
    /// the bridged `NSString` a truncation like `(s as NSString).substring(to:)`
    /// returns still holds it — and that unit is what `JSON.stringify` writes and
    /// what JavaScript sorts by.
    static func utf16Units(_ value: String) -> [UInt16] {
        let string = value as NSString
        var units = [UInt16](repeating: 0, count: string.length)

        string.getCharacters(&units, range: NSRange(location: 0, length: string.length))

        return units
    }

    /// Quotes a string the way `JSON.stringify` does: `"`, `\\`, the control
    /// characters, and a LONE surrogate as `\udXXX` (lowercase hex). `<`, `>`,
    /// `&`, U+2028 and U+2029 stay raw.
    ///
    /// This is also the transport's string writer, so it must never fail: a lone
    /// surrogate made `JSONSerialization` throw, and the offline queue re-queued
    /// that write — and every one behind it — on every flush, forever.
    static func jsonString(_ value: String) -> String {
        let units = utf16Units(value)
        var quoted = "\""
        var index = 0

        while index < units.count {
            let unit = units[index]
            index += 1

            switch unit {
            case 0x22: quoted += "\\\""
            case 0x5C: quoted += "\\\\"
            case 0x0A: quoted += "\\n"
            case 0x0D: quoted += "\\r"
            case 0x09: quoted += "\\t"
            case 0x08: quoted += "\\b"
            case 0x0C: quoted += "\\f"
            case 0xD800...0xDBFF where index < units.count && (0xDC00...0xDFFF).contains(units[index]):
                let low = units[index]
                index += 1
                quoted.unicodeScalars.append(Unicode.Scalar(0x10000 + (UInt32(unit - 0xD800) << 10) + UInt32(low - 0xDC00))!)
            case 0xD800...0xDFFF:
                quoted += String(format: "\\u%04x", unit)
            default:
                if unit < 0x20 {
                    quoted += String(format: "\\u%04x", unit)
                } else {
                    quoted.unicodeScalars.append(Unicode.Scalar(unit)!)
                }
            }
        }

        return quoted + "\""
    }
}
