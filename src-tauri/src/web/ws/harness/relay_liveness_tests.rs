//! AD-19 relay-execution audit repros (AD-16 "Relay execution" cases): a
//! handler slower than the pong deadline, a stalled half-open peer, and a host
//! stop with an open socket. They fail on a relay whose read loop awaits
//! handlers, whose watchdog lives in the write arm, or whose sockets outlive
//! the host.

use tokio::sync::oneshot;

use super::raw_client::RawWsClient;
use super::*;
use crate::acp::events;
use crate::acp::manager::{FakeAuth, FakeTurn};

/// One agent text chunk fanned out like the real driver does.
pub(super) fn emit_chunk(host: &Host) {
    let event = events::MessageChunkEvent {
        agent_id: AgentId(AGENT.to_string()),
        session_id: SessionId(SESSION.to_string()),
        role: events::ChunkRole::Agent,
        content: agent_client_protocol::schema::v1::ContentBlock::Text(
            agent_client_protocol::schema::v1::TextContent::new("chunk"),
        ),
        message_id: None,
        parent_tool_call_id: None,
    };
    let sinks: Vec<Arc<dyn crate::web::EventSink>> = vec![host.relay.clone()];
    events::fan_out(&sinks, Some(SESSION), events::EVENT_MESSAGE_CHUNK, &event);
}

/// How long a half-open peer may stay unnoticed in the foreground: the pong
/// deadline plus one watchdog tick.
fn foreground_reap_by() -> Duration {
    PONG_TIMEOUT + WATCHDOG_TICK
}

/// Last instant a backgrounded half-open peer must still be held: one
/// watchdog tick short of the background ceiling.
fn background_held_until() -> Duration {
    BACKGROUND_TIMEOUT - WATCHDOG_TICK
}

/// By when a backgrounded half-open peer must be gone: the ceiling plus the
/// tick that notices it, with a second of margin.
fn background_reap_by() -> Duration {
    BACKGROUND_TIMEOUT + WATCHDOG_TICK + Duration::from_secs(1)
}

/// A streaming turn: chunks keep flowing for `total` of (virtual) time.
async fn stream_for(host: &Host, total: Duration) {
    let mut left = total;
    while !left.is_zero() {
        emit_chunk(host);
        let step = left.min(Duration::from_secs(1));
        tokio::time::sleep(step).await;
        left -= step;
    }
}

/// A handler slower than the pong deadline must not get the connection
/// killed: the read loop never awaits a handler, so the peer's pongs keep
/// refreshing the watchdog while the request runs.
#[tokio::test(start_paused = true)]
async fn audit_long_handler_vs_ping() {
    let host = Host::new(|acp, sessions| {
        acp.install_test_agent_with_scripts(
            AgentId(AGENT.to_string()),
            sessions,
            Vec::new(),
            false,
            vec![FakeAuth::ok_after(foreground_reap_by() + PING_INTERVAL)],
        );
    });
    let mut conn = host.connect();
    conn.authenticate().await;

    // The peer is healthy throughout: its auto-pong answers every ping.
    conn.send_request(
        "slow",
        "authenticate_agent",
        json!({"agentId": AGENT, "methodId": "oauth"}),
    );
    conn.peer.read_for(foreground_reap_by()).await;
    assert!(
        !conn.relay_finished().await,
        "a handler slower than the pong deadline ({PONG_TIMEOUT:?}) got a healthy connection killed"
    );
    // The watchdog kept pinging throughout; the peer's pongs are what kept
    // the connection alive.
    let expected_pings = (foreground_reap_by().as_secs() / PING_INTERVAL.as_secs()) as usize - 1;
    assert!(
        conn.peer.pings_seen >= expected_pings,
        "the relay sent {} keepalive pings, expected at least {expected_pings}",
        conn.peer.pings_seen
    );

    let reply = conn.peer.wait_reply("slow").await;
    assert_eq!(reply["ok"], true, "{reply}");
}

/// A half-open peer during a streaming turn is reaped by the watchdog within
/// the pong deadline, and a backgrounded one only after the background hold,
/// even though its socket stopped draining (the write loop is stuck in a send).
#[tokio::test(start_paused = true)]
async fn audit_stale_peer_during_stream_is_reaped_by_the_watchdog() {
    let (release_tx, release_rx) = oneshot::channel();
    let (entered_tx, entered_rx) = oneshot::channel();
    let host = Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(
            AgentId(AGENT.to_string()),
            sessions,
            vec![FakeTurn::Hold {
                release: release_rx,
                entered: entered_tx,
            }],
            false,
        );
    });

    let mut foreground = host.connect();
    foreground.authenticate().await;
    foreground.subscribe("sub").await;
    let mut backgrounded = host.connect();
    backgrounded.authenticate().await;
    backgrounded.subscribe("sub").await;

    foreground.send_prompt_request("p1", "turn-1");
    entered_rx.await.expect("turn entered the fake agent");
    foreground.peer.wait_event("user_prompt").await;

    // Both peers go half-open mid-stream: no more pongs, and the socket stops
    // draining (a full send buffer towards a dead flow).
    backgrounded.peer.send_text(r#"{"type":"background"}"#);
    Conn::settle().await;
    for conn in [&foreground, &backgrounded] {
        conn.peer.set_auto_pong(false);
        conn.peer.stall_writes();
    }

    // Foreground: reaped within PONG_TIMEOUT plus one ping interval.
    stream_for(&host, foreground_reap_by()).await;
    assert!(
        foreground.relay_finished().await,
        "a stale foreground peer was not reaped within the pong deadline ({:?})",
        foreground_reap_by()
    );
    assert!(
        !backgrounded.relay_finished().await,
        "the {BACKGROUND_TIMEOUT:?} background hold must be honored"
    );

    // Background: still held just short of the ceiling, reaped by the first
    // tick after it.
    stream_for(&host, background_held_until() - foreground_reap_by()).await;
    assert!(
        !backgrounded.relay_finished().await,
        "the {BACKGROUND_TIMEOUT:?} background hold must be honored"
    );
    stream_for(&host, background_reap_by() - background_held_until()).await;
    assert!(
        backgrounded.relay_finished().await,
        "a stale backgrounded peer was not reaped after the {BACKGROUND_TIMEOUT:?} hold"
    );
    drop(release_tx);
}

