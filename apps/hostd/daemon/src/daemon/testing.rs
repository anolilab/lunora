//! A minimal in-process control plane for the session tests: a WebSocket on
//! loopback that reads `hello`, sends a `challenge`, checks the `auth`
//! signature against the box key, then plays a script of frames and records
//! what the box sent. The full fake (enrol, signed release fetch, S3, logs) is
//! the TypeScript one the black-box tests drive the built binary against.

use std::sync::{Arc, Mutex};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::wire::codec::{Frame, decode_box_message, encode_cloud_message};
use crate::wire::signing::challenge_payload;
use crate::wire::types::{BoxMessage, CloudMessage};

pub const NONCE: &str = "c2VydmVyLW5vbmNlLTEyOC1iaXRz";

/// What the plane does after it verified `auth`, connection by connection (the last one repeats).
#[derive(Clone)]
pub enum Script {
    /// Send these frames, then keep the socket open until the box closes it.
    Send(Vec<CloudMessage>),
    /// Send these raw texts (frames the box must refuse), then wait.
    Raw(Vec<String>),
    /// Refuse with an `error` frame and close with its code as the reason.
    Refuse(&'static str),
}

#[derive(Default)]
pub struct Record {
    pub connections: usize,
    pub authenticated: usize,
    pub received: Vec<BoxMessage>,
    /// The close code each connection ended with, from the box.
    pub closes: Vec<u16>,
}

pub struct FakePlane {
    pub origin: String,
    pub record: Arc<Mutex<Record>>,
}

impl FakePlane {
    pub async fn start(box_id: &'static str, public_key: ed25519_dalek::VerifyingKey, scripts: Vec<Script>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let record = Arc::new(Mutex::new(Record::default()));
        let shared = Arc::clone(&record);

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let index = {
                    let mut record = shared.lock().unwrap();

                    record.connections += 1;
                    record.connections - 1
                };
                let script = scripts.get(index).or_else(|| scripts.last()).cloned().unwrap_or(Script::Send(Vec::new()));

                tokio::spawn(serve(stream, box_id, public_key, script, Arc::clone(&shared)));
            }
        });

        Self { origin, record }
    }
}

async fn send(socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, message: &CloudMessage) {
    let _ = socket.send(Message::text(encode_cloud_message(message).unwrap())).await;
}

async fn serve(stream: tokio::net::TcpStream, box_id: &str, public_key: ed25519_dalek::VerifyingKey, script: Script, record: Arc<Mutex<Record>>) {
    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
    let mut verified = false;

    while let Some(Ok(message)) = socket.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(frame) => {
                record.lock().unwrap().closes.push(frame.map_or(1005, |frame| u16::from(frame.code)));

                return;
            }
            _ => continue,
        };
        let Ok(decoded) = decode_box_message(&Frame::Text(&text)) else { continue };

        record.lock().unwrap().received.push(decoded.clone());

        match decoded {
            BoxMessage::Hello(_) => {
                if let Script::Refuse(code) = &script
                    && *code == "BOX_REVOKED"
                    && !verified
                {
                    refuse(&mut socket, code).await;

                    return;
                }

                send(&mut socket, &CloudMessage::Challenge { nonce: NONCE.into() }).await;
            }
            BoxMessage::Auth { signature } => {
                let bytes: Option<[u8; 64]> = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&signature).ok().and_then(|bytes| bytes.try_into().ok());
                let payload = challenge_payload(NONCE, box_id).unwrap();

                verified = bytes.is_some_and(|bytes| public_key.verify_strict(&payload, &ed25519_dalek::Signature::from_bytes(&bytes)).is_ok());

                if !verified {
                    refuse(&mut socket, "AUTH_FAILED").await;

                    return;
                }

                record.lock().unwrap().authenticated += 1;

                match &script {
                    Script::Send(frames) => {
                        for frame in frames {
                            send(&mut socket, frame).await;
                        }
                    }
                    Script::Raw(texts) => {
                        for text in texts {
                            let _ = socket.send(Message::text(text.clone())).await;
                        }
                    }
                    Script::Refuse(code) => {
                        refuse(&mut socket, code).await;

                        return;
                    }
                }
            }
            _ => {}
        }
    }
}

async fn refuse(socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, code: &'static str) {
    send(socket, &CloudMessage::Error { code: code.into(), message: format!("refused: {code}") }).await;
    let _ = socket.close(Some(CloseFrame { code: CloseCode::from(4001), reason: code.into() })).await;
}
