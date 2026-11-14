# frozen_string_literal: true

# Runs a generated call, rather than only syntax-checking one.
#
# `ruby -c` was not enough: an earlier revision generated `args.to_dynamic`
# against models rendered with quicktype's `just-types`, which omits that method
# — so every generated call raised NoMethodError while the syntax check stayed
# green. Parsing proves the file is well formed; only invoking proves a request
# reaches the wire.
#
# Run by `sdks/generated-check.sh ruby` against an SDK generated into a scratch
# directory outside this repo. LUNORA_SDK_OUT is the only entry added to the load
# path, so `require "lunora"` can only resolve to the VENDORED transport — not to
# `sdks/ruby/lib`, which a run inside the checkout would find instead.

require "json"

$LOAD_PATH.unshift(ENV.fetch("LUNORA_SDK_OUT"))

require "lunora"
require "api"

captured = nil

client = Lunora::Client.new("https://app.example", http_post: lambda { |_url, _headers, body|
  captured = body

  # The poster hands back a PARSED body: this transport leaves JSON parsing to
  # the caller's HTTP stack rather than assuming one.
  [200, { "result" => { "ok" => true } }]
})

LunoraApi::Api.new(client).messages.list(MessagesListArgs.from_dynamic!({ "channelId" => "chan_1" }))

want = '{"args":{"channelId":"chan_1"},"functionPath":"messages:list"}'
got = Lunora.stable_stringify(JSON.parse(captured))

raise "generated call produced #{got}, want #{want}" unless got == want

# The generated watch member reaches the primitive with the right function path. The
# subscribe frame is sent at call time, the first data frame is decoded through the
# Enumerator, and calling `stop` sends the unsubscribe for the same id.
def frame_of_type(frames, kind)
  found = frames.select { |frame| frame["type"] == kind }
  raise "sent #{found.length} #{kind} frames, want exactly one" unless found.length == 1

  found.first
end

frames = []
watch_client = Lunora::Client.new("https://app.example")
watch_client.attach_socket(->(frame) { frames << frame })

values, stop = LunoraApi::Api.new(watch_client).messages.watch_list(MessagesListArgs.from_dynamic!({ "channelId" => "chan_1" }))

subscribe = frame_of_type(frames, "subscribe")
query = subscribe.fetch("query")

watched_path = query["functionPath"]
raise "watch subscribed to #{watched_path}, want messages:list" unless watched_path == "messages:list"

sent_args = Lunora.stable_stringify(query["args"])
raise "watch sent args #{sent_args}" unless sent_args == '{"channelId":"chan_1"}'

watch_client.handle_frame(JSON.generate({ "cursor" => 1, "data" => { "ok" => true }, "id" => subscribe["id"], "type" => "data" }))

value = values.next
raise "watch yielded #{value.inspect}, want {ok: true}" unless value == { "ok" => true }

stop.call

unsubscribed = frame_of_type(frames, "unsubscribe")
subscribed_id = subscribe["id"]
unsubscribed_id = unsubscribed["id"]
raise "closing the watch unsubscribed #{unsubscribed_id}, want #{subscribed_id}" unless unsubscribed_id == subscribed_id

puts "OK — the generated surface reaches the wire, and the watch member reaches the primitive"
