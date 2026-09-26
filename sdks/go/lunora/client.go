package lunora

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	// RPCPath is the single endpoint every query/mutation/action posts to.
	RPCPath = "/_lunora/rpc"
	// RPCBatchPath is where a flush of two or more queued writes goes, as one
	// hop carrying independent calls.
	RPCBatchPath = "/_lunora/rpc-batch"
	// WSPath is the live-subscription endpoint.
	WSPath = "/_lunora/ws"
)

// Verb selects which RPC method Call dispatches to. Generated code emits these
// constants rather than raw strings, so a typo in a target template is a
// compile error instead of a read silently sent over the write path.
type Verb string

const (
	// VerbQuery is a read.
	VerbQuery Verb = "query"
	// VerbMutation is a write, optionally carrying an idempotency key.
	VerbMutation Verb = "mutation"
	// VerbAction is an external side effect; never idempotency-keyed.
	VerbAction Verb = "action"
)

// HTTPPoster performs one POST. Injected rather than assumed so the conformance
// suite runs with no network and a consumer keeps its own transport, timeouts,
// and retry policy.
type HTTPPoster func(endpoint string, headers map[string]string, body []byte) (status int, response []byte, err error)

// FrameSender writes one JSON frame to an open socket. Injected for the same
// reason: this package stays dependency-free and the caller picks a WebSocket
// library.
type FrameSender func(frame map[string]any) error

// DataHandler receives each decoded subscription value.
type DataHandler func(value any)

// RowsHandler receives a shape's full row set after each poke is applied.
type RowsHandler func(rows []any)

// ErrorHandler receives each subscription-scoped error frame.
type ErrorHandler func(err SubscriptionError)

// Unsubscribe cancels a subscription and tells the server to stop.
type Unsubscribe func()

// APIError is a coded error from an RPC error envelope.
type APIError struct {
	Code    string
	Message string
	Data    any
	// Transient says the call never reached a verdict: a reply with no readable
	// error envelope (an edge error page, a WAF block, a proxy, a body that is
	// not a JSON object) — except a 413, which is PAYLOAD_TOO_LARGE, a verdict on
	// the request's size. It is set where the HTTP STATUS is still in scope,
	// because nothing downstream can recover it: Code alone cannot tell an
	// INTERNAL a function returned from the INTERNAL this client synthesises for
	// a body that never came from one. A CODED envelope never sets it — the code
	// is the verdict whatever the status, so a coded 5xx is terminal on the
	// single-call and batch replay paths alike. See isTransient.
	Transient bool
}

