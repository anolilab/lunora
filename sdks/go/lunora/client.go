package lunora

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
)

const (
	// RPCPath is the single endpoint every query/mutation/action posts to.
	RPCPath = "/_lunora/rpc"
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

	// mu guards subscriptions, nextID, and send.
	//
	// Not optional in Go. The normal topology is a socket read loop calling
	// HandleFrame on one goroutine while application code calls Subscribe on
	// another, and Go's map runtime answers a concurrent read/write with
	// `fatal error: concurrent map read and map write` — which no recover()
	// catches. An unsynchronised map here kills the consumer's process.
	mu            sync.Mutex
	send          FrameSender
	subscriptions map[string]*subscription
	shapes        map[string]*shapeSubscription
	pokes         map[string]*pokeBuffer
	nextID        int
	nextShapeID   int
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
}

type subscription struct {
	id           string
	functionPath string
	args         any
	onData       DataHandler
	onError      ErrorHandler
	cursor       any
	epoch        any
}

// NewClient builds a client for baseURL. post may be nil if only frame building
// and decoding are used (as in the conformance suite).
func NewClient(baseURL string, post HTTPPoster) *Client {
	return &Client{
		BaseURL:       baseURL,
		Post:          post,
		pokes:         map[string]*pokeBuffer{},
		shapes:        map[string]*shapeSubscription{},
		subscriptions: map[string]*subscription{},
	}
}

// AttachSocket registers the sender used for subscription frames. Call it once
// the socket is open; buffered subscriptions are (re)sent by ResendSubscriptions.
func (c *Client) AttachSocket(send FrameSender) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.send = send
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
	var body map[string]any

	if err := json.Unmarshal(raw, &body); err != nil {
		if status < 200 || status > 299 {
			return nil, APIError{Code: "INTERNAL", Message: fmt.Sprintf("HTTP %d with an unparseable body", status)}
		}

		return nil, fmt.Errorf("lunora: malformed RPC response: %w", err)
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
				return nil, err
			}

			data = decoded
		}

		return nil, APIError{Code: code, Data: data, Message: message}
	}

	if status < 200 || status > 299 {
		return nil, APIError{Code: "INTERNAL", Message: fmt.Sprintf("HTTP %d without an error envelope", status)}
	}

	return DecodeWire(body["result"])
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
	if c.Post == nil {
		return nil, fmt.Errorf("lunora: no HTTPPoster configured")
	}

	body, err := BuildRPCBody(functionPath, args, shardKey)
	if err != nil {
		return nil, err
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	headers := map[string]string{"content-type": "application/json"}
	if c.AuthToken != "" {
		headers["authorization"] = "Bearer " + c.AuthToken
	}

	if mutationID != "" {
		headers["x-lunora-mutation-id"] = mutationID
	}

	status, raw, err := c.Post(joinURL(c.BaseURL, RPCPath), headers, payload)
	if err != nil {
		return nil, err
	}

	return ParseRPCResponse(status, raw)
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
	c.subscriptions[id] = &subscription{args: args, functionPath: functionPath, id: id, onData: onData, onError: onError}
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
	c.mu.Lock()
	send := c.send
	entries := make([]*subscription, 0, len(c.subscriptions))

	for _, entry := range c.subscriptions {
		entries = append(entries, entry)
	}

	c.mu.Unlock()

	if send == nil {
		return nil
	}

	for _, entry := range entries {
		frame, err := BuildSubscribeFrame(entry.id, entry.functionPath, entry.args, "", entry.cursor, entry.epoch)
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
			return kind, err
		}

		if entry != nil {
			c.advance(entry, frame)

			if entry.onData != nil {
				entry.onData(value)
			}
		}

		return kind, nil
	case "resume", "settled":
		if entry != nil {
			c.advance(entry, frame)
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

		if entry != nil && entry.onError != nil {
			entry.onError(subscriptionError)
		}

		return kind, nil
	case "complete":
		c.mu.Lock()
		delete(c.subscriptions, id)
		c.mu.Unlock()

		return kind, nil
	case "pokeStart":
		pokeID, _ := frame["pokeId"].(string)

		c.mu.Lock()

		if c.pokes == nil {
			c.pokes = map[string]*pokeBuffer{}
		}

		c.pokes[pokeID] = &pokeBuffer{parts: map[string][]map[string]any{}}
		c.mu.Unlock()

		return kind, nil
	case "pokePart":
		c.bufferPokePart(frame)

		return kind, nil
	case "pokeEnd":
		return kind, c.applyPoke(frame)
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
	}
}

// applyPoke applies a whole poke in one step and fires each touched shape's
// callback with the resulting view.
func (c *Client) applyPoke(frame map[string]any) error {
	pokeID, _ := frame["pokeId"].(string)

	c.mu.Lock()
	buffer := c.pokes[pokeID]
	delete(c.pokes, pokeID)

	if buffer == nil {
		c.mu.Unlock()

		return nil
	}

	type delivery struct {
		handler RowsHandler
		rows    []any
	}

	deliveries := make([]delivery, 0, len(buffer.parts))

	for shapeID, operations := range buffer.parts {
		shape := c.shapes[shapeID]
		if shape == nil {
			continue
		}

		for _, operation := range operations {
			key, _ := operation["key"].(string)
			op, _ := operation["op"].(string)

			if op == "delete" {
				if _, present := shape.rows[key]; present {
					delete(shape.rows, key)
					shape.order = removeKey(shape.order, key)
				}

				continue
			}

			value, present := operation["value"]
			if !present || value == nil {
				// A value-less upsert is membership-only; it must not blank an
				// existing row.
				continue
			}

			decoded, err := DecodeWire(value)
			if err != nil {
				c.mu.Unlock()

				return err
			}

			if _, existing := shape.rows[key]; !existing {
				shape.order = append(shape.order, key)
			}

			shape.rows[key] = decoded
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
		item.handler(item.rows)
	}

	return nil
}

func removeKey(keys []string, key string) []string {
	for index, candidate := range keys {
		if candidate == key {
			return append(keys[:index], keys[index+1:]...)
		}
	}

	return keys
}

func (c *Client) advance(entry *subscription, frame map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if cursor, ok := frame["cursor"]; ok {
		entry.cursor = cursor
	}

	if epoch, ok := frame["epoch"]; ok {
		entry.epoch = epoch
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
