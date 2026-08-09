// The Lunora Go client.
//
// Deliberately dependency-free: the HTTP poster and the WebSocket frame sender
// are injected by the caller, so the conformance suite runs offline and a
// consumer picks its own socket library rather than inheriting ours.
module github.com/anolilab/lunora-go

go 1.22