func (e APIError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// SubscriptionError is a subscription-scoped error the server pushed.
type SubscriptionError struct {
	Code    string
	Message string
}

func (e SubscriptionError) Error() string {
	if e.Code == "" {
		return e.Message
	}

	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Client is a Lunora deployment client.
type Client struct {
	// BaseURL is the deployment origin, e.g. https://app.example.com.
	BaseURL string
	// AuthToken, when set, rides every RPC as `authorization: Bearer …`.
	AuthToken string
	// Post performs the HTTP round-trip.
	Post HTTPPoster

	// mu guards clientID, identity, subscriptions, nextID, and send.
	//
	// Not optional in Go. The normal topology is a socket read loop calling
	// HandleFrame on one goroutine while application code calls Subscribe on
	// another, and Go's map runtime answers a concurrent read/write with
	// `fatal error: concurrent map read and map write` — which no recover()
	// catches. An unsynchronised map here kills the consumer's process.
	mu sync.Mutex
	// clientID identifies this client to the shard. It rides every write that
	// carries an idempotency key, because an anonymous caller has no
	// server-minted user id to namespace its de-duplication rows by. Read it with
	// ClientID and replace it with SetClientID — both under mu, because the write
	// path reads it from whichever goroutine called Submit while a sign-in may be
	// replacing it from another.
	//
	// NewClient mints a fresh one per instance, which is what a shared constant
	// cannot be: the shard namespaces anonymous idempotency by this value, so two
	// anonymous callers sharing it also share one de-duplication key space, and a
	// colliding caller-supplied mutation id makes the second write short-circuit
	// to the first caller's cached result without ever running.
	//
	// Pin a stable value with SetClientID when the offline queue is DURABLE: a
	// write restored after a restart replays under the id that issued it, so a
	// per-process id would namespace the replay somewhere the original write
	// never was.
	clientID string
	// identity is an opaque, stable, NON-SECRET stamp for whoever is signed in —
	// a user id, not a bearer token. It is persisted alongside every queued write
	// and re-checked before that write replays, so a restart cannot push one
	// user's queued writes as another. nil means signed out, which is itself an
	// identity a write can be stamped with. See Identity/SetIdentity.
	identity      *string
	send          FrameSender
	subscriptions map[string]*subscription
	shapes        map[string]*shapeSubscription
	pokes         map[string]*pokeBuffer
	// pokeOrder is the insertion order of pokes, oldest first — Go maps have no
	// order of their own, so the eviction in HandleFrame needs it to know which
	// buffer is oldest.
	pokeOrder   []string
	nextID      int
	nextShapeID int
	// streams holds each open Stream's teardown, so Close can end them.
	streams      map[int]func()
	nextStreamID int

	// offline holds the writes made while send was nil. Guarded by mu, which is
	// why OfflineQueue carries no lock of its own.
	offline *OfflineQueue
	// flushNotBefore is the instant before which FlushOfflineQueue is a no-op,
	// set when a replay came back rate-limited and the envelope named a delay.
	// Compared with time.Until, which uses Go's monotonic reading, so a
	// wall-clock adjustment cannot strand a queue for hours.
	flushNotBefore   time.Time
	wasEverConnected bool
	closed           bool
	settledListeners []func(MutationSettled)
}

// shapeSubscription is a partially-replicated keyed view maintained by pokes.
type shapeSubscription struct {
	id         string
	name       string
	args       any
	rows       map[string]any
	order      []string
	checkpoint any
	epoch      any
	onRows     RowsHandler
	onError    ErrorHandler
}

// pokeBuffer accumulates one poke's parts so they apply atomically at pokeEnd.
//
// Buffering is required, not an optimisation: a poke is defined as an atomic
// batch, so applying parts as they arrive would expose a torn view to the
// callback, and a socket that drops mid-poke would leave the view permanently
// half-applied.
type pokeBuffer struct {
	parts map[string][]map[string]any
	// resets holds the shapes whose part carried `reset: true` — the shape's
	// COMPLETE membership rather than a diff off what we hold. Kept per shape
	// because the flag is per part, and sticky (never cleared) so a server that
	// splits a seed across several parts still replaces rather than merges.
	resets map[string]bool
}

// MaxPendingPokes bounds the un-applied poke buffers a client retains. A buffer
// is only released at its pokeEnd; a socket that drops mid-poke never sends one,
// so without a bound the abandoned buffers accumulate for the life of the client
// — one per reconnect, and unbounded against a peer that opens pokes it never
// closes. Concurrent in-flight pokes number in the low single digits, so this is
// far above any legitimate working set.
const MaxPendingPokes = 64

type subscription struct {
	id           string
	functionPath string
	args         any
	// argsKey is the stable wire key of args, computed once at subscribe time so
	// a write's optimistic targeting can compare without re-serialising every
	// subscription's args on every write.
	argsKey  string
	shardKey string
	onData   DataHandler
	onError  ErrorHandler
	cursor   any
	epoch    any
	// state carries the displayed value and its optimistic overlays. See
	// optimistic.go.
	state OptimisticState
}

// NewClient builds a client for baseURL. post may be nil if only frame building
// and decoding are used (as in the conformance suite).
func NewClient(baseURL string, post HTTPPoster) *Client {
	return &Client{
		BaseURL:       baseURL,
		clientID:      RandomID(),
		Post:          post,
		offline:       NewOfflineQueue(OfflineQueueOptions{}),
		pokes:         map[string]*pokeBuffer{},
		shapes:        map[string]*shapeSubscription{},
		subscriptions: map[string]*subscription{},
	}
}

// String renders the client for %v, %+v, %s and %q WITHOUT its AuthToken. The
// default struct formatting prints every field, so a client that reached a log
// line or an error message leaked the bearer token with it.
func (c *Client) String() string {
	token := "unset"
	if c.AuthToken != "" {
		token = "[redacted]"
	}

	return fmt.Sprintf("lunora.Client{BaseURL: %q, AuthToken: %s}", c.BaseURL, token)
}

// GoString is String for %#v, which bypasses String and would otherwise dump
// the token verbatim.
func (c *Client) GoString() string { return c.String() }

// ClientID returns the id this client namespaces anonymous idempotency under.
func (c *Client) ClientID() string {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.clientID
}

// SetClientID replaces it. Call it before the first write: a write already
// queued keeps the id that ISSUED it, which is what makes a replay after a
// restart land in the namespace the original write was destined for.
func (c *Client) SetClientID(clientID string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.clientID = clientID
}

// Identity returns the stamp queued writes are bound to; nil means signed out.
func (c *Client) Identity() *string {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.identity
}

// SetIdentity records who is signed in. Accessors rather than an exported field:
// a consumer setting it from a sign-in handler while the socket goroutine is
// mid-flush is the ordinary case, and an unsynchronised field there is a data
// race the consumer's own `go test -race` would report against this package.
//
// A change FROM a set identity to a different one (a sign-out, or another user
// signing in) evicts the previous session: every subscription's resume cursor
// and epoch were that identity's position in the changelog, and every shape
// view held the rows THAT identity could see. Resuming from them under the new
// identity would splice a diff onto someone else's rows, so each query drops
// its cursor, epoch and server value, each shape view is emptied and its
// callback told so with an empty row set, and the next resubscribe is cold. A
// first sign-in (from nil) and a re-assertion of the same identity evict
// nothing.
func (c *Client) SetIdentity(identity *string) {
	var deferred []func()

	c.mu.Lock()
	previous := c.identity
	c.identity = identity

	if previous != nil && (identity == nil || *identity != *previous) {
		for _, entry := range c.subscriptions {
			entry.cursor = nil
			entry.epoch = nil
			entry.state.ServerBase = nil
			entry.state.ServerCursor = nil
			NotifySubscription(&entry.state, FoldOptimistic(nil, entry.state.Layers), &deferred)
		}

		for _, shape := range c.shapes {
			shape.rows = map[string]any{}
			shape.order = nil
			shape.checkpoint = nil
			shape.epoch = nil

			if onRows := shape.onRows; onRows != nil {
				deferred = append(deferred, func() { onRows([]any{}) })
			}
		}
	}

	c.mu.Unlock()

	runDeferred(deferred)
}

// AttachSocket registers the sender used for subscription frames. Call it once
// the socket is open; buffered subscriptions are (re)sent by ResendSubscriptions.
//
// It also latches "has connected at least once", which is what the write queue
// gates on: a write made before the FIRST connect fails fast by default, so a
// misconfigured endpoint surfaces on the first write instead of silently filling
// a queue that will never flush.
func (c *Client) AttachSocket(send FrameSender) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.send = send
	c.wasEverConnected = true
}

// DetachSocket forgets the sender, so subsequent writes queue rather than fail.
// Call it when the socket closes.
func (c *Client) DetachSocket() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.send = nil
}

// Online reports whether a socket is currently attached.
func (c *Client) Online() bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.send != nil
}

