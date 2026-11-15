use home_hub_rust_mcp::transport::{self, Config};
use serde_json::json;
use std::{net::SocketAddr, path::PathBuf};
use tokio::net::TcpListener;

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal registration");
        tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bind: SocketAddr = "127.0.0.1:0".parse()?;
    let mut socket = None;
    let mut origins = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => bind = args.next().ok_or("--bind requires a value")?.parse()?,
            "--socket" => {
                socket = Some(PathBuf::from(
                    args.next().ok_or("--socket requires a value")?,
                ))
            }
            "--allow-origin" => origins.push(args.next().ok_or("--allow-origin requires a value")?),
            "--help" => {
                println!(
                    "home-hub-rust-mcp --socket /private/directory/bridge.sock [--bind 127.0.0.1:0] [--allow-origin exact-origin]"
                );
                return Ok(());
            }
            _ => return Err("Unknown argument".into()),
        }
    }
    let socket = socket.ok_or("--socket is required")?;
    if !socket.is_absolute() {
        return Err("Socket path must be absolute".into());
    }
    let listener = TcpListener::bind(transport::validate_bind(bind)?).await?;
    // One machine-readable readiness line, never a token, body, URL query or request error.
    println!(
        "{}",
        json!({"event":"listening","origin":format!("http://{}",listener.local_addr()?),"limits":{"bodyBytes":transport::BODY_LIMIT,"headerBytes":transport::HEADER_LIMIT,"headerCount":transport::HEADER_COUNT,"connections":transport::MAX_CONNECTIONS,"arrivalMs":transport::ARRIVAL_TIMEOUT.as_millis(),"ipcMs":transport::IPC_TIMEOUT.as_millis(),"connectionMs":transport::CONNECTION_TIMEOUT.as_millis()}})
    );
    transport::serve(listener, Config { socket, origins }, shutdown()).await?;
    Ok(())
}
