//! Async loopback HTTP callback server for desktop MCP OAuth flows.
//!
//! Reads incoming connections concurrently with bounded header timeouts and
//! byte caps so browser speculative preconnect sockets never stall the real
//! authorization redirect. Validates `Host` against [`HostAllowList::loopback`]
//! and matches CSRF `state` before claiming the flow.

use std::time::Duration;

use rmcp::transport::auth::AuthorizationSession;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::{finish_session, McpOAuthError, StoredToken, OAUTH_REDIRECT_PATH};

/// Outcome parsed from a loopback desktop OAuth redirect whose `state` matches
/// the started authorization flow.
enum DesktopCallback {
    Code {
        code: String,
        state: String,
        issuer: Option<String>,
    },
    Denied(String),
}

const CALLBACK_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CALLBACK_HEADER_BYTES: u64 = 32 * 1024;
const MAX_CONCURRENT_CALLBACK_READERS: usize = 16;

const CALLBACK_SUCCESS_HTML: &str = "<!DOCTYPE html><html><body><h2>Authorization complete</h2><p>You can close this tab and return to Karsa.</p><script>window.close();</script></body></html>";
const CALLBACK_DENIED_HTML: &str = "<!DOCTYPE html><html><body><h2>Authorization cancelled</h2><p>Sign-in was not completed. You can close this tab and return to Karsa.</p></body></html>";
const CALLBACK_FAILED_HTML: &str = "<!DOCTYPE html><html><body><h2>Authorization failed</h2><p>Karsa could not finish signing in. You can close this tab and return to Karsa.</p></body></html>";

async fn write_http_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    html_body: Option<&str>,
) {
    let response = match html_body {
        Some(body) => format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
        None => format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    };
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

fn parse_desktop_callback(
    target: &str,
    port: u16,
    expected_state: &str,
) -> Option<DesktopCallback> {
    let url = url::Url::parse(&format!("http://127.0.0.1:{port}{target}")).ok()?;
    if url.path() != OAUTH_REDIRECT_PATH {
        return None;
    }
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut issuer: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "iss" => issuer = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => error_description = Some(value.into_owned()),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return None;
    }
    if let Some(err) = error {
        let description = error_description
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(err);
        return Some(DesktopCallback::Denied(description));
    }
    let code = code?;
    Some(DesktopCallback::Code {
        code,
        state: expected_state.to_string(),
        issuer,
    })
}

async fn read_callback_connection(
    stream: tokio::net::TcpStream,
    port: u16,
    expected_state: String,
    tx: tokio::sync::mpsc::Sender<(DesktopCallback, tokio::net::TcpStream)>,
) {
    let mut reader = BufReader::new(stream.take(MAX_CALLBACK_HEADER_BYTES));
    let read_result = tokio::time::timeout(CALLBACK_HEADER_READ_TIMEOUT, async {
        let mut first_line = String::new();
        if reader.read_line(&mut first_line).await.ok()? == 0 {
            return None;
        }
        let mut header_lines = Vec::new();
        for _ in 0..100 {
            let mut line = String::new();
            if reader.read_line(&mut line).await.ok()? == 0 {
                return None;
            }
            let is_end = line.trim().is_empty();
            header_lines.push(line);
            if is_end {
                return Some((first_line, header_lines));
            }
        }
        None
    })
    .await;

    let Ok(Some((first_line, header_lines))) = read_result else {
        return;
    };
    let mut stream = reader.into_inner().into_inner();
    if !crate::web::host_allow::HostAllowList::loopback()
        .allows_header_block(&mut header_lines.into_iter().map(Ok))
    {
        log::warn!("[mcp-oauth] rejected callback request: foreign or missing host");
        write_http_response(&mut stream, "403 Forbidden", None).await;
        return;
    }
    let target = first_line.split_whitespace().nth(1).unwrap_or("/");
    let Some(callback) = parse_desktop_callback(target, port, &expected_state) else {
        write_http_response(&mut stream, "404 Not Found", None).await;
        return;
    };
    if tx.try_send((callback, stream)).is_err() {
        // Another matching callback already claimed the flow.
    }
}

/// Wait for the desktop loopback OAuth redirect on `listener`, validate `Host`
/// and CSRF `state`, exchange the authorization code (including RFC 9207 `iss`
/// validation), persist the token, and send the final browser response.
pub async fn complete_desktop_flow(
    listener: tokio::net::TcpListener,
    port: u16,
    expected_state: &str,
    server_url: &str,
    session: AuthorizationSession,
    timeout: Duration,
) -> Result<StoredToken, McpOAuthError> {
    let sleep = tokio::time::sleep_until(tokio::time::Instant::now() + timeout);
    tokio::pin!(sleep);
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let mut readers = tokio::task::JoinSet::new();

    let (callback, mut stream) = loop {
        tokio::select! {
            received = rx.recv() => {
                match received {
                    Some(item) => break item,
                    None => return Err(McpOAuthError::Timeout),
                }
            }
            accepted = listener.accept() => {
                while readers.try_join_next().is_some() {}
                match accepted {
                    Ok((mut stream, _addr)) => {
                        if readers.len() >= MAX_CONCURRENT_CALLBACK_READERS {
                            write_http_response(&mut stream, "503 Service Unavailable", None).await;
                            continue;
                        }
                        readers.spawn(read_callback_connection(
                            stream,
                            port,
                            expected_state.to_string(),
                            tx.clone(),
                        ));
                    }
                    Err(e) => {
                        return Err(McpOAuthError::Http(format!("callback listener error: {e}")));
                    }
                }
            }
            () = &mut sleep => {
                return Err(McpOAuthError::Timeout);
            }
        }
    };
    readers.abort_all();

    match callback {
        DesktopCallback::Denied(description) => {
            write_http_response(&mut stream, "400 Bad Request", Some(CALLBACK_DENIED_HTML)).await;
            Err(McpOAuthError::Denied(description))
        }
        DesktopCallback::Code {
            code,
            state,
            issuer,
        } => match finish_session(server_url, session, &code, &state, issuer.as_deref()).await {
            Ok(stored) => {
                write_http_response(&mut stream, "200 OK", Some(CALLBACK_SUCCESS_HTML)).await;
                Ok(stored)
            }
            Err(error) => {
                write_http_response(&mut stream, "502 Bad Gateway", Some(CALLBACK_FAILED_HTML))
                    .await;
                Err(error)
            }
        },
    }
}