// Close rejects every queued write so no caller waits on a dead client, and ends
// every open [Client.Stream]. Durable storage is untouched: the next session
// restores those writes.
func (c *Client) Close() {
	c.mu.Lock()
	c.closed = true
	c.send = nil
	discarded := c.offline.Clear()

	streams := make([]func(), 0, len(c.streams))
	for _, end := range c.streams {
		streams = append(streams, end)
	}
	c.mu.Unlock()

	// Settled outside the lock: a rejection rolls optimistic layers back, and a
	// stream's teardown unsubscribes — both re-acquire it.
	c.reportDiscarded(discarded)

	for _, end := range streams {
		end()
	}
}

// argsOrEmpty normalises a nil argument record to the empty object the wire
// codec and the stable key both expect.
func argsOrEmpty(args any) any {
	if args == nil {
		return map[string]any{}
	}

	return args
}

// BuildRPCBody assembles the POST /_lunora/rpc body. shardKey is omitted when
// empty, which routes to the default shard.
func BuildRPCBody(functionPath string, args any, shardKey string) (map[string]any, error) {
	if args == nil {
		args = map[string]any{}
	}

	encoded, err := EncodeWire(args)
	if err != nil {
		return nil, err
	}

	body := map[string]any{"args": encoded, "functionPath": functionPath}
	if shardKey != "" {
		body["shardKey"] = shardKey
	}

	return body, nil
}

// ParseRPCResponse returns the decoded result, or an APIError built from the
// response.
//
// status is required, not decorative: protocol/README.md §4.2 says a non-2xx
// whose body carries no `error` envelope surfaces as an INTERNAL transport
// error. Without it a 502 with body `{"message":"bad gateway"}` would decode to
// a nil result and a nil error — a caller would believe its mutation committed.
func ParseRPCResponse(status int, raw []byte) (any, error) {
	value, _, err := ParseRPCEnvelope(status, raw)

	return value, err
}

// ParseRPCEnvelope is ParseRPCResponse plus the echoed commitCursor — the CDC
// cursor the write committed at.
//
// The cursor is what gates an optimistic overlay's removal, so it has to survive
// the parse rather than be discarded with the rest of the envelope. It is nil for
// a read, and for a write against a shard with CDC off — the degraded case the
// optimistic engine falls back to one-shot behaviour for.
func ParseRPCEnvelope(status int, raw []byte) (any, *int64, error) {
	// Parsed into `any`, not a map: `null`, `[]`, `"ok"` and `7` are JSON no
	// map holds, and each must surface as this package's APIError rather than a
	// raw encoding/json error — or, for `null`, a nil result that reads as
	// success.
	var parsed any

	// A syntax error leaves parsed nil (encoding/json validates before it
	// assigns), which the assertion below reads as "no object".
	_ = json.Unmarshal(raw, &parsed)

	body, isObject := parsed.(map[string]any)
	if !isObject {
		return nil, nil, envelopelessError(status, "an unreadable body")
	}

	if envelope, ok := body["error"].(map[string]any); ok {
		code, _ := envelope["code"].(string)
		message, _ := envelope["message"].(string)

		if code == "" {
			code = "INTERNAL"
		}

		if message == "" {
			message = "request failed"
		}

		var data any

		if payload, present := envelope["data"]; present && payload != nil {
			decoded, err := DecodeWire(payload)
			if err != nil {
				return nil, nil, err
			}

			data = decoded
		}

		// Classified by its code alone, whatever the status: a coded 5xx is the
		// server's verdict, on this path and the batch path alike. Only the codes
		// isTransient names re-queue a replay.
		return nil, nil, APIError{Code: code, Data: data, Message: message}
	}

	if status < 200 || status > 299 {
		return nil, nil, envelopelessError(status, "no error envelope")
	}

	commitCursor := asCursor(body["commitCursor"])

	result, err := DecodeWire(body["result"])
	if err != nil {
		// The call succeeded — a write COMMITTED — and only its result is
		// unreadable. Coded so a replay can tell it from a transport failure and
		// settle the write rather than re-send it forever; the cursor rides along
		// so its overlay still confirms.
		return nil, commitCursor, APIError{Code: CodeWireDecodeFailed, Message: "result could not be decoded: " + err.Error()}
	}

	return result, commitCursor, nil
}

// CodeWireDecodeFailed marks a successful reply whose `result` does not decode.
// A write carrying it has committed: a replay settles it committed, with this
// error on its settled event, and never re-sends it.
const CodeWireDecodeFailed = "WIRE_DECODE_FAILED"

// envelopelessError classifies a reply carrying no readable error envelope by
// its HTTP status (protocol/README.md §4.2/§4.3). Nothing in it came from a
// Lunora function — an edge error page, a WAF block, a proxy — so it is
// transport, and transient, with one exception: a 413 refused the request body
// for its size, which re-sending it unchanged can never fix. That is
// PAYLOAD_TOO_LARGE, the verdict the worker's own coded 413 carries.
func envelopelessError(status int, what string) APIError {
	if status == 413 {
		return APIError{Code: CodePayloadTooLarge, Message: "HTTP 413 with " + what}
	}

	return APIError{Code: "INTERNAL", Message: fmt.Sprintf("HTTP %d with %s", status, what), Transient: true}
}

// asCursor narrows a JSON number to the int64 cursors are compared as.
//
// encoding/json decodes every number into float64, so a cursor read straight out
// of the map cannot be ordered against another without this. A non-numeric (or
// absent) value is nil, which every cursor comparison treats as "no cursor".
func asCursor(value any) *int64 {
	switch typed := value.(type) {
	case float64:
		cursor := int64(typed)

		return &cursor
	case int64:
		return &typed
	case int:
		cursor := int64(typed)

		return &cursor
	case json.Number:
		cursor, err := typed.Int64()
		if err != nil {
			return nil
		}

		return &cursor
	default:
		return nil
	}
}

