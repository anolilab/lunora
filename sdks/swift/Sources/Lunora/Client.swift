import Foundation

/// The single endpoint every query/mutation/action posts to.
public let lunoraRPCPath = "/_lunora/rpc"

/// Where a flush of two or more queued writes goes: one hop carrying independent
/// calls.
public let lunoraRPCBatchPath = "/_lunora/rpc-batch"
/// The live-subscription endpoint.
public let lunoraWSPath = "/_lunora/ws"

/// How many un-applied poke buffers a client retains before evicting the oldest.
///
/// A buffer is only released at its `pokeEnd`; a socket that drops mid-poke never
/// sends one, so without a bound the abandoned buffers accumulate for the life of
/// the client — one per reconnect, and unbounded against a peer that opens pokes
/// it never closes. Concurrent in-flight pokes number in the low single digits,
/// so this is far above any legitimate working set.
public let lunoraMaxPendingPokes = 64

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

    /// Whether the call reached no verdict — a 5xx, or a non-2xx carrying no
    /// envelope at all (an edge error page, a WAF block, a proxy).
    ///
    /// Set where the HTTP STATUS is still in scope, because nothing downstream
    /// can recover it: ``code`` alone cannot tell a `BAD_REQUEST` a function
    /// returned from the `INTERNAL` this client synthesises for a body that never
    /// came from one. See ``LunoraClient/isTransient(_:)``.
    public let transient: Bool

    public init(code: String, message: String, data: Any? = nil, transient: Bool = false) {
        self.code = code
        self.message = message
        self.data = data
        self.transient = transient
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
    /// Internal rather than private: the offline-capable write path is an
    /// extension in `Submit.swift`, and a Swift extension in another file sees a
    /// type's internal members but not its private ones.
    var send: LunoraFrameSender?
    var subscriptions: [String: Subscription] = [:]
    private var shapes: [String: ShapeSubscription] = [:]
    private var pokes: [String: PokeBuffer] = [:]

    /// Insertion order of `pokes`, oldest first — a Swift `Dictionary` has no
    /// order of its own, so the eviction in `handleFrame` needs this to know
    /// which buffer is the oldest.
    private var pokeOrder: [String] = []
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

    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }

        return try body()
    }

    final class Subscription {
        let functionPath: String
        let args: Any?
        /// The stable wire key of `args`, computed once at subscribe time so a
        /// write's optimistic targeting can compare without re-serialising every
        /// subscription's args on every write.
        let argsKey: String
        let shardKey: String?
        let onData: ((Any) -> Void)?
        let onError: ((LunoraSubscriptionError) -> Void)?
        var cursor: Any?
        var epoch: Any?
        /// The displayed value and its optimistic overlays. See ``LunoraOptimistic``.
        let state = LunoraOptimisticState()

        init(
            functionPath: String,
            args: Any?,
            shardKey: String?,
            onData: ((Any) -> Void)?,
            onError: ((LunoraSubscriptionError) -> Void)?
        ) {
            self.functionPath = functionPath
            self.args = args
            // A key that cannot be built (a value outside the wire codec) is the
            // empty string, which simply means no optimistic write targets this
            // subscription — never a wrong match, since a write's key is built the
            // same way and an unencodable write cannot be sent either.
            self.argsKey = (try? Wire.stableWireKey(args ?? [String: Any]())) ?? ""
            self.shardKey = shardKey
            self.onData = onData
            self.onError = onError

            if let onData { state.callbacks.append(onData) }
        }
    }

    /// One in-flight poke: the row ops buffered per shape, plus the shapes whose
    /// part carried `reset: true`.
    ///
    /// The flag is tracked per SHAPE, not per poke: one poke can re-seed one shape
    /// while delivering an ordinary diff to another on the same socket.
    private struct PokeBuffer {
        var parts: [String: [[String: Any]]] = [:]

        /// Shapes whose `rowsPatch` is the shape's COMPLETE membership rather than a
        /// diff, so the view has to be dropped before it is applied. A seed carries
        /// inserts only, so merging one leaves every row that left the shape while
        /// the socket was down on screen for the life of the client.
        var resets: Set<String> = []
    }

    private final class ShapeSubscription {
        let name: String
        /// Kept for the same reason a query keeps its `functionPath` and `args`:
        /// a reconnect has to REBUILD the subscribe frame, and a registry that
        /// only remembers the callbacks cannot.
        let args: Any?
        let onRows: (([Any]) -> Void)?
        let onError: ((LunoraSubscriptionError) -> Void)?
        var rows: [String: Any] = [:]
        var order: [String] = []
        var checkpoint: Any?
        var epoch: Any?

        init(name: String, args: Any?, onRows: (([Any]) -> Void)?, onError: ((LunoraSubscriptionError) -> Void)?) {
            self.name = name
            self.args = args
            self.onRows = onRows
            self.onError = onError
        }
    }

    /// Minted per INSTANCE, not per language. The shard namespaces an anonymous
    /// caller's idempotency rows by this value, so a shared constant would put
    /// every anonymous Swift client in one key space: two users calling the same
    /// mutation under the same caller-supplied id would collide, and the second
    /// write would short-circuit to the first one's cached result.
    var storedClientID = lunoraRandomID()
    var storedIdentity: String?
    var storedOfflineQueue = LunoraOfflineQueue()
    var wasEverConnected = false
    var closed = false

    /// `ProcessInfo.systemUptime` before which a flush is a no-op, set when a
    /// replay came back rate-limited and the envelope named a delay. Monotonic,
    /// so a wall-clock adjustment cannot strand a queue for hours.
    var storedFlushNotBefore: TimeInterval = 0
    var settledListeners: [(LunoraMutationSettled) -> Void] = []

    /// Identifies this client to the shard. It rides every write that carries an
    /// idempotency key, because an anonymous caller has no server-minted user id
    /// to namespace its de-duplication rows by.
    ///
    /// A fresh id is minted per instance. Pin a stable per-device one here when
    /// the offline queue is DURABLE: a write restored after a restart replays
    /// under the id that issued it, so leaving each session to mint its own means
    /// the server sees a namespace no live client answers to.
    public var clientID: String {
        get { withLock { storedClientID } }
        set { withLock { storedClientID = newValue } }
    }

    /// An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id,
    /// not a bearer token. It is persisted alongside every queued write and
    /// re-checked before that write replays, so a restart cannot push one user's
    /// queued writes as another. Nil means signed out, which is itself an identity
    /// a write can be stamped with.
    public var identity: String? {
        get { withLock { storedIdentity } }
        set { withLock { storedIdentity = newValue } }
    }

    /// The durable write queue backing ``submit(_:)``.
    public var offlineQueue: LunoraOfflineQueue {
        get { withLock { storedOfflineQueue } }
        set { withLock { storedOfflineQueue = newValue } }
    }

    public init(url: String, post: LunoraHTTPPoster? = nil, authToken: String? = nil) {
        self.baseURL = url
        self.post = post
        self.authToken = authToken
    }

    /// Registers the sender used for subscription frames. Call once the socket is
    /// open.
    ///
    /// It also latches "has connected at least once", which is what the write
    /// queue gates on: a write made before the FIRST connect fails fast by
    /// default, so a misconfigured endpoint surfaces on the first write instead of
    /// silently filling a queue that will never flush.
    public func attachSocket(_ sender: @escaping LunoraFrameSender) {
        withLock {
            send = sender
            wasEverConnected = true
        }
    }

    /// Forgets the sender, so subsequent writes queue rather than fail.
    public func detachSocket() { withLock { send = nil } }

    /// Whether a socket is currently attached.
    public var online: Bool { withLock { send != nil } }

    /// How many writes are waiting for the socket.
    public var pendingMutationCount: Int { withLock { storedOfflineQueue.size } }

    /// Observes every queued write's terminal verdict.
    ///
    /// This is the ONLY report a write restored from durable storage produces —
    /// its original caller did not survive the restart.
    public func onMutationSettled(_ listener: @escaping (LunoraMutationSettled) -> Void) {
        withLock { settledListeners.append(listener) }
    }

    /// Rejects every queued write so no caller waits on a dead client. Durable
    /// storage is untouched: the next session restores those writes.
    public func close() {
        let queue = withLock { () -> LunoraOfflineQueue in
            closed = true
            send = nil

            return storedOfflineQueue
        }

        reportDiscarded(withLock { queue.clear() })
    }

    // MARK: - RPC

    /// Builds the `POST /_lunora/rpc` body. `shardKey` is omitted when nil or
    /// empty, which routes to the default shard.
    ///
    /// Empty means ABSENT, not "the shard named `\"\"`". The runtime disagrees —
    /// it takes any string as a named shard and routes `""` to its own Durable
    /// Object — while this client treats `""` and nil as one shard everywhere it
    /// matches a subscription or drains the queue (``lunoraSameShard``). Sending
    /// it split those two views: a single-call replay of a write queued with
    /// `""` landed on a different Durable Object than a BATCHED replay of the
    /// same write (``LunoraSubmit`` already omitted it), and the optimistic
    /// overlay tracked neither.
    public static func buildRPCBody(functionPath: String, args: Any?, shardKey: String? = nil) throws -> [String: Any] {
        var body: [String: Any] = [
            "args": try Wire.encode(args ?? [String: Any]()),
            "functionPath": functionPath,
        ]
        if let key = namedShard(shardKey) { body["shardKey"] = key }
        return body
    }

    /// The shard key as the wire carries it: nil for the default shard, which an
    /// empty string also names. One place, so the RPC body and the socket URL
    /// cannot drift apart again.
    static func namedShard(_ shardKey: String?) -> String? {
        guard let shardKey, !shardKey.isEmpty else { return nil }
        return shardKey
    }

    /// Returns the decoded result, or throws ``LunoraAPIError``.
    ///
    /// `status` is required for correctness, not diagnostics: `protocol/README.md`
    /// §4.2 says a non-2xx whose body carries no `error` envelope surfaces as an
    /// INTERNAL transport error. Without it a 502 with body `{"message":"…"}`
    /// returns nil and throws nothing — the caller believes its mutation committed.
    public static func parseRPCResponse(_ body: [String: Any], status: Int) throws -> Any {
        if let envelope = body["error"] as? [String: Any] {
            let data = envelope["data"].flatMap { $0 is NSNull ? nil : try? Wire.decode($0) }
            throw LunoraAPIError(
                code: envelope["code"] as? String ?? "INTERNAL",
                message: envelope["message"] as? String ?? "request failed",
                data: data,
                // A 5xx is the shard or the edge failing under the call, not a
                // verdict on it, so a queued write replayed under the same
                // idempotency key is still good.
                transient: status >= 500
            )
        }

        guard (200...299).contains(status) else {
            // No envelope at all, so this body never came from a Lunora function:
            // an edge error page, a WAF block, a proxy. Nothing reached the shard,
            // which makes it transport rather than a verdict — the batch path
            // already classified the identical response that way, and a lone
            // queued write must not be dropped for being alone.
            throw LunoraAPIError(code: "INTERNAL", message: "HTTP \(status) without an error envelope", transient: true)
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
        try rpcFull(functionPath, args: args, shardKey: shardKey, mutationID: mutationID).result
    }

    /// The CDC cursor a write committed at, echoed on a mutation's response.
    ///
    /// Nil when the call was a read, or when the shard has CDC off — the degraded
    /// case the optimistic engine falls back to one-shot behaviour for.
    public static func parseCommitCursor(_ body: [String: Any]) -> Int? {
        intValue(body["commitCursor"])
    }

    /// A JSON number as an `Int`, or nil for anything else.
    ///
    /// Booleans are excluded explicitly: `NSNumber` bridges JSON `true` to `1`, so
    /// a peer sending `"commitCursor": true` would otherwise confirm every
    /// optimistic layer at cursor 1.
    static func intValue(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }

        return number.intValue
    }

    /// An integer from a JSON value, rejecting the `Bool` that bridges to `NSNumber`.
    ///
    /// The same guard ``parseCommitCursor(_:)`` uses, reused for a batch slot's
    /// `id` and `commitCursor` so a `true` cannot be read as `1`.
    static func parseSlotID(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }

        return number.intValue
    }

    /// Rebuilds a ``LunoraAPIError`` from a slot's or a batch's error envelope,
    /// defaulting the way ``parseRPCResponse(_:status:)`` does.
    static func batchSlotError(_ envelope: [String: Any], fallback: String, transient: Bool = false) -> LunoraAPIError {
        LunoraAPIError(
            code: envelope["code"] as? String ?? "INTERNAL",
            message: envelope["message"] as? String ?? fallback,
            data: envelope["data"].flatMap { try? Wire.decode($0) },
            transient: transient
        )
    }

    /// One round-trip, keeping the echoed `commitCursor`.
    ///
    /// The cursor is what gates an optimistic overlay's removal, so it has to
    /// survive the call rather than be discarded by ``parseRPCResponse(_:status:)``.
    /// `issuingClientID` overrides this session's, so a replayed write namespaces
    /// server-side under the id that ISSUED it.
    func rpcFull(
        _ functionPath: String,
        args: Any?,
        shardKey: String?,
        mutationID: String?,
        issuingClientID: String? = nil
    ) throws -> (result: Any, commitCursor: Int?) {
        guard let post else { throw LunoraAPIError(code: "INTERNAL", message: "no HTTP poster configured") }

        var headers = ["content-type": "application/json"]
        if let authToken { headers["authorization"] = "Bearer \(authToken)" }

        if let mutationID {
            headers["x-lunora-mutation-id"] = mutationID
            // Rides WITH the idempotency key, never alone. An anonymous caller has
            // no server-minted user id, so the shard namespaces its de-duplication
            // rows by this client id instead; without one every anonymous client
            // shares a single key space and a colliding mutation id suppresses
            // another client's write.
            headers["x-lunora-client-id"] = issuingClientID ?? clientID
        }

        let body = try LunoraClient.buildRPCBody(functionPath: functionPath, args: args, shardKey: shardKey)
        let payload = try JSONSerialization.data(withJSONObject: body)
        let (status, raw) = try post(join(lunoraRPCPath), headers, payload)
        let parsed = try JSONSerialization.jsonObject(with: raw) as? [String: Any] ?? [:]

        return (try LunoraClient.parseRPCResponse(parsed, status: status), LunoraClient.parseCommitCursor(parsed))
    }

    /// POSTs one `/_lunora/rpc-batch` chunk, returning the parsed body.
    ///
    /// No `x-lunora-mutation-id` on the request: a batch is ONE transport hop
    /// carrying independent calls, so each entry carries its own idempotency key
    /// and client id in the body. A single outer header would name one write and
    /// de-duplicate the whole chunk against it.
    func rpcBatch(_ calls: [Any]) throws -> (status: Int, body: [String: Any]) {
        guard let post else { throw LunoraAPIError(code: "INTERNAL", message: "no HTTP poster configured") }

        var headers = ["content-type": "application/json"]
        if let authToken { headers["authorization"] = "Bearer \(authToken)" }

        let payload = try JSONSerialization.data(withJSONObject: ["calls": calls])
        // The status is returned, not discarded: a whole-batch envelope is only
        // a verdict on its entries when the shard answered, and that is what the
        // status says.
        let (status, raw) = try post(join(lunoraRPCBatchPath), headers, payload)

        return (status, try JSONSerialization.jsonObject(with: raw) as? [String: Any] ?? [:])
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
            subscriptions[id] = Subscription(
                functionPath: functionPath,
                args: args,
                shardKey: shardKey,
                onData: onData,
                onError: onError
            )

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

    /// One item delivered by ``stream(_:args:shardKey:)``: a value, or the
    /// subscription error the server pushed.
    ///
    /// One sequence carrying both, rather than a value stream plus an error
    /// stream: a consumer awaiting two of them can read them out of order, and
    /// the whole point of a stream is that what arrived first is delivered first.
    public enum LunoraStreamEvent {
        case value(Any)
        case failure(LunoraSubscriptionError)
    }

    /// A live query as an `AsyncStream`, for `for await event in stream`.
    ///
    /// Each call opens its OWN subscription — at CALL time, so a frame arriving
    /// before the loop starts is not lost — and it is torn down when the stream
    /// terminates: breaking out of the loop, cancelling the task, or finishing
    /// it. A consumer never holds an unsubscribe handle. Use
    /// ``subscribe(_:args:onData:onError:shardKey:)`` directly when the value
    /// outlives one loop.
    ///
    /// The buffer is UNBOUNDED, so the frame dispatcher never blocks on a slow
    /// consumer; the trade is that one which stops reading without ending the
    /// loop grows the buffer.
    public func stream(_ functionPath: String, args: Any? = nil, shardKey: String? = nil) -> AsyncStream<LunoraStreamEvent> {
        AsyncStream(LunoraStreamEvent.self, bufferingPolicy: .unbounded) { continuation in
            let unsubscribe = subscribe(
                functionPath,
                args: args,
                onData: { continuation.yield(.value($0)) },
                onError: { continuation.yield(.failure($0)) },
                shardKey: shardKey
            )

            continuation.onTermination = { _ in unsubscribe() }
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
            shapes[id] = ShapeSubscription(name: name, args: args, onRows: onRows, onError: onError)

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
    /// BOTH registries. A resend that walks only the queries leaves every shape
    /// view subscribed to a socket that no longer exists — silently, and for the
    /// rest of the process's life.
    ///
    /// Without this the `cursor`/`epoch` tracked on every `data` frame would be
    /// write-only state and a reconnect would silently re-seed from scratch.
    public func resendSubscriptions() {
        // The frames are BUILT under the lock, not just the map iteration: each
        // one reads `cursor`/`epoch`, which the frame handler writes. Snapshotting
        // the entries and reading their cursors afterwards resends a torn one.
        let (sender, frames) = withLock { () -> (LunoraFrameSender?, [[String: Any]]) in
            guard send != nil else { return (nil, []) }

            var frames = subscriptions.compactMap { id, entry in
                try? LunoraClient.buildSubscribeFrame(
                    id: id,
                    functionPath: entry.functionPath,
                    args: entry.args,
                    sinceSeq: entry.cursor,
                    sinceEpoch: entry.epoch
                )
            }

            frames += shapes.compactMap { id, entry in
                try? LunoraClient.buildShapeSubscribeFrame(
                    id: id,
                    name: entry.name,
                    args: entry.args,
                    sinceCheckpoint: entry.checkpoint,
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

    /// The layered value one live subscription displays.
    ///
    /// Internal: no consumer needs it — the conformance suite asserts layer counts
    /// and the tracked cursor on the state a REAL frame produced, rather than on a
    /// hand-built copy of one.
    func optimisticState(_ id: String) -> LunoraOptimisticState? {
        withLock { subscriptions[id]?.state }
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
            let value: Any

            do {
                value = try Wire.decode(payload)
            } catch {
                // Scoped to the subscription it was addressed to. Throwing out of
                // here ends the caller's read loop, and with it every OTHER
                // subscription on this client — one peer's malformed payload
                // silently taking the whole socket down.
                let handlers = withLock { () -> [(LunoraSubscriptionError) -> Void] in
                    guard let id, let onError = subscriptions[id]?.onError else { return [] }

                    return [onError]
                }

                for handler in handlers {
                    handler(LunoraSubscriptionError(code: "INVALID_FRAME", message: "frame payload could not be decoded: \(error)"))
                }

                return "error"
            }

            let deferred = withLock { () -> LunoraOptimistic.Deferred in
                guard let id, let entry = subscriptions[id] else { return [] }

                advance(entry, frame)

                var queued: LunoraOptimistic.Deferred = []

                entry.state.serverBase = value
                // Only when the frame CARRIES one: `cursor` is optional on
                // data/delta frames, and nulling the tracked cursor strands every
                // pending layer — a later `confirm(commitCursor)` has nothing to
                // compare against, so the overlay it should have dropped stays and
                // the write renders twice.
                if let cursor = LunoraClient.intValue(frame["cursor"]) { entry.state.serverCursor = cursor }
                // Drop the overlays this frame has caught up with, then RE-FOLD the
                // rest onto the new authoritative base rather than clobbering them:
                // a still-queued write's predicted value has to survive an
                // unrelated delta on the same query.
                LunoraOptimistic.dropConfirmedLayers(entry.state, entry.state.serverCursor)
                LunoraOptimistic.notify(
                    entry.state,
                    LunoraOptimistic.fold(entry.state.serverBase, entry.state.layers),
                    &queued
                )

                return queued
            }

            LunoraClient.runDeferred(deferred)

            return kind
        case "resume", "settled":
            let deferred = withLock { () -> LunoraOptimistic.Deferred in
                guard let id, let entry = subscriptions[id] else { return [] }

                advance(entry, frame)

                // A resume/settled frame advances the cursor without a value
                // change — but a write whose result was byte-identical for this
                // query still committed at or under this cursor, so its overlay is
                // confirmed. Sweep here too, not just on data frames, or a
                // no-visible-change write leaves its prediction on screen until
                // some unrelated write happens to produce a data frame —
                // indefinitely on a quiet query.
                if let cursor = LunoraClient.intValue(frame["cursor"]) { entry.state.serverCursor = cursor }

                guard LunoraOptimistic.dropConfirmedLayers(entry.state, entry.state.serverCursor) else { return [] }

                var queued: LunoraOptimistic.Deferred = []

                LunoraOptimistic.notify(
                    entry.state,
                    LunoraOptimistic.fold(entry.state.serverBase, entry.state.layers),
                    &queued
                )

                return queued
            }

            LunoraClient.runDeferred(deferred)

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
                if let pokeID = frame["pokeId"] as? String {
                    if pokes[pokeID] == nil { pokeOrder.append(pokeID) }

                    pokes[pokeID] = PokeBuffer()

                    // Evict oldest-first at the cap; a poke that old is no
                    // longer going to see its `pokeEnd`.
                    while pokeOrder.count > lunoraMaxPendingPokes {
                        pokes.removeValue(forKey: pokeOrder.removeFirst())
                    }
                }
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
            pokes[pokeID]?.parts[shapeID, default: []].append(contentsOf: operations)

            // Recorded sticky (never cleared) so a server that splits one seed across
            // several parts still replaces rather than merges. `reset` is the ONLY
            // signal: a missing `baseCheckpoint` does not imply a seed, and a
            // retention re-seed arrives with the epoch unchanged.
            if frame["reset"] as? Bool == true { pokes[pokeID]?.resets.insert(shapeID) }
        }
    }

    private func applyPoke(_ frame: [String: Any]) throws {
        // The view is mutated under the lock; `onRows` fires after it is released,
        // with the row snapshot taken while still holding it — so a callback sees
        // one consistent poke even if the next one lands mid-delivery.
        let deliveries = try withLock { () -> [(([Any]) -> Void, [Any])] in
            guard let pokeID = frame["pokeId"] as? String, let buffer = pokes.removeValue(forKey: pokeID) else { return [] }

            // Drop it from the eviction order too, or that array grows a stale
            // entry per completed poke and stops tracking the map.
            pokeOrder.removeAll { $0 == pokeID }

            var deliveries: [(([Any]) -> Void, [Any])] = []

            for (shapeID, operations) in buffer.parts {
                guard let shape = shapes[shapeID] else { continue }

                // A reset part is the shape's complete membership, so it is
                // authoritative on its own: drop what we hold before applying it.
                // `.global()` shapes re-seed in full on EVERY reconnect and an op-log
                // shape past changelog retention does too, so without this a row
                // deleted while the socket was down is never removed.
                if buffer.resets.contains(shapeID) {
                    shape.rows.removeAll()
                    shape.order.removeAll()
                }

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
        // Empty is absent, matching `buildRPCBody` — see its comment.
        if let key = LunoraClient.namedShard(shardKey) { params.append("shard=\(percentEncode(key))") }
        if let token { params.append("token=\(percentEncode(token))") }
        if params.isEmpty { return endpoint }

        return endpoint + (endpoint.contains("?") ? "&" : "?") + params.joined(separator: "&")
    }

    private func percentEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    /// Runs the notifications queued while the lock was held.
    static func runDeferred(_ deferred: LunoraOptimistic.Deferred) {
        for call in deferred {
            call()
        }
    }

    private func join(_ path: String) -> String {
        (baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL) + path
    }
}
