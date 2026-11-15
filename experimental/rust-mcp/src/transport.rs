use crate::protocol;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{
    Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    future::Future,
    io,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixStream},
    sync::Semaphore,
    task::JoinSet,
    time::timeout,
};

pub const BODY_LIMIT: usize = 65_536;
pub const HEADER_LIMIT: usize = 16_384;
pub const HEADER_COUNT: usize = 64;
pub const IPC_REQUEST_LIMIT: usize = 128 * 1024;
pub const IPC_RESPONSE_LIMIT: usize = 16 * 1024 * 1024;
pub const MAX_CONNECTIONS: usize = 128;
pub const ARRIVAL_TIMEOUT: Duration = Duration::from_secs(10);
pub const IPC_TIMEOUT: Duration = Duration::from_secs(30);
pub const CONNECTION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct Config {
    pub socket: PathBuf,
    pub origins: Vec<String>,
}
pub type HttpResponse = Response<Full<Bytes>>;

pub fn validate_bind(bind: SocketAddr) -> io::Result<SocketAddr> {
    if !bind.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Experimental frontend must bind an explicit loopback IP",
        ));
    }
    Ok(bind)
}

pub async fn bridge(socket: &PathBuf, value: Value) -> io::Result<Value> {
    timeout(IPC_TIMEOUT, async {
        let body = serde_json::to_vec(&value)?;
        if body.len() > IPC_REQUEST_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "IPC input limit",
            ));
        }
        let mut stream = UnixStream::connect(socket).await?;
        stream.write_u32(body.len() as u32).await?;
        stream.write_all(&body).await?;
        let size = stream.read_u32().await? as usize;
        if size == 0 || size > IPC_RESPONSE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "IPC output limit",
            ));
        }
        let mut output = vec![0; size];
        stream.read_exact(&mut output).await?;
        serde_json::from_slice(&output).map_err(io::Error::other)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "IPC deadline"))?
}

// One in-flight operation per pooled connection; failures discard it without replay.
// Idle expiry is shorter than the bridge deadline, so ordinary reuse avoids stale sockets.
#[derive(Default)]
struct BridgePool {
    idle: Mutex<Vec<(UnixStream, Instant)>>,
    catalog: Mutex<Option<(String, Arc<Value>)>>,
}
impl BridgePool {
    async fn call(&self, socket: &PathBuf, mut value: Value) -> io::Result<Value> {
        value["persistent"] = json!(true);
        let cached = if value["operation"] == "list" {
            self.catalog.lock().unwrap().clone()
        } else {
            None
        };
        if let Some((revision, _)) = &cached {
            value["catalogRevision"] = json!(revision);
        }
        timeout(IPC_TIMEOUT, async {
            let body = serde_json::to_vec(&value)?;
            if body.len() > IPC_REQUEST_LIMIT {
                return Err(io::Error::other("IPC input limit"));
            }
            let idle = {
                let mut pool = self.idle.lock().unwrap();
                pool.retain(|(_, at)| at.elapsed() < Duration::from_secs(5));
                pool.pop()
            };
            let mut stream = match idle {
                Some((stream, _)) => stream,
                None => UnixStream::connect(socket).await?,
            };
            let mut frame = Vec::with_capacity(body.len() + 4);
            frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
            frame.extend_from_slice(&body);
            stream.write_all(&frame).await?;
            let size = stream.read_u32().await? as usize;
            if size == 0 || size > IPC_RESPONSE_LIMIT {
                return Err(io::Error::other("IPC output limit"));
            }
            let mut output = vec![0; size];
            stream.read_exact(&mut output).await?;
            let mut reply: Value = serde_json::from_slice(&output)?;
            if value["operation"] == "list" && reply["ok"] == true {
                if let Some(revision) = reply["result"]["revision"].as_str().map(str::to_owned) {
                    if reply["result"]["tools"].is_array() {
                        *self.catalog.lock().unwrap() =
                            Some((revision, Arc::new(reply["result"]["tools"].clone())));
                    } else if let Some((previous, tools)) = cached {
                        if previous != revision {
                            return Err(io::Error::other("IPC catalog revision mismatch"));
                        }
                        reply["result"]["tools"] = (*tools).clone();
                    } else {
                        return Err(io::Error::other("IPC catalog missing"));
                    }
                }
            }
            let mut pool = self.idle.lock().unwrap();
            if pool.len() < MAX_CONNECTIONS {
                pool.push((stream, Instant::now()));
            }
            Ok(reply)
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "IPC deadline"))?
    }
}