// Query invokes a query.
func (c *Client) Query(functionPath string, args any, shardKey string) (any, error) {
	return c.rpc(functionPath, args, shardKey, "")
}

// Mutation invokes a mutation. mutationID, when non-empty, is the idempotency
// key the server de-duplicates a replayed write by.
func (c *Client) Mutation(functionPath string, args any, shardKey string, mutationID string) (any, error) {
	return c.rpc(functionPath, args, shardKey, mutationID)
}

// Action invokes an action.
//
// Same envelope as a mutation, but never an idempotency key: an action performs
// external side effects and is not replayed against the shard, so claiming
// mutation-style de-duplication for it would be a lie.
func (c *Client) Action(functionPath string, args any, shardKey string) (any, error) {
	return c.rpc(functionPath, args, shardKey, "")
}

func (c *Client) rpc(functionPath string, args any, shardKey string, mutationID string) (any, error) {
	value, _, err := c.rpcFull(functionPath, args, shardKey, mutationID, "")

	return value, err
}

// rpcFull performs one round-trip and returns the echoed commit cursor with the
// result. clientID overrides Client.ClientID, so a replayed write namespaces
// server-side under the id that ISSUED it rather than whatever this session has.
func (c *Client) rpcFull(functionPath string, args any, shardKey string, mutationID string, clientID string) (any, *int64, error) {
	if c.Post == nil {
		return nil, nil, fmt.Errorf("lunora: no HTTPPoster configured")
	}

	body, err := BuildRPCBody(functionPath, args, shardKey)
	if err != nil {
		return nil, nil, err
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, nil, err
	}

	headers := map[string]string{"content-type": "application/json"}
	if c.AuthToken != "" {
		headers["authorization"] = "Bearer " + c.AuthToken
	}

	if mutationID != "" {
		headers["x-lunora-mutation-id"] = mutationID

		// Rides WITH the idempotency key, never alone. An anonymous caller has no
		// server-minted user id, so the shard namespaces its de-duplication rows
		// by this client id instead; without one every anonymous client shares a
		// single key space and a colliding mutation id suppresses another
		// client's write.
		if clientID == "" {
			clientID = c.ClientID()
		}

		if clientID != "" {
			headers["x-lunora-client-id"] = clientID
		}
	}

	status, raw, err := c.Post(joinURL(c.BaseURL, RPCPath), headers, payload)
	if err != nil {
		return nil, nil, err
	}

	return ParseRPCEnvelope(status, raw)
}

// rpcBatch posts one /_lunora/rpc-batch chunk and returns the HTTP status with
// the body, which is nil when it is not a JSON object.
//
// No x-lunora-mutation-id on the request: a batch is ONE transport hop carrying
// independent calls, so each entry carries its own idempotency key and client id
// in the body. A single outer header would name one write and de-duplicate the
// whole chunk against it.
func (c *Client) rpcBatch(calls []map[string]any) (int, map[string]any, error) {
	if c.Post == nil {
		return 0, nil, fmt.Errorf("lunora: no HTTPPoster configured")
	}

	payload, err := json.Marshal(map[string]any{"calls": calls})
	if err != nil {
		return 0, nil, err
	}

	headers := map[string]string{"content-type": "application/json"}
	if c.AuthToken != "" {
		headers["authorization"] = "Bearer " + c.AuthToken
	}

	status, raw, err := c.Post(joinURL(c.BaseURL, RPCBatchPath), headers, payload)
	if err != nil {
		return 0, nil, err
	}

	var parsed any

	// A body that is not a JSON object (an edge's HTML page, say) is left to
	// the caller to classify by status, exactly as ParseRPCEnvelope does.
	_ = json.Unmarshal(raw, &parsed)
	body, _ := parsed.(map[string]any)

	return status, body, nil
}

// Call invokes functionPath and decodes the result into T.
//
// A free function rather than a method because Go methods cannot take type
// parameters — this is what lets a generated method declare a concrete return
// type while the decode stays generic.
func Call[T any](c *Client, verb Verb, functionPath string, args any, shardKey string) (T, error) {
	var zero T

	var (
		result any
		err    error
	)

	switch verb {
	case VerbQuery:
		result, err = c.Query(functionPath, args, shardKey)
	case VerbAction:
		result, err = c.Action(functionPath, args, shardKey)
	case VerbMutation:
		result, err = c.Mutation(functionPath, args, shardKey, "")
	default:
		// Not a silent fallthrough to the write path: an unrecognised verb means
		// the generator and this runtime disagree, and guessing would send a
		// read as a write.
		return zero, fmt.Errorf("lunora: unknown verb %q", verb)
	}

	if err != nil {
		return zero, err
	}

	// Re-marshal through JSON so the decoded wire tree lands in T's fields.
	// The generated models are plain structs with json tags, so this is the
	// same path a hand-written client would take.
	raw, err := json.Marshal(result)
	if err != nil {
		return zero, err
	}

	var typed T

	if err := json.Unmarshal(raw, &typed); err != nil {
		return zero, err
	}

	return typed, nil
}

// BuildConnectFrame is the one-shot frame sent first on every socket open.
func BuildConnectFrame(clientID string, context map[string]any) map[string]any {
	frame := map[string]any{"id": "connect", "type": "connect"}
	if clientID != "" {
		frame["clientId"] = clientID
	}

	if context != nil {
		frame["context"] = context
	}

	return frame
}

// BuildSubscribeFrame assembles a live-query subscription frame. table defaults
// to functionPath; sinceSeq/sinceEpoch ride along only on a resume.
func BuildSubscribeFrame(id string, functionPath string, args any, table string, sinceSeq any, sinceEpoch any) (map[string]any, error) {
	if args == nil {
		args = map[string]any{}
	}

	encoded, err := EncodeWire(args)
	if err != nil {
		return nil, err
	}

	if table == "" {
		table = functionPath
	}

	query := map[string]any{"args": encoded, "functionPath": functionPath, "table": table}
	if sinceSeq != nil {
		query["sinceSeq"] = sinceSeq
	}

	if sinceEpoch != nil {
		query["sinceEpoch"] = sinceEpoch
	}

	return map[string]any{"id": id, "query": query, "type": "subscribe"}, nil
}

