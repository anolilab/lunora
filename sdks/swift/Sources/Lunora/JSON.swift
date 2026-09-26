import Foundation

/// The transport's JSON reader.
///
/// Hand-written rather than `JSONSerialization`, which on Darwin is not
/// correctly rounded: about one `JSON.stringify` double in eleven read back one
/// ulp off, so a value the server sent keyed and re-encoded as a DIFFERENT
/// number here. Every number goes through `Double(String)` (strtod), which is.
///
/// The tree is the one the port has always used: `[String: Any]`, `[Any]`,
/// `String`, `NSNull`, and `NSNumber` — a boolean as the CoreFoundation boolean
/// (so the `CFBooleanGetTypeID` guards keep working), an integer literal that
/// fits `Int64` as an integer, anything else as a double. An integer past the
/// exact double range is still read as an integer here; ``Wire/decode(_:depth:)``
/// turns it into the double `JSON.parse` would have produced.
///
/// A `\uXXXX` escape naming a lone surrogate is kept, as `JSON.parse` keeps it:
/// the string is built as an `NSString` from its UTF-16 units, and the writer
/// (``Wire/jsonString(_:)``) reads those units back.
public enum LunoraJSON {
    /// Deep enough for any real payload (the wire codec itself stops at
    /// ``Wire/maxDepth``), shallow enough that a hostile `[[[[…` cannot
    /// overflow the stack of this recursive reader.
    static let maxNesting = 512

    /// Parses one JSON text (any value at the top level), or throws
    /// ``WireFormatError/invalidJSON(_:)``.
    public static func parse(_ data: Data) throws -> Any {
        try data.withUnsafeBytes { raw -> Any in
            var reader = Reader(bytes: raw.bindMemory(to: UInt8.self))
            reader.skipWhitespace()
            let value = try reader.value(depth: 0)
            reader.skipWhitespace()

            guard reader.index == reader.bytes.count else { throw reader.failure() }

            return value
        }
    }

    public static func parse(_ text: String) throws -> Any { try parse(Data(text.utf8)) }

    private struct Reader {
        let bytes: UnsafeBufferPointer<UInt8>
        var index = 0

        init(bytes: UnsafeBufferPointer<UInt8>) { self.bytes = bytes }

        func failure() -> WireFormatError { .invalidJSON(index) }

        var current: UInt8? { index < bytes.count ? bytes[index] : nil }

        mutating func skipWhitespace() {
            while let byte = current, byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D { index += 1 }
        }

        mutating func expect(_ literal: String) throws {
            for byte in literal.utf8 {
                guard current == byte else { throw failure() }
                index += 1
            }
        }

        mutating func value(depth: Int) throws -> Any {
            guard depth <= LunoraJSON.maxNesting else { throw failure() }

            switch current {
            case UInt8(ascii: "{"): return try object(depth: depth)
            case UInt8(ascii: "["): return try array(depth: depth)
            case UInt8(ascii: "\""): return try string()
            case UInt8(ascii: "t"):
                try expect("true")
                return NSNumber(value: true)
            case UInt8(ascii: "f"):
                try expect("false")
                return NSNumber(value: false)
            case UInt8(ascii: "n"):
                try expect("null")
                return NSNull()
            default: return try number()
            }
        }

        mutating func object(depth: Int) throws -> Any {
            index += 1
            var result: [String: Any] = [:]
            skipWhitespace()

            if current == UInt8(ascii: "}") {
                index += 1
                return result
            }

            while true {
                skipWhitespace()
                guard current == UInt8(ascii: "\"") else { throw failure() }
                let key = try string()
                skipWhitespace()
                try expect(":")
                skipWhitespace()
                let item = try value(depth: depth + 1)

                // Last duplicate wins, as `JSON.parse` does. But Swift compares a
                // lone surrogate as U+FFFD, so `"\ud800"` and `"\ud801"` are ONE
                // `[String: Any]` key here and two to JavaScript: merging them
                // would silently drop a member, so such an object is refused.
                if let existing = result.index(forKey: key), Wire.utf16Units(result[existing].key) != Wire.utf16Units(key) {
                    throw failure()
                }

                result[key] = item
                skipWhitespace()

                switch current {
                case UInt8(ascii: ","): index += 1
                case UInt8(ascii: "}"):
                    index += 1
                    return result
                default: throw failure()
                }
            }
        }