fn response(status: u16, body: Option<Value>) -> HttpResponse {
    let bytes = body
        .as_ref()
        .map(|v| serde_json::to_vec(v).unwrap_or_default())
        .unwrap_or_default();
    let mut out = Response::new(Full::new(Bytes::from(bytes)));
    *out.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = out.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    if body.is_some() {
        headers.insert("content-type", "application/json".parse().unwrap());
    }
    if status == 401 {
        headers.insert(
            "www-authenticate",
            "Bearer realm=\"home-hub\"".parse().unwrap(),
        );
    }
    if status == 405 {
        headers.insert("allow", "POST".parse().unwrap());
    }
    out
}
fn http_error(status: u16, code: &str, message: &str) -> HttpResponse {
    response(
        status,
        Some(json!({"error":{"code":code,"message":message}})),
    )
}
fn unavailable() -> HttpResponse {
    http_error(
        503,
        "BRIDGE_UNAVAILABLE",
        "Business bridge unavailable. Read state before retrying a write.",
    )
}

async fn authenticated_error(
    config: &Config,
    pool: &BridgePool,
    authorization: &str,
    status: u16,
    code: &str,
    message: &str,
) -> HttpResponse {
    match pool
        .call(
            &config.socket,
            json!({"v":1,"operation":"authenticate","authorization":authorization}),
        )
        .await
    {
        Ok(value) if value.get("ok") == Some(&Value::Bool(true)) => {
            http_error(status, code, message)
        }
        Ok(value) => {
            let (status, body) = protocol::parse(b"{}").finish(value);
            response(status, body)
        }
        Err(_) => unavailable(),
    }
}

fn host_is_loopback(host: &str) -> bool {
    // Origin rejection plus an explicit Host allowlist blocks browser DNS rebinding.
    // The listener's IP is also validated independently before bind.
    host.parse::<hyper::http::uri::Authority>()
        .ok()
        .is_some_and(|authority| {
            let host = authority.host();
            host.eq_ignore_ascii_case("localhost")
                || host == "[::1]"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}
fn is_json(value: &str) -> bool {
    value.strip_prefix("application/json").is_some_and(|tail| {
        tail.chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
    })
}

async fn handle(
    req: Request<Incoming>,
    config: Arc<Config>,
    pool: Arc<BridgePool>,
) -> Result<HttpResponse, Infallible> {
    if req.headers().get_all("host").iter().count() != 1
        || !req
            .headers()
            .get("host")
            .and_then(|v| v.to_str().ok())
            .is_some_and(host_is_loopback)
    {
        return Ok(http_error(
            403,
            "HOST_REJECTED",
            "Loopback Host header required.",
        ));
    }
    if req.uri().path() != "/mcp" {
        return Ok(http_error(404, "NOT_FOUND", "Not found."));
    }
    if req.method() != hyper::Method::POST {
        return Ok(http_error(
            405,
            "METHOD_NOT_ALLOWED",
            "The Home Hub MCP endpoint accepts POST only.",
        ));
    }
    if req.headers().get_all("origin").iter().count() > 1
        || req.headers().get("origin").is_some_and(|v| {
            v.to_str()
                .map_or(true, |origin| !config.origins.iter().any(|o| o == origin))
        })
    {
        return Ok(http_error(403, "ORIGIN_REJECTED", "Request not allowed."));
    }
    let authorization = if req.headers().get_all("authorization").iter().count() == 1 {
        req.headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    } else {
        String::new()
    };
    if req.headers().get_all("content-type").iter().count() != 1
        || !req
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(is_json)
    {
        return Ok(authenticated_error(
            &config,
            &pool,
            &authorization,
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Send JSON-RPC as application/json.",
        )
        .await);
    }
    if req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|v| v > BODY_LIMIT as u64)
    {
        return Ok(authenticated_error(
            &config,
            &pool,
            &authorization,
            413,
            "TOO_LARGE",
            "Request too large.",
        )
        .await);
    }
    let mut body = req.into_body();
    let read = timeout(ARRIVAL_TIMEOUT, async {
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| 400u16)?;
            if let Some(data) = frame.data_ref() {
                if bytes.len() + data.len() > BODY_LIMIT {
                    return Err(413);
                }
                bytes.extend_from_slice(data);
            }
        }
        Ok(bytes)
    })
    .await;
    let raw = match read {
        Ok(Ok(raw)) => raw,
        Ok(Err(413)) => {
            return Ok(authenticated_error(
                &config,
                &pool,
                &authorization,
                413,
                "TOO_LARGE",
                "Request too large.",
            )
            .await);
        }
        Ok(Err(_)) => return Ok(http_error(400, "BAD_REQUEST", "Invalid HTTP body.")),
        Err(_) => {
            return Ok(http_error(
                408,
                "REQUEST_TIMEOUT",
                "Request arrival timed out.",
            ));
        }
    };
    let mut action = protocol::parse(&raw);
    let request = action.bridge_request(&authorization);
    let output = match pool.call(&config.socket, request).await {
        Ok(value) => {
            let (status, body) = action.finish(value);
            response(status, body)
        }
        Err(_) => unavailable(),
    };
    Ok(output)
}