// BuildShapeSubscribeFrame assembles a shape (partial-replication) subscription
// frame. sinceCheckpoint/sinceEpoch ride along only on a resume.
func BuildShapeSubscribeFrame(id string, name string, args any, sinceCheckpoint any, sinceEpoch any) (map[string]any, error) {
	shape := map[string]any{"name": name}

	if args != nil {
		encoded, err := EncodeWire(args)
		if err != nil {
			return nil, err
		}

		shape["args"] = encoded
	}

	frame := map[string]any{"id": id, "shape": shape, "type": "shape_subscribe"}
	if sinceCheckpoint != nil {
		frame["sinceCheckpoint"] = sinceCheckpoint
	}

	if sinceEpoch != nil {
		frame["sinceEpoch"] = sinceEpoch
	}

	return frame, nil
}

// BuildShapeUnsubscribeFrame assembles a shape teardown frame.
func BuildShapeUnsubscribeFrame(id string) map[string]any {
	return map[string]any{"id": id, "type": "shape_unsubscribe"}
}

// BuildUnsubscribeFrame assembles the teardown frame.
func BuildUnsubscribeFrame(id string) map[string]any {
	return map[string]any{"id": id, "type": "unsubscribe"}
}

// Subscribe opens a live query. The returned Unsubscribe stops delivery and
// tells the server to drop it.
//
// shardKey does NOT ride the subscribe frame: the protocol selects a shard per
// SOCKET, via the `?shard=` parameter WSURL builds. It is accepted here so the
// generated surface is identical across languages, and is otherwise unused —
// this client holds one socket, so it must already be the shard that socket was
// opened against.
func (c *Client) Subscribe(functionPath string, args any, onData DataHandler, onError ErrorHandler, shardKey string) Unsubscribe {
	c.mu.Lock()

	if c.subscriptions == nil {
		// A literal-constructed Client (&lunora.Client{...}) has a nil map;
		// initialise lazily rather than panicking on first Subscribe.
		c.subscriptions = map[string]*subscription{}
	}

	c.nextID++
	id := fmt.Sprintf("sub_%d", c.nextID)
	// A key that cannot be built (a value outside the wire codec) leaves argsKey
	// empty, which simply means no optimistic write will target this
	// subscription — never a wrong match, since a write's key is built the same
	// way and an unencodable write cannot be sent either.
	argsKey, _ := StableWireKey(argsOrEmpty(args))
	entry := &subscription{
		args:         args,
		argsKey:      argsKey,
		functionPath: functionPath,
		id:           id,
		onData:       onData,
		onError:      onError,
		shardKey:     shardKey,
	}

	if onData != nil {
		entry.state.Callbacks = []func(any){func(value any) { onData(value) }}
	}

	c.subscriptions[id] = entry
	send := c.send
	c.mu.Unlock()

	// Sent outside the lock: the caller's FrameSender does socket I/O, and
	// holding the mutex across it would serialise every subscription behind it.
	if send != nil {
		if frame, err := BuildSubscribeFrame(id, functionPath, args, "", nil, nil); err == nil {
			_ = send(frame)
		}
	}

	return func() {
		c.mu.Lock()
		delete(c.subscriptions, id)
		sender := c.send
		c.mu.Unlock()

		if sender != nil {
			_ = sender(BuildUnsubscribeFrame(id))
		}
	}
}

// StreamEvent is one item delivered by [Client.Stream]: a value, or the
// subscription error that ended it.
//
// One channel carrying both, rather than a value channel plus an error channel:
// a consumer selecting on two channels can read them out of order, and the whole
// point of a stream is that what arrived first is delivered first.
type StreamEvent struct {
	Value any
	Err   error
}

// Stream opens a live query as a receive channel, for `for event := range …`.
//
// Each call opens its OWN subscription, torn down by the returned [Unsubscribe],
// which also closes the channel. Call it — a `defer` is the usual place — or the
// subscription outlives the loop.
//
// The channel is BUFFERED and its sends BLOCK when it fills. That is deliberate
// backpressure: dropping a value would make a live query silently wrong, and the
// sender is the frame dispatcher, so a consumer that stops reading slows frame
// handling rather than losing data. A consumer that cannot keep up should read
// on its own goroutine.
//
// [Client.Close] ends every open stream too: the channel closes, so a `range`
// over it returns rather than waiting on a client that will never send again.
func (c *Client) Stream(functionPath string, args any, shardKey string) (<-chan StreamEvent, Unsubscribe) {
	events := make(chan StreamEvent, streamBufferSize)
	done := make(chan struct{})

	// sending is held (shared) for the whole of every send and taken exclusively
	// to close `events`, so the close can never land while a frame is mid-send.
	// `done` alone is not enough: select picks at random among ready cases, and
	// once both channels are closed the send case is ready too — a send on a
	// closed channel, panicking in the caller's socket loop (and a data race
	// under -race). `done` is still what unblocks a sender stuck on a full
	// buffer, which is why it closes BEFORE the exclusive lock is taken.
	var (
		sending sync.RWMutex
		closed  bool
	)

	emit := func(event StreamEvent) {
		sending.RLock()
		defer sending.RUnlock()

		if closed {
			return
		}

		select {
		case <-done:
		case events <- event:
		}
	}

	unsubscribe := c.Subscribe(
		functionPath,
		args,
		func(value any) { emit(StreamEvent{Value: value}) },
		func(err SubscriptionError) { emit(StreamEvent{Err: err}) },
		shardKey,
	)

	var (
		once     sync.Once
		streamID int
	)

	end := func() {
		once.Do(func() {
			c.mu.Lock()
			delete(c.streams, streamID)
			c.mu.Unlock()

			unsubscribe()
			close(done)

			sending.Lock()
			closed = true
			close(events)
			sending.Unlock()
		})
	}

	c.mu.Lock()
	if c.streams == nil {
		c.streams = map[int]func(){}
	}

	c.nextStreamID++
	streamID = c.nextStreamID
	c.streams[streamID] = end
	closedClient := c.closed
	c.mu.Unlock()

	// A stream opened on a closed client ends at once rather than never.
	if closedClient {
		end()
	}

	return events, end
}

