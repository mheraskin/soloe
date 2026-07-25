use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use soloe_terminal::TerminalManager;
use soloe_terminal::protocol::{
    InputRequest, MAX_REQUEST_BYTES, Outbound, PROTOCOL_VERSION, PingResponse, Request,
    ResizeRequest, Response, StartRequest, TerminalRequest,
};
use std::io::{self, BufRead, Write};
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Duration;

const OUTBOUND_QUEUE_DEPTH: usize = 256;

fn main() {
    if let Err(error) = run() {
        eprintln!("soloe-terminal-sidecar: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let (outbound_tx, outbound_rx) = sync_channel::<Outbound>(OUTBOUND_QUEUE_DEPTH);
    let writer = thread::Builder::new()
        .name("soloe-sidecar-stdout".to_string())
        .spawn(move || -> Result<(), String> {
            let stdout = io::stdout();
            let mut stdout = stdout.lock();
            while let Ok(outbound) = outbound_rx.recv() {
                write_json_line(&mut stdout, &outbound)?;
            }
            Ok(())
        })
        .map_err(|error| format!("failed to start stdout writer: {error}"))?;

    let manager = TerminalManager::new(outbound_tx.clone());
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = input
            .read_line(&mut line)
            .map_err(|error| format!("failed to read request: {error}"))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_REQUEST_BYTES {
            outbound_tx
                .send(Outbound::Response(Response::failure(
                    0,
                    "request exceeds byte limit",
                )))
                .map_err(|_| "stdout writer stopped".to_string())?;
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                outbound_tx
                    .send(Outbound::Response(Response::failure(
                        0,
                        format!("invalid request: {error}"),
                    )))
                    .map_err(|_| "stdout writer stopped".to_string())?;
                continue;
            }
        };
        let should_shutdown = request.method == "shutdown";
        let response = handle_request(&manager, request);
        outbound_tx
            .send(Outbound::Response(response))
            .map_err(|_| "stdout writer stopped".to_string())?;
        if should_shutdown {
            break;
        }
    }

    manager.shutdown(Duration::from_secs(3));
    drop(manager);
    drop(outbound_tx);
    writer
        .join()
        .map_err(|_| "stdout writer panicked".to_string())??;
    Ok(())
}

fn handle_request(manager: &TerminalManager, request: Request) -> Response {
    let id = request.id;
    let result: Result<Value, String> = match request.method.as_str() {
        "ping" => serde_json::to_value(PingResponse {
            protocol_version: PROTOCOL_VERSION,
        })
        .map_err(|error| error.to_string()),
        "start" => parse(request.params).and_then(|params: StartRequest| {
            manager
                .start(params)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }),
        "input" => parse(request.params).and_then(|params: InputRequest| {
            BASE64
                .decode(params.data_base64)
                .map_err(|error| format!("invalid input base64: {error}"))
                .and_then(|data| manager.write(&params.terminal_id, &data))
                .map(|_| json!(true))
        }),
        "resize" => parse(request.params).and_then(|params: ResizeRequest| {
            manager
                .resize(&params.terminal_id, params.cols, params.rows)
                .map(|_| json!(true))
        }),
        "stop" => parse(request.params).and_then(|params: TerminalRequest| {
            manager.stop(&params.terminal_id).map(|_| json!(true))
        }),
        "shutdown" => {
            manager.shutdown(Duration::from_secs(3));
            Ok(json!(true))
        }
        method => Err(format!("unknown method: {method}")),
    };

    match result {
        Ok(value) => Response::success(id, value),
        Err(error) => Response::failure(id, error),
    }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("invalid params: {error}"))
}

fn write_json_line(writer: &mut impl Write, value: &impl serde::Serialize) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value)
        .map_err(|error| format!("failed to serialize output: {error}"))?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| format!("failed to write output: {error}"))
}