const OVERSIZE_TEXT_BYTES: usize = 20 * 1024 * 1024;

/// `/ws` takes no frame past tungstenite's 16 MiB default from a peer that
/// has not authenticated: the read fails and the connection ends, instead of
/// the host buffering up to the canvas reply cap for anyone who connects.
#[tokio::test]
async fn an_unauthenticated_frame_past_the_default_limit_ends_the_connection() {
    let host = Host::new(|_, _| {});
    let addr = serve_ws(&host).await;
    let mut client = RawWsClient::connect(addr, "/ws").await;
    client
        .read_json_within(Duration::from_secs(5))
        .await
        .expect("auth_required event not delivered in time")
        .expect("auth_required event");

    let pad = "a".repeat(OVERSIZE_TEXT_BYTES);
    // The host may close before it has read the whole frame.
    let _ = client
        .send_text(
            &json!({ "id": "big", "type": "authenticate", "payload": { "pad": pad } }).to_string(),
        )
        .await;

    loop {
        let frame = client
            .read_json_within(Duration::from_secs(30))
            .await
            .expect("the socket stayed open after an oversize frame");
        let Some(frame) = frame else { break };
        assert_ne!(
            frame["id"], "big",
            "the oversize frame was answered: {frame}"
        );
    }
}

/// An export larger than one frame still reaches the call: an authenticated
/// renderer sends the reply as slices, the host joins them, and the socket
/// stays open for the next message.
#[tokio::test]
async fn an_authenticated_renderer_can_answer_a_canvas_call_with_a_reply_past_the_frame_limit() {
    let host = Host::new(|_, _| {});
    host.state
        .acp
        .canvas_router()
        .mounts()
        .ensure_test_mount("p-canvas", 1);
    let addr = serve_ws(&host).await;
    let mut client = RawWsClient::connect(addr, "/ws").await;
    client
        .read_json_within(Duration::from_secs(5))
        .await
        .expect("auth_required event not delivered in time")
        .expect("auth_required event");

    send_request(
        &mut client,
        "auth",
        "authenticate",
        json!({
            "protocolVersion": WS_PROTOCOL_VERSION,
            "deviceId": "device-harness",
            "clientInstanceId": crate::canvas::persistence::TEST_RENDERER,
        }),
    )
    .await;
    let authed = wait_reply(&mut client, "auth").await;
    assert_eq!(authed["ok"], true, "{authed}");
    send_request(
        &mut client,
        "mount",
        "canvas_mount",
        json!({ "projectId": "p-canvas", "mountSeq": 1 }),
    )
    .await;
    let mounted = wait_reply(&mut client, "mount").await;
    assert_eq!(mounted["payload"]["attached"], true, "{mounted}");

    let call = tokio::spawn({
        let acp = Arc::clone(&host.state.acp);
        async move {
            acp.canvas_router()
                .call("p-canvas", "export.png", "{}".into())
                .await
        }
    });
    let call_id = loop {
        let frame = client
            .read_json_within(Duration::from_secs(5))
            .await
            .expect("no canvas_call frame in time")
            .expect("the socket closed before the call arrived");
        if frame["type"] == "canvas_call" {
            break frame["callId"].as_u64().expect("callId");
        }
    };

    let result = "a".repeat(OVERSIZE_TEXT_BYTES);
    let slice_len = 8 * 1024 * 1024;
    let slices: Vec<&[u8]> = result.as_bytes().chunks(slice_len).collect();
    for (index, slice) in slices.iter().enumerate() {
        let last = index + 1 == slices.len();
        let id = format!("slice-{index}");
        let mut payload = json!({
            "callId": call_id,
            "mountSeq": 1,
            "ok": true,
            "result": std::str::from_utf8(slice).expect("ascii"),
        });
        if !last {
            payload["partial"] = json!(true);
        }
        send_request(&mut client, &id, "canvas_reply", payload).await;
        let reply = wait_reply(&mut client, &id).await;
        let key = if last { "resolved" } else { "accepted" };
        assert_eq!(reply["payload"][key], true, "{reply}");
    }

    assert_eq!(call.await.expect("call task"), Ok(result));
}

async fn send_request(client: &mut RawWsClient, id: &str, type_: &str, payload: Value) {
    client
        .send_text(&json!({ "id": id, "type": type_, "payload": payload }).to_string())
        .await
        .expect("the host closed the socket on a request");
}

async fn wait_reply(client: &mut RawWsClient, id: &str) -> Value {
    loop {
        let frame = client
            .read_json_within(Duration::from_secs(30))
            .await
            .unwrap_or_else(|()| panic!("no reply to {id} in time"))
            .unwrap_or_else(|| panic!("the socket closed before the reply to {id}"));
        if frame["id"] == id {
            return frame;
        }
    }
}

/// The real `/ws` upgrade handler over a loopback listener, for a host's
/// state: a local, write-capable peer on an OS-assigned port.
async fn serve_ws(host: &Host) -> std::net::SocketAddr {
    let app = axum::Router::new()
        .route("/ws", axum::routing::get(crate::web::ws::ws_upgrade))
        .with_state(host.state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind a loopback port");
    let addr = listener.local_addr().expect("bound address");
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    addr
}