// streamBufferSize is how many values [Client.Stream] holds before its sends
// block. Big enough that an ordinary consumer never sees backpressure, small
// enough that a stalled one is noticed rather than growing without bound.
const streamBufferSize = 64

// SubscribeShape opens a partially-replicated keyed view. onRows fires once per
// applied poke with the view's full contents, in insertion order.
func (c *Client) SubscribeShape(name string, args any, onRows RowsHandler, onError ErrorHandler) Unsubscribe {
	c.mu.Lock()

	if c.shapes == nil {
		c.shapes = map[string]*shapeSubscription{}
	}

	if c.pokes == nil {
		c.pokes = map[string]*pokeBuffer{}
	}

	c.nextShapeID++
	id := fmt.Sprintf("shape_%d", c.nextShapeID)
	c.shapes[id] = &shapeSubscription{args: args, id: id, name: name, onError: onError, onRows: onRows, rows: map[string]any{}}
	send := c.send
	c.mu.Unlock()

	if send != nil {
		if frame, err := BuildShapeSubscribeFrame(id, name, args, nil, nil); err == nil {
			_ = send(frame)
		}
	}

	return func() {
		c.mu.Lock()
		delete(c.shapes, id)
		sender := c.send
		c.mu.Unlock()

		if sender != nil {
			_ = sender(BuildShapeUnsubscribeFrame(id))
		}
	}
}

// ResendSubscriptions re-subscribes everything after a reconnect, carrying each
// subscription's resume cursor so the server can skip unchanged results.
func (c *Client) ResendSubscriptions() error {
	// Snapshot the resume state INSIDE the lock. Copying the pointers and
	// reading entry.cursor/epoch afterwards races the frame goroutine, which
	// writes both in advance() — `go test -race` proves it.
	//
	// One struct for both registries: name is the query's function path or the
	// shape's name, cursor its sinceSeq or sinceCheckpoint, and the two resends
	// differ only in which builder consumes them.
	type resumePoint struct {
		id     string
		name   string
		args   any
		cursor any
		epoch  any
	}

	c.mu.Lock()
	send := c.send
	entries := make([]resumePoint, 0, len(c.subscriptions))

	for id, entry := range c.subscriptions {
		entries = append(entries, resumePoint{
			args:   entry.args,
			cursor: entry.cursor,
			epoch:  entry.epoch,
			id:     id,
			name:   entry.functionPath,
		})
	}

	// Shapes resume too. A resend that walks only the query registry leaves every
	// shape view subscribed to a socket that no longer exists — silently, and for
	// the rest of the process's life, because a shape is only ever fed by pokes
	// the server stops sending.
	shapes := make([]resumePoint, 0, len(c.shapes))

	for id, shape := range c.shapes {
		shapes = append(shapes, resumePoint{
			args:   shape.args,
			cursor: shape.checkpoint,
			epoch:  shape.epoch,
			id:     id,
			name:   shape.name,
		})
	}

	c.mu.Unlock()

	if send == nil {
		return nil
	}

	for _, entry := range entries {
		frame, err := BuildSubscribeFrame(entry.id, entry.name, entry.args, "", entry.cursor, entry.epoch)
		if err != nil {
			return err
		}

		if err := send(frame); err != nil {
			return err
		}
	}

	for _, shape := range shapes {
		frame, err := BuildShapeSubscribeFrame(shape.id, shape.name, shape.args, shape.cursor, shape.epoch)
		if err != nil {
			return err
		}

		if err := send(frame); err != nil {
			return err
		}
	}

	return nil
}