        mutating func array(depth: Int) throws -> Any {
            index += 1
            var result: [Any] = []
            skipWhitespace()

            if current == UInt8(ascii: "]") {
                index += 1
                return result
            }

            while true {
                skipWhitespace()
                result.append(try value(depth: depth + 1))
                skipWhitespace()

                switch current {
                case UInt8(ascii: ","): index += 1
                case UInt8(ascii: "]"):
                    index += 1
                    return result
                default: throw failure()
                }
            }
        }

        mutating func string() throws -> String {
            index += 1
            let start = index

            // Fast path: no escape, so the bytes are the string.
            while let byte = current, byte != UInt8(ascii: "\""), byte != UInt8(ascii: "\\") {
                guard byte >= 0x20 else { throw failure() }
                index += 1
            }

            guard let stop = current else { throw failure() }

            if stop == UInt8(ascii: "\"") {
                index += 1
                return String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<(index - 1)]), as: UTF8.self)
            }

            var units = Array(String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<index]), as: UTF8.self).utf16)
            var runStart = index

            while true {
                guard let byte = current else { throw failure() }

                if byte == UInt8(ascii: "\"") || byte == UInt8(ascii: "\\") {
                    if runStart < index {
                        units += String(decoding: UnsafeBufferPointer(rebasing: bytes[runStart..<index]), as: UTF8.self).utf16
                    }

                    index += 1

                    if byte == UInt8(ascii: "\"") { break }

                    guard let escape = current else { throw failure() }

                    index += 1

                    switch escape {
                    case UInt8(ascii: "\""): units.append(0x22)
                    case UInt8(ascii: "\\"): units.append(0x5C)
                    case UInt8(ascii: "/"): units.append(0x2F)
                    case UInt8(ascii: "b"): units.append(0x08)
                    case UInt8(ascii: "f"): units.append(0x0C)
                    case UInt8(ascii: "n"): units.append(0x0A)
                    case UInt8(ascii: "r"): units.append(0x0D)
                    case UInt8(ascii: "t"): units.append(0x09)
                    case UInt8(ascii: "u"): units.append(try hex4())
                    default: throw failure()
                    }

                    runStart = index
                    continue
                }

                guard byte >= 0x20 else { throw failure() }
                index += 1
            }

            // `String(decoding:)` would repair a lone surrogate to U+FFFD; an
            // `NSString` keeps the unit, exactly as `JSON.parse` does.
            if units.contains(where: { (0xD800...0xDFFF).contains($0) }) {
                return NSString(characters: units, length: units.count) as String
            }

            return String(decoding: units, as: UTF16.self)
        }

        mutating func hex4() throws -> UInt16 {
            var value: UInt16 = 0

            for _ in 0..<4 {
                guard let byte = current else { throw failure() }
                let digit: UInt8

                switch byte {
                case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = byte - UInt8(ascii: "0")
                case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = byte - UInt8(ascii: "a") + 10
                case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = byte - UInt8(ascii: "A") + 10
                default: throw failure()
                }

                value = value << 4 | UInt16(digit)
                index += 1
            }

            return value
        }

        mutating func digits() -> Int {
            let start = index
            while let byte = current, byte >= UInt8(ascii: "0"), byte <= UInt8(ascii: "9") { index += 1 }
            return index - start
        }

        /// RFC 8259's number grammar, validated here, then handed to
        /// `Double(String)` — correctly rounded — or to `Int64` when the literal
        /// has neither a fraction nor an exponent and fits.
        mutating func number() throws -> Any {
            let start = index
            var integral = true

            if current == UInt8(ascii: "-") { index += 1 }

            if current == UInt8(ascii: "0") {
                index += 1
            } else {
                guard digits() > 0 else { throw failure() }
            }

            if current == UInt8(ascii: ".") {
                index += 1
                integral = false
                guard digits() > 0 else { throw failure() }
            }

            if current == UInt8(ascii: "e") || current == UInt8(ascii: "E") {
                index += 1
                integral = false
                if current == UInt8(ascii: "+") || current == UInt8(ascii: "-") { index += 1 }
                guard digits() > 0 else { throw failure() }
            }

            let text = String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<index]), as: UTF8.self)

            // `-0` is a double: `JSON.parse("-0")` keeps the sign an integer cannot.
            if integral, text != "-0", let exact = Int64(text) { return NSNumber(value: exact) }

            guard let double = Double(text) else { throw failure() }

            return NSNumber(value: double)
        }
    }
}
