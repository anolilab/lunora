import Foundation

/// The single endpoint every query/mutation/action posts to.
public let lunoraRPCPath = "/_lunora/rpc"
/// The live-subscription endpoint.
public let lunoraWSPath = "/_lunora/ws"

/// Which RPC method a call dispatches to. Generated code emits these cases
/// rather than raw strings, so a typo in a target template is a compile error
/// instead of a read silently sent over the write path.
public enum LunoraVerb: String, Sendable {
    case query
    case mutation
    case action
}

/// A coded error from an RPC error envelope.
public struct LunoraAPIError: Error, CustomStringConvertible {
    public let code: String
    public let message: String
    public let data: Any?

    public init(code: String, message: String, data: Any? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    public var description: String { "\(code): \(message)" }
}

/// A subscription-scoped error the server pushed.
public struct LunoraSubscriptionError: Error, Sendable {
    public let code: String?
    public let message: String
}

/// Performs one POST. Injected rather than assumed so the conformance suite runs
/// with no network and a consumer keeps its own session, timeouts and retries.
public typealias LunoraHTTPPoster = (_ url: String, _ headers: [String: String], _ body: Data) throws -> (status: Int, body: Data)

/// Writes one JSON frame to an open socket. Injected for the same reason: this
/// package stays Foundation-only and the caller picks a WebSocket library.
public typealias LunoraFrameSender = ([String: Any]) -> Void

/// Cancels a subscription and tells the server to stop.
public typealias LunoraUnsubscribe = () -> Void

/// A Lunora deployment client.
public final class LunoraClient {
    private let baseURL: String
    private let post: LunoraHTTPPoster?

    /// The bearer token sent on every RPC. Behind the lock like everything else,
    /// so an app thread can rotate it while a socket reader is mid-frame.
    public var authToken: String? {
        get { withLock { storedAuthToken } }
        set { withLock { storedAuthToken = newValue } }
    }

    private var storedAuthToken: String?
    private var send: LunoraFrameSender?
    private var subscriptions: [String: Subscription] = [:]
    private var shapes: [String: ShapeSubscription] = [:]
    private var pokes: [String: [String: [[String: Any]]]] = [:]
    private var nextID = 0
    private var nextShapeID = 0

    /// Serialises every mutable field above, and the `cursor`/`epoch`/row state
    /// hanging off `Subscription` and `ShapeSubscription`.
    ///
    /// Two threads normally drive this client: a socket reader calling
    /// ``handleFrame(_:)`` and the app thread calling ``subscribe(_:args:onData:onError:shardKey:)``.
    /// A Swift `Dictionary` is not atomic — a concurrent insert during a resize
    /// is a memory error, not a lost write.
    ///
    /// Frames and user callbacks are invoked OUTSIDE the lock. `send` writes a
    /// socket the consumer owns, and `NSLock` is not recursive, so a callback
    /// that subscribes would deadlock if it ran under the lock.
    private let lock = NSLock()

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }

        return try body()
    }

    private final class Subscription {
        let functionPath: String
        let args: Any?
        let onData: ((Any) -> Void)?
        let onError: ((LunoraSubscriptionError) -> Void)?
        var cursor: Any?
        var epoch: Any?

        init(functionPath: String, args: Any?, onData: ((Any) -> Void)?, onError: ((LunoraSubscriptionError) -> Void)?) {
            self.functionPath = functionPath
            self.args = args
            self.onData = onData
            self.onError = onError
        }
    }

    private final class ShapeSubscription {
        let name: String
        let onRows: (([Any]) -> Void)?
        let onError: ((LunoraSubscriptionError) -> Void)?
        var rows: [String: Any] = [:]
        var order: [String] = []
        var checkpoint: Any?
        var epoch: Any?

        init(name: String, onRows: (([Any]) -> Void)?, onError: ((LunoraSubscriptionError) -> Void)?) {
            self.name = name
            self.onRows = onRows
            self.onError = onError
        }
    }

    public init(url: String, post: LunoraHTTPPoster? = nil, authToken: String? = nil) {
        self.baseURL = url
        self.post = post
        self.authToken = authToken
    }

    /// Registers the sender used for subscription frames. Call once the socket is open.
    public func attachSocket(_ sender: @escaping LunoraFrameSender) { withLock { send = sender } }

    // MARK: - RPC

    /// Builds the `POST /_lunora/rpc` body. `shardKey` is omitted when nil,
    /// which routes to the default shard.
    public static func buildRPCBody(functionPath: String, args: Any?, shardKey: String? = nil) throws -> [String: Any] {
        var body: [String: Any] = [
            "args": try Wire.encode(args ?? [String: Any]()),
            "functionPath": functionPath,
        ]
        if let shardKey { body["shardKey"] = shardKey }
        return body
    }

    /// Returns the decoded result, or throws ``LunoraAPIError``.
    ///
    /// `status` is required for correctness, not diagnostics: `protocol/README.md`
    /// §4.2 says a non-2xx whose body carries no `error` envelope surfaces as an
    /// INTERNAL transport error. Without it a 502 with body `{"message":"…"}`
    /// returns nil and throws nothing — the caller believes its mutation committed.
    public static func parseRPCResponse(_ body: [String: Any], status: Int = 200) throws -> Any {
        if let envelope = body["error"] as? [String: Any] {
            let data = envelope["data"].flatMap { $0 is NSNull ? nil : try? Wire.decode($0) }
            throw LunoraAPIError(
                code: envelope["code"] as? String ?? "INTERNAL",
                message: envelope["message"] as? String ?? "request failed",
                data: data
            )
        }

        guard (200...299).contains(status) else {
            throw LunoraAPIError(code: "INTERNAL", message: "HTTP \(status) without an error envelope")
        }

        return try Wire.decode(body["result"])
    }

    public func query(_ functionPath: String, args: Any? = nil, shardKey: String? = nil) throws -> Any {
        try rpc(functionPath, args: args, shardKey: shardKey, mutationID: nil)
    }

    public func mutation(_ functionPath: String, args: Any? = nil, shardKey: String? = nil, mutationID: String? = nil) throws -> Any {
        try rpc(functionPath, args: args, shardKey: shardKey, mutationID: mutationID)
    }

    /// Same envelope as a mutation, but never an idempotency key: an action
    /// performs external side effects and is not replayed against the shard, so
    /// claiming mutation-style de-duplication for it would be a lie.
    public func action(_ functionPath: String, args: Any? = nil, shardKey: String? = nil) throws -> Any {
        try rpc(functionPath, args: args, shardKey: shardKey, mutationID: nil)
    }

    private func rpc(_ functionPath: String, args: Any?, shardKey: String?, mutationID: String?) throws -> Any {
        guard let post else { throw LunoraAPIError(code: "INTERNAL", message: "no HTTP poster configured") }

        var headers = ["content-type": "application/json"]
        if let authToken { headers["authorization"] = "Bearer \(authToken)" }
        if let mutationID { headers["x-lunora-mutation-id"] = mutationID }

        let body = try LunoraClient.buildRPCBody(functionPath: functionPath, args: args, shardKey: shardKey)
        let payload = try JSONSerialization.data(withJSONObject: body)
        let (status, raw) = try post(join(lunoraRPCPath), headers, payload)
        let parsed = try JSONSerialization.jsonObject(with: raw) as? [String: Any] ?? [:]
        return try LunoraClient.parseRPCResponse(parsed, status: status)
    }

    /// Projects a generated model into the dictionary tree ``Wire/encode(_:depth:)``
    /// accepts, through its `Codable` conformance — the same field names the
    /// model declares, and therefore the names the server expects.
    ///
    /// The JSON bounce is safe HERE, unlike in the Go codec's struct path,
    /// because a generated model can never contain a wire wrapper: the
    /// generator refuses to emit a typed model for any schema carrying a
    /// `v.bigint()` or `v.bytes()` (see `hasUnrepresentableWireType`), which
    /// are exactly the values a JSON round-trip would flatten.
    ///
    /// `nullablePaths` repairs the one thing that bounce loses. Synthesized
    /// `Codable` OMITS a nil property, which is right for an unset
    /// `v.optional()` — the validator rejects an explicit null — and wrong for a
    /// required `v.nullable()`, which the validator needs present holding null. A
    /// struct whose `nickname` is explicitly nil encodes to `{"id":"r1"}`, so
    /// that argument could never be sent at all. Nothing in the rendered struct
    /// tells the two apart (both are `T?`, and the generated `init` gives neither
    /// a default), so the generated call site passes the paths the SCHEMA says
    /// are required-and-nullable; see `ModelNullPaths` in
    /// `packages/codegen/src/sdk/spec.ts`.
    ///
    /// Restoring is exact rather than a guess: at a REQUIRED path an absent key
    /// can only be a nil the encoder dropped, so putting the null back is the
    /// value the caller passed.
    public static func wireValue<T: Encodable>(_ value: T, nullablePaths: [[String]] = []) throws -> Any {
        let data = try JSONEncoder().encode(value)
        let tree = try JSONSerialization.jsonObject(with: data)

        return nullablePaths.isEmpty ? tree : restoreNulls(tree, nullablePaths, [])
    }

    /// Whether `candidate`'s leading segments match `path`, treating `*` — the
    /// segment standing for an array element or record value — as any key.
    private static func matchesPrefix(_ candidate: [String], _ path: [String]) -> Bool {
        for (index, segment) in path.enumerated() where candidate[index] != "*" && candidate[index] != segment {
            return false
        }

        return true
    }

    private static func restoreNulls(_ value: Any, _ paths: [[String]], _ path: [String]) -> Any {
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]

            for (key, item) in dictionary {
                result[key] = restoreNulls(item, paths, path + [key])
            }

            // Put back each required-nullable key of THIS object that the encoder
            // dropped. A `*` is never restored: a record's absent key was never
            // sent, and inventing one would put a null where the caller had
            // nothing at all.
            for candidate in paths where candidate.count == path.count + 1 && matchesPrefix(candidate, path) {
                let key = candidate[path.count]

                if key != "*" && result[key] == nil {
                    result[key] = NSNull()
                }
            }

            return result
        }

        if let array = value as? [Any] {
            return array.map { restoreNulls($0, paths, path + ["*"]) }
        }

        return value
    }

    // MARK: - Frame builders

    public static func buildConnectFrame(clientID: String? = nil, context: [String: Any]? = nil) -> [String: Any] {
        var frame: [String: Any] = ["id": "connect", "type": "connect"]
        if let clientID { frame["clientId"] = clientID }
        if let context { frame["context"] = context }
        return frame
    }

    public static func buildSubscribeFrame(
        id: String,
        functionPath: String,
        args: Any?,
        table: String? = nil,
        sinceSeq: Any? = nil,
        sinceEpoch: Any? = nil
    ) throws -> [String: Any] {
        var query: [String: Any] = [
            "args": try Wire.encode(args ?? [String: Any]()),
            "functionPath": functionPath,
            "table": table ?? functionPath,
        ]
        if let sinceSeq { query["sinceSeq"] = sinceSeq }
        if let sinceEpoch { query["sinceEpoch"] = sinceEpoch }
        return ["id": id, "query": query, "type": "subscribe"]
    }

    public static func buildUnsubscribeFrame(id: String) -> [String: Any] {
        ["id": id, "type": "unsubscribe"]
    }

    public static func buildShapeSubscribeFrame(
        id: String,
        name: String,
        args: Any? = nil,
        sinceCheckpoint: Any? = nil,
        sinceEpoch: Any? = nil
    ) throws -> [String: Any] {
        var shape: [String: Any] = ["name": name]
        if let args { shape["args"] = try Wire.encode(args) }
        var frame: [String: Any] = ["id": id, "shape": shape, "type": "shape_subscribe"]
        if let sinceCheckpoint { frame["sinceCheckpoint"] = sinceCheckpoint }
        if let sinceEpoch { frame["sinceEpoch"] = sinceEpoch }
        return frame
    }

    public static func buildShapeUnsubscribeFrame(id: String) -> [String: Any] {
        ["id": id, "type": "shape_unsubscribe"]
    }

    // MARK: - Subscriptions

    @discardableResult
    public func subscribe(
        _ functionPath: String,
        args: Any?,
        onData: ((Any) -> Void)?,
        onError: ((LunoraSubscriptionError) -> Void)? = nil,
        shardKey: String? = nil
    ) -> LunoraUnsubscribe {
        let (id, sender) = withLock { () -> (String, LunoraFrameSender?) in
            nextID += 1
            let id = "sub_\(nextID)"
            subscriptions[id] = Subscription(functionPath: functionPath, args: args, onData: onData, onError: onError)

            return (id, send)
        }

        if let sender, let frame = try? LunoraClient.buildSubscribeFrame(id: id, functionPath: functionPath, args: args) {
            sender(frame)
        }

        return { [weak self] in
            guard let self else { return }

            let sender = self.withLock { () -> LunoraFrameSender? in
                self.subscriptions.removeValue(forKey: id)

                return self.send
            }

            sender?(LunoraClient.buildUnsubscribeFrame(id: id))
        }
    }

    /// Opens a partially-replicated keyed view. `onRows` fires once per applied
    /// poke with the view's full contents, in insertion order.
    @discardableResult
    public func subscribeShape(
        _ name: String,
        args: Any? = nil,
        onRows: (([Any]) -> Void)?,
        onError: ((LunoraSubscriptionError) -> Void)? = nil
    ) -> LunoraUnsubscribe {
        let (id, sender) = withLock { () -> (String, LunoraFrameSender?) in
            nextShapeID += 1
            let id = "shape_\(nextShapeID)"
            shapes[id] = ShapeSubscription(name: name, onRows: onRows, onError: onError)

            return (id, send)
        }

        if let sender, let frame = try? LunoraClient.buildShapeSubscribeFrame(id: id, name: name, args: args) {
            sender(frame)
        }

        return { [weak self] in
            guard let self else { return }

            let sender = self.withLock { () -> LunoraFrameSender? in
                self.shapes.removeValue(forKey: id)

                return self.send
            }

            sender?(LunoraClient.buildShapeUnsubscribeFrame(id: id))
        }
    }

    /// Re-subscribes everything after a reconnect, carrying each subscription's
    /// resume cursor so the server can skip results that have not changed.
    ///
    /// Without this the `cursor`/`epoch` tracked on every `data` frame would be
    /// write-only state and a reconnect would silently re-seed from scratch.
    public func resendSubscriptions() {
        // The frames are BUILT under the lock, not just the map iteration: each
        // one reads `cursor`/`epoch`, which the frame handler writes. Snapshotting
        // the entries and reading their cursors afterwards resends a torn one.
        let (sender, frames) = withLock { () -> (LunoraFrameSender?, [[String: Any]]) in
            guard send != nil else { return (nil, []) }

            let frames = subscriptions.compactMap { id, entry in
                try? LunoraClient.buildSubscribeFrame(
                    id: id,
                    functionPath: entry.functionPath,
                    args: entry.args,
                    sinceSeq: entry.cursor,
                    sinceEpoch: entry.epoch
                )
            }

            return (send, frames)
        }

        guard let sender else { return }

        for frame in frames {
            sender(frame)
        }
    }

    // MARK: - Inbound frames

    /// Applies one server frame and returns its type. Unknown types are ignored,
    /// per the protocol's forward-compatibility rule.
    @discardableResult
    public func handleFrame(_ raw: String) throws -> String? {
        if raw == "lunora-ping" || raw == "lunora-pong" { return nil }
        guard let data = raw.data(using: .utf8),
            let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            // Non-JSON frames are ignored by the client parser, not fatal.
            return nil
        }

        return try dispatch(frame)
    }

    private func dispatch(_ frame: [String: Any]) throws -> String? {
        let kind = frame["type"] as? String
        let id = frame["id"] as? String

        // Every case below looks the subscription up UNDER the lock and hands the
        // callback back out, rather than resolving `entry` once up here: the app
        // thread can unsubscribe between the lookup and the call, and `advance`
        // writes state the lock exists to protect.
        switch kind {
        case "ack": return kind
        case "data", "delta":
            let payload = (frame["data"] is NSNull ? nil : frame["data"]) ?? frame["delta"]
            let value = try Wire.decode(payload)
            let onData = withLock { () -> ((Any) -> Void)? in
                guard let id, let entry = subscriptions[id] else { return nil }

                advance(entry, frame)

                return entry.onData
            }

            onData?(value)

            return kind
        case "resume", "settled":
            withLock {
                if let id, let entry = subscriptions[id] { advance(entry, frame) }
            }

            return kind
        case "error":
            let envelope = frame["error"] as? [String: Any] ?? [:]
            let error = LunoraSubscriptionError(
                code: envelope["code"] as? String,
                message: frame["message"] as? String ?? envelope["message"] as? String ?? "subscription error"
            )
            let handlers = withLock { () -> [(LunoraSubscriptionError) -> Void] in
                guard let id else { return [] }

                return [subscriptions[id]?.onError, shapes[id]?.onError].compactMap { $0 }
            }

            for handler in handlers {
                handler(error)
            }

            return kind
        case "complete":
            withLock {
                if let id { subscriptions.removeValue(forKey: id) }
            }

            return kind
        case "pokeStart":
            withLock {
                if let pokeID = frame["pokeId"] as? String { pokes[pokeID] = [:] }
            }

            return kind
        case "pokePart":
            bufferPokePart(frame)
            return kind
        case "pokeEnd":
            try applyPoke(frame)
            return kind
        default: return kind
        }
    }

    private func advance(_ entry: Subscription, _ frame: [String: Any]) {
        if let cursor = frame["cursor"] { entry.cursor = cursor }
        if let epoch = frame["epoch"] { entry.epoch = epoch }
    }

    /// Parts buffer until `pokeEnd`: a poke is an atomic batch, so applying them
    /// as they arrive would expose a torn view, and a socket dropping mid-poke
    /// would leave it permanently half-applied.
    private func bufferPokePart(_ frame: [String: Any]) {
        withLock {
            guard let pokeID = frame["pokeId"] as? String,
                let shapeID = frame["shapeId"] as? String,
                // A part for an unknown poke is dropped: without its pokeStart
                // there is no batch to join, and guessing applies a fragment.
                pokes[pokeID] != nil
            else { return }

            let operations = (frame["rowsPatch"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
            pokes[pokeID]?[shapeID, default: []].append(contentsOf: operations)
        }
    }

    private func applyPoke(_ frame: [String: Any]) throws {
        // The view is mutated under the lock; `onRows` fires after it is released,
        // with the row snapshot taken while still holding it — so a callback sees
        // one consistent poke even if the next one lands mid-delivery.
        let deliveries = try withLock { () -> [(([Any]) -> Void, [Any])] in
            guard let pokeID = frame["pokeId"] as? String, let buffer = pokes.removeValue(forKey: pokeID) else { return [] }

            var deliveries: [(([Any]) -> Void, [Any])] = []

            for (shapeID, operations) in buffer {
                guard let shape = shapes[shapeID] else { continue }

                for operation in operations {
                    guard let key = operation["key"] as? String else { continue }

                    if operation["op"] as? String == "delete" {
                        if shape.rows.removeValue(forKey: key) != nil {
                            shape.order.removeAll { $0 == key }
                        }
                        continue
                    }

                    // A value-less upsert is membership-only; it must not blank an
                    // existing row.
                    guard let value = operation["value"], !(value is NSNull) else { continue }

                    if shape.rows[key] == nil { shape.order.append(key) }
                    shape.rows[key] = try Wire.decode(value)
                }

                if let checkpoint = frame["checkpoint"] { shape.checkpoint = checkpoint }
                if let epoch = frame["epoch"] { shape.epoch = epoch }

                if let onRows = shape.onRows {
                    deliveries.append((onRows, shape.order.compactMap { shape.rows[$0] }))
                }
            }

            return deliveries
        }

        for (onRows, rows) in deliveries {
            onRows(rows)
        }
    }

    // MARK: - URLs

    /// The socket URL: the origin with its scheme swapped, plus the shard and
    /// credential query parameters when present.
    public func wsURL(shardKey: String? = nil, token: String? = nil) -> String {
        var endpoint = join(lunoraWSPath)
        if endpoint.hasPrefix("https://") {
            endpoint = "wss://" + endpoint.dropFirst("https://".count)
        } else if endpoint.hasPrefix("http://") {
            endpoint = "ws://" + endpoint.dropFirst("http://".count)
        }

        var params: [String] = []
        if let shardKey { params.append("shard=\(percentEncode(shardKey))") }
        if let token { params.append("token=\(percentEncode(token))") }
        if params.isEmpty { return endpoint }

        return endpoint + (endpoint.contains("?") ? "&" : "?") + params.joined(separator: "&")
    }

    private func percentEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private func join(_ path: String) -> String {
        (baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL) + path
    }
}