// HandleFrame applies one server frame, invoking the relevant callbacks. It
// returns the frame's type so a caller (and the conformance suite) can assert
// what happened. Unknown types are ignored, per the protocol's forward-compat rule.
func (c *Client) HandleFrame(raw []byte) (string, error) {
	// The keepalive is a bare non-JSON string; the protocol says ignore it.
	if string(raw) == "lunora-ping" || string(raw) == "lunora-pong" {
		return "", nil
	}

	var frame map[string]any

	if err := json.Unmarshal(raw, &frame); err != nil {
		// Non-JSON frames are ignored by the client parser, not fatal.
		return "", nil
	}

	kind, _ := frame["type"].(string)
	id, _ := frame["id"].(string)

	c.mu.Lock()
	entry := c.subscriptions[id]
	shape := c.shapes[id]
	c.mu.Unlock()

	switch kind {
	case "ack":
		return kind, nil
	case "data", "delta":
		payload, present := frame["data"]
		if !present || payload == nil {
			payload = frame["delta"]
		}

		value, err := DecodeWire(payload)
		if err != nil {
			// A malformed payload belongs on THIS subscription's error callback,
			// not on the socket read loop's stack. Returning it ended the caller's
			// loop — and with it every other subscription on this client — over one
			// bad frame.
			if entry != nil && entry.onError != nil {
				entry.onError(SubscriptionError{Code: "INVALID_FRAME", Message: err.Error()})
			}

			return "error", nil
		}

		if entry != nil {
			var deferred []func()

			c.mu.Lock()
			c.advanceLocked(entry, frame)
			entry.state.ServerBase = value

			// `cursor` is OPTIONAL on a data/delta frame, and one that omits it
			// must LEAVE the tracked cursor where it was. Nulling it strands every
			// pending layer: the tracked cursor is what a later commitCursor is
			// compared against, so the confirm that should have dropped the overlay
			// keeps it and the write renders twice.
			if cursor := asCursor(frame["cursor"]); cursor != nil {
				entry.state.ServerCursor = cursor
			}

			// Drop the overlays this frame has caught up with, then RE-FOLD the
			// rest onto the new authoritative base rather than clobbering them:
			// a still-queued write's predicted value has to survive an unrelated
			// delta on the same query.
			DropConfirmedLayers(&entry.state, entry.state.ServerCursor)
			NotifySubscription(&entry.state, FoldOptimistic(entry.state.ServerBase, entry.state.Layers), &deferred)
			c.mu.Unlock()

			// Handlers run outside the mutex: one that subscribes would otherwise
			// deadlock on the lock it is already inside.
			runDeferred(deferred)
		}

		return kind, nil
	case "resume", "settled":
		if entry != nil {
			var deferred []func()

			c.mu.Lock()
			c.advanceLocked(entry, frame)

			// A resume/settled frame advances the cursor without a value change —
			// but a write whose result was byte-identical for this query still
			// committed at or under this cursor, so its overlay is confirmed. Sweep
			// here too, not just on data frames, or a no-visible-change write leaves
			// its prediction on screen until some unrelated write happens to produce
			// a data frame — indefinitely on a quiet query.
			if cursor := asCursor(frame["cursor"]); cursor != nil {
				entry.state.ServerCursor = cursor
			}

			if DropConfirmedLayers(&entry.state, entry.state.ServerCursor) {
				NotifySubscription(&entry.state, FoldOptimistic(entry.state.ServerBase, entry.state.Layers), &deferred)
			}

			c.mu.Unlock()

			runDeferred(deferred)
		}

		return kind, nil
	case "error":
		subscriptionError := SubscriptionError{Message: "subscription error"}

		if envelope, ok := frame["error"].(map[string]any); ok {
			if code, ok := envelope["code"].(string); ok {
				subscriptionError.Code = code
			}

			if message, ok := envelope["message"].(string); ok && message != "" {
				subscriptionError.Message = message
			}
		}

		if message, ok := frame["message"].(string); ok && message != "" {
			subscriptionError.Message = message
		}

		// BOTH registries: an error frame is addressed by subscription id, and a
		// shape id is one. Looking only in the query registry made every
		// server-side shape failure unreportable.
		if entry != nil && entry.onError != nil {
			entry.onError(subscriptionError)
		}

		if shape != nil && shape.onError != nil {
			shape.onError(subscriptionError)
		}

		return kind, nil
	case "complete":
		// NON-DESTRUCTIVE, and that is the whole point: deleting the entry takes
		// it out of the map ResendSubscriptions walks, so the query froze for
		// the life of the process across every future reconnect, with nothing
		// reported. Fan a cancellation to the listener and leave the
		// registration in place; the next reconnect resubscribes it.
		if entry != nil && entry.onError != nil {
			entry.onError(SubscriptionError{Code: "SUBSCRIPTION_CANCELLED", Message: "subscription was cancelled by the server"})
		}

		return kind, nil
	case "pokeStart":
		pokeID, _ := frame["pokeId"].(string)

		c.mu.Lock()

		if c.pokes == nil {
			c.pokes = map[string]*pokeBuffer{}
		}

		if _, exists := c.pokes[pokeID]; !exists {
			c.pokeOrder = append(c.pokeOrder, pokeID)
		}

		c.pokes[pokeID] = &pokeBuffer{parts: map[string][]map[string]any{}, resets: map[string]bool{}}

		// Evict oldest-first at the cap; a poke that old is no longer going to
		// see its pokeEnd.
		for len(c.pokeOrder) > MaxPendingPokes {
			delete(c.pokes, c.pokeOrder[0])
			c.pokeOrder = c.pokeOrder[1:]
		}

		c.mu.Unlock()

		return kind, nil
	case "pokePart":
		c.bufferPokePart(frame)

		return kind, nil
	case "pokeEnd":
		c.applyPoke(frame)

		return kind, nil
	default:
		return kind, nil
	}
}

