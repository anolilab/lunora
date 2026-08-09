package lunora

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

const (
	// RPCPath is the single endpoint every query/mutation/action posts to.
	RPCPath = "/_lunora/rpc"
	// WSPath is the live-subscription endpoint.
	WSPath = "/_lunora/ws"
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

	send          FrameSender
	subscriptions map[string]*subscription
	nextID        int
}

type subscription struct {
	id           string
	functionPath string
	args         any
	shardKey     string
	onData       DataHandler
	onError      ErrorHandler
	cursor       any
	epoch        any
}

// NewClient builds a client for baseURL. post may be nil if only frame building
// and decoding are used (as in the conformance suite).
func NewClient(baseURL string, post HTTPPoster) *Client {
	return &Client{BaseURL: baseURL, Post: post, subscriptions: map[string]*subscription{}}
}

// AttachSocket registers the sender used for subscription frames. Call it once
// the socket is open; buffered subscriptions are (re)sent by ResendSubscriptions.
func (c *Client) AttachSocket(send FrameSender) { c.send = send }

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

// ParseRPCResponse returns the decoded result, or an APIError from an error envelope.
func ParseRPCResponse(raw []byte) (any, error) {
	var body map[string]any

	if err := json.Unmarshal(raw, &body); err != nil {
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

	_, raw, err := c.Post(joinURL(c.BaseURL, RPCPath), headers, payload)
	if err != nil {
		return nil, err
	}

	return ParseRPCResponse(raw)
}

// Call invokes functionPath and decodes the result into T.
//
// A free function rather than a method because Go methods cannot take type
// parameters — this is what lets a generated method declare a concrete return
// type while the decode stays generic.
func Call[T any](c *Client, verb string, functionPath string, args any, shardKey string) (T, error) {
	var zero T

	var (
		result any
		err    error
	)

	switch verb {
	case "query":
		result, err = c.Query(functionPath, args, shardKey)
	case "action":
		result, err = c.Action(functionPath, args, shardKey)
	default:
		result, err = c.Mutation(functionPath, args, shardKey, "")
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

// BuildUnsubscribeFrame assembles the teardown frame.
func BuildUnsubscribeFrame(id string) map[string]any {
	return map[string]any{"id": id, "type": "unsubscribe"}
}

// Subscribe opens a live query. The returned Unsubscribe stops delivery and
// tells the server to drop it.
func (c *Client) Subscribe(functionPath string, args any, onData DataHandler, onError ErrorHandler, shardKey string) Unsubscribe {
	c.nextID++
	id := fmt.Sprintf("sub_%d", c.nextID)
	entry := &subscription{args: args, functionPath: functionPath, id: id, onData: onData, onError: onError, shardKey: shardKey}
	c.subscriptions[id] = entry

	if c.send != nil {
		if frame, err := BuildSubscribeFrame(id, functionPath, args, "", nil, nil); err == nil {
			_ = c.send(frame)
		}
	}

	return func() {
		delete(c.subscriptions, id)

		if c.send != nil {
			_ = c.send(BuildUnsubscribeFrame(id))
		}
	}
}

// ResendSubscriptions re-subscribes everything after a reconnect, carrying each
// subscription's resume cursor so the server can skip unchanged results.
func (c *Client) ResendSubscriptions() error {
	if c.send == nil {
		return nil
	}

	for _, entry := range c.subscriptions {
		frame, err := BuildSubscribeFrame(entry.id, entry.functionPath, entry.args, "", entry.cursor, entry.epoch)
		if err != nil {
			return err
		}

		if err := c.send(frame); err != nil {
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
	entry := c.subscriptions[id]

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
		delete(c.subscriptions, id)

		return kind, nil
	default:
		return kind, nil
	}
}

func (c *Client) advance(entry *subscription, frame map[string]any) {
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