/// A bound, loopback listener and shutdown future make this embeddable in test binaries too.
/// Admission is fail-fast (no unbounded waiting queue). Accepted connections and tasks are bounded.
pub async fn serve(
    listener: TcpListener,
    config: Config,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    validate_bind(listener.local_addr()?)?;
    let config = Arc::new(config);
    let pool = Arc::new(BridgePool::default());
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _=&mut shutdown=>break,
            Some(_)=tasks.join_next(),if !tasks.is_empty()=>{},
            accepted=listener.accept()=>{
                let (stream,_)=accepted?;
                let Ok(permit)=slots.clone().try_acquire_owned() else {drop(stream);continue;};
                stream.set_nodelay(true)?;
                let config=config.clone();
                let pool=pool.clone();
                tasks.spawn(async move {
                    let _permit=permit;
                    let service=service_fn(move |req|handle(req,config.clone(),pool.clone()));
                    let mut builder=http1::Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(ARRIVAL_TIMEOUT)
                        .max_headers(HEADER_COUNT).max_buf_size(HEADER_LIMIT).keep_alive(true);
                    // The absolute lifetime also bounds idle keep-alive clients and response backpressure.
                    let _=timeout(CONNECTION_TIMEOUT,builder.serve_connection(TokioIo::new(stream),service)).await;
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn pooled_frames_reuse_connection_and_lost_reply_is_not_replayed() {
        let dir = std::env::temp_dir().join(format!("rust-mcp-pool-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("bridge.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            for n in 0..3 {
                let size = stream.read_u32().await.unwrap();
                let mut bytes = vec![0; size as usize];
                stream.read_exact(&mut bytes).await.unwrap();
                let input: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(input["persistent"], true);
                assert_eq!(input["authorization"], format!("key-{n}"));
                if n == 2 {
                    break;
                } // Simulate execution followed by a lost reply.
                let reply = br#"{"ok":true}"#;
                stream.write_u32(reply.len() as u32).await.unwrap();
                stream.write_all(reply).await.unwrap();
            }
            drop(stream);
            assert!(
                timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
        });
        let pool = BridgePool::default();
        for n in 0..2 {
            assert_eq!(
                pool.call(
                    &socket,
                    json!({"operation":"authenticate","authorization":format!("key-{n}")})
                )
                .await
                .unwrap()["ok"],
                true
            );
        }
        assert!(
            pool.call(&socket, json!({"operation":"call","authorization":"key-2"}))
                .await
                .is_err()
        );
        assert!(pool.idle.lock().unwrap().is_empty());
        server.await.unwrap();
        std::fs::remove_file(socket).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn only_loopback_bind_and_hosts() {
        assert!(validate_bind("0.0.0.0:9000".parse().unwrap()).is_err());
        assert!(validate_bind("[::]:9000".parse().unwrap()).is_err());
        assert!(validate_bind("127.0.0.1:0".parse().unwrap()).is_ok());
        assert!(validate_bind("[::1]:0".parse().unwrap()).is_ok());
        assert!(host_is_loopback("localhost:9000"));
        assert!(host_is_loopback("[::1]:9000"));
        assert!(!host_is_loopback("example.com"));
        assert!(!host_is_loopback("localhost.example.com"));
        assert!(is_json("application/json; charset=utf-8"));
        assert!(!is_json("application/jsonp"));
    }
    #[tokio::test]
    async fn oversized_ipc_frame_fails_before_allocation() {
        let dir = std::env::temp_dir().join(format!("rust-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("bridge.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let size = stream.read_u32().await.unwrap();
            let mut input = vec![0; size as usize];
            stream.read_exact(&mut input).await.unwrap();
            stream
                .write_u32((IPC_RESPONSE_LIMIT + 1) as u32)
                .await
                .unwrap();
        });
        assert!(bridge(&socket, json!({"v":1})).await.is_err());
        server.await.unwrap();
        std::fs::remove_file(socket).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