// bufferPokePart stashes one part until its pokeEnd arrives.
func (c *Client) bufferPokePart(frame map[string]any) {
	pokeID, _ := frame["pokeId"].(string)
	shapeID, _ := frame["shapeId"].(string)
	rows, _ := frame["rowsPatch"].([]any)

	operations := make([]map[string]any, 0, len(rows))

	for _, row := range rows {
		if operation, ok := row.(map[string]any); ok {
			operations = append(operations, operation)
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// A part for an unknown poke is dropped: without its pokeStart there is no
	// atomic batch to join, and guessing would apply a fragment of one.
	if buffer := c.pokes[pokeID]; buffer != nil {
		buffer.parts[shapeID] = append(buffer.parts[shapeID], operations...)

		if reset, _ := frame["reset"].(bool); reset {
			if buffer.resets == nil {
				buffer.resets = map[string]bool{}
			}

			buffer.resets[shapeID] = true
		}
	}
}

// forgetPokeOrder drops one id from the eviction order. Called when a buffer
// leaves c.pokes by any route other than eviction, so the order list tracks the
// map rather than growing a stale entry per completed poke. Caller holds c.mu.
func (c *Client) forgetPokeOrder(pokeID string) {
	for index, candidate := range c.pokeOrder {
		if candidate == pokeID {
			c.pokeOrder = append(c.pokeOrder[:index], c.pokeOrder[index+1:]...)

			return
		}
	}
}

// applyPoke applies a whole poke in one step and fires each touched shape's
// callback with the resulting view.
func (c *Client) applyPoke(frame map[string]any) {
	pokeID, _ := frame["pokeId"].(string)

	c.mu.Lock()
	buffer := c.pokes[pokeID]
	delete(c.pokes, pokeID)
	c.forgetPokeOrder(pokeID)

	if buffer == nil {
		c.mu.Unlock()

		return
	}

	type delivery struct {
		handler RowsHandler
		rows    []any
		onError ErrorHandler
		err     SubscriptionError
	}

	deliveries := make([]delivery, 0, len(buffer.parts))

	for shapeID, operations := range buffer.parts {
		shape := c.shapes[shapeID]
		if shape == nil {
			continue
		}

		// Every row is decoded BEFORE the view is touched: a poke applies whole
		// or not at all. Clearing for a reset and then failing on a row left the
		// view half-applied (or empty), and skipping the row while advancing the
		// checkpoint past it meant no resume would ever send it again. A refused
		// poke leaves the view, checkpoint and epoch as they were and reports on
		// the shape's error callback; other shapes in the same poke still apply.
		decoded, err := decodePokeRows(operations)
		if err != nil {
			if shape.onError != nil {
				deliveries = append(deliveries, delivery{onError: shape.onError, err: SubscriptionError{Code: "INVALID_FRAME", Message: err.Error()}})
			}

			continue
		}

		// A `reset` part carries the shape's COMPLETE membership, so it is
		// authoritative on its own: drop whatever we hold, then apply it. Splicing
		// it onto the view instead keeps every row that left the shape while we
		// were disconnected — a (re)seed is inserts-only, so nothing ever removes
		// them and they render for the life of the client. The flag is the only
		// signal: `baseCheckpoint` is absent on most live poke paths, and a
		// retention re-seed arrives with the epoch unchanged.
		if buffer.resets[shapeID] {
			shape.rows = map[string]any{}
			shape.order = nil
		}

		for index, operation := range operations {
			key, _ := operation["key"].(string)
			op, _ := operation["op"].(string)

			if op == "delete" {
				if _, present := shape.rows[key]; present {
					delete(shape.rows, key)
					shape.order = removeKey(shape.order, key)
				}

				continue
			}

			value, present := decoded[index]
			if !present {
				// A value-less upsert is membership-only; it must not blank an
				// existing row.
				continue
			}

			if _, existing := shape.rows[key]; !existing {
				shape.order = append(shape.order, key)
			}

			shape.rows[key] = value
		}

		if checkpoint, ok := frame["checkpoint"]; ok {
			shape.checkpoint = checkpoint
		}

		if epoch, ok := frame["epoch"]; ok {
			shape.epoch = epoch
		}

		rows := make([]any, 0, len(shape.order))
		for _, key := range shape.order {
			rows = append(rows, shape.rows[key])
		}

		if shape.onRows != nil {
			deliveries = append(deliveries, delivery{handler: shape.onRows, rows: rows})
		}
	}

	c.mu.Unlock()

	// Callbacks run outside the lock: a handler that subscribes or unsubscribes
	// would otherwise deadlock on the mutex it is already inside.
	for _, item := range deliveries {
		if item.onError != nil {
			item.onError(item.err)

			continue
		}

		item.handler(item.rows)
	}
}

// decodePokeRows decodes the value of every upsert in one shape's buffered
// operations, keyed by operation index. A value-less (or null) upsert has no
// entry: it is membership-only.
func decodePokeRows(operations []map[string]any) (map[int]any, error) {
	decoded := make(map[int]any, len(operations))

	for index, operation := range operations {
		if op, _ := operation["op"].(string); op == "delete" {
			continue
		}

		value, present := operation["value"]
		if !present || value == nil {
			continue
		}

		row, err := DecodeWire(value)
		if err != nil {
			return nil, err
		}

		decoded[index] = row
	}

	return decoded, nil
}

func removeKey(keys []string, key string) []string {
	for index, candidate := range keys {
		if candidate == key {
			return append(keys[:index], keys[index+1:]...)
		}
	}

	return keys
}

// advanceLocked moves the resume point. The caller holds the mutex: every frame
// path has to update the resume point and the optimistic state in one critical
// section so a concurrent frame cannot interleave between them.
func (c *Client) advanceLocked(entry *subscription, frame map[string]any) {
	// Only an integer is a cursor. A string or fractional one is kept off the
	// resume point: resending it verbatim asks the server to resume from "9".
	if cursor, ok := frame["cursor"].(float64); ok && cursor == math.Trunc(cursor) {
		entry.cursor = cursor
	}

	if epoch, ok := frame["epoch"]; ok {
		entry.epoch = epoch
	}
}

// runDeferred runs the notifications queued while the mutex was held.
func runDeferred(deferred []func()) {
	for _, call := range deferred {
		call()
	}
}

// WSURL derives the socket URL: the origin with the scheme swapped, plus the
// shard and credential query parameters when present.
func (c *Client) WSURL(shardKey string, token string) string {
	endpoint := joinURL(c.BaseURL, WSPath)

	switch {
	case strings.HasPrefix(endpoint, "https://"):
		endpoint = "wss://" + strings.TrimPrefix(endpoint, "https://")
	case strings.HasPrefix(endpoint, "http://"):
		endpoint = "ws://" + strings.TrimPrefix(endpoint, "http://")
	}

	params := make([]string, 0, 2)
	if shardKey != "" {
		params = append(params, "shard="+url.QueryEscape(shardKey))
	}

	if token != "" {
		params = append(params, "token="+url.QueryEscape(token))
	}

	if len(params) == 0 {
		return endpoint
	}

	separator := "?"
	if strings.Contains(endpoint, "?") {
		separator = "&"
	}

	return endpoint + separator + strings.Join(params, "&")
}

func joinURL(base string, path string) string {
	return strings.TrimSuffix(base, "/") + path
}
