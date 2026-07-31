use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, sync_channel};
use std::thread;
use std::time::Duration;

struct Sidecar {
    child: Child,
    input: ChildStdin,
    messages: Receiver<Value>,
}

impl Sidecar {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_soloe-terminal-sidecar"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn sidecar");
        let input = child.stdin.take().expect("sidecar stdin");
        let output = child.stdout.take().expect("sidecar stdout");
        let (messages_tx, messages) = sync_channel(128);
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let line = line.expect("sidecar output line");
                let value = serde_json::from_str(&line).expect("sidecar JSON line");
                if messages_tx.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            messages,
        }
    }

    fn send(&mut self, value: Value) {
        serde_json::to_writer(&mut self.input, &value).expect("write request");
        self.input.write_all(b"\n").expect("write newline");
        self.input.flush().expect("flush request");
    }

    fn receive(&self, expected: &str) -> Value {
        let message = self
            .messages
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|error| panic!("timed out waiting for {expected}: {error}"));
        if std::env::var_os("SOLOE_TEST_TRACE").is_some() {
            eprintln!("sidecar message: {message}");
        }
        message
    }

    fn response(&self, id: u64) -> Value {
        loop {
            let message = self.receive(&format!("response {id}"));
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return message;
            }
        }
    }

    fn shutdown(mut self) {
        self.send(json!({ "id": 99, "method": "shutdown" }));
        let response = self.response(99);
        assert_eq!(response["ok"], true);
        drop(self.input);
        let status = self.child.wait().expect("wait for sidecar");
        assert!(status.success(), "sidecar exited with {status}");
    }
}

#[test]
fn supervises_a_pty_and_flushes_ordered_output_before_exit() {
    #[cfg(windows)]
    let system_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("WINDIR"))
        .expect("Windows system root");
    #[cfg(windows)]
    let shell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    #[cfg(windows)]
    let (args, input) = (
        vec!["-NoLogo", "-NoProfile", "-NoExit"],
        b"[Console]::Write((-join [char[]](115,105,100,101,99,97,114,45,99,111,110,116,114,97,99,116,45,111,107))); exit 0\r\n"
            .as_slice(),
    );
    #[cfg(windows)]
    let terminal_env = {
        let mut env = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
        env.insert("TERM".to_string(), "xterm-256color".to_string());
        env.insert("LANG".to_string(), "C.UTF-8".to_string());
        env
    };
    #[cfg(not(windows))]
    let (shell, args, input) = (
        "/bin/bash",
        vec!["--noprofile", "--norc"],
        b"printf '\\036%s\\037\\n' 'sidecar-contract-ok'; exit 0\n".as_slice(),
    );
    #[cfg(not(windows))]
    let terminal_env = json!({ "TERM": "xterm-256color", "LANG": "C.UTF-8" });
    let mut sidecar = Sidecar::start();
    sidecar.send(json!({ "id": 1, "method": "ping" }));
    let ping = sidecar.response(1);
    assert_eq!(ping["ok"], true);
    assert_eq!(ping["value"]["protocolVersion"], 1);

    sidecar.send(json!({
        "id": 2,
        "method": "start",
        "params": {
            "terminalId": "terminal-contract",
            "sessionId": "session-contract",
            "file": shell,
            "args": args,
            "cwd": env!("CARGO_MANIFEST_DIR"),
            "env": terminal_env,
            "cols": 80,
            "rows": 24
        }
    }));
    let started = sidecar.response(2);
    assert_eq!(started["ok"], true, "start response: {started}");
    assert_eq!(started["value"]["terminalId"], "terminal-contract");
    assert!(started["value"]["pid"].as_u64().is_some_and(|pid| pid > 0));

    #[cfg(windows)]
    {
        let cursor_query = sidecar.receive("PowerShell cursor-position query");
        assert_eq!(cursor_query["event"], "output");
        assert_eq!(
            BASE64
                .decode(
                    cursor_query["payload"]["dataBase64"]
                        .as_str()
                        .expect("cursor query base64")
                )
                .expect("decode cursor query"),
            b"\x1b[6n"
        );
        sidecar.send(json!({
            "id": 3,
            "method": "input",
            "params": {
                "terminalId": "terminal-contract",
                "dataBase64": BASE64.encode(b"\x1b[1;1R")
            }
        }));
        assert_eq!(sidecar.response(3)["ok"], true);
    }
    #[cfg(windows)]
    let input_request_id = 4;
    #[cfg(not(windows))]
    let input_request_id = 3;
    sidecar.send(json!({
        "id": input_request_id,
        "method": "input",
        "params": {
            "terminalId": "terminal-contract",
            "dataBase64": BASE64.encode(input)
        }
    }));

    let mut output = Vec::new();
    let mut sequences = Vec::new();
    let mut saw_input_response = false;
    let mut saw_exit = false;
    while !saw_exit {
        let message = sidecar.receive("terminal input response, output, or exit");
        if message.get("id").and_then(Value::as_u64) == Some(input_request_id) {
            assert_eq!(message["ok"], true);
            saw_input_response = true;
            continue;
        }
        match message.get("event").and_then(Value::as_str) {
            Some("output") => {
                let payload = &message["payload"];
                assert_eq!(payload["terminalId"], "terminal-contract");
                sequences.push(payload["seq"].as_u64().expect("output sequence"));
                output.extend(
                    BASE64
                        .decode(payload["dataBase64"].as_str().expect("output base64"))
                        .expect("decode output"),
                );
            }
            Some("exit") => {
                assert_eq!(message["payload"]["terminalId"], "terminal-contract");
                assert_eq!(message["payload"]["exitCode"], 0);
                saw_exit = true;
            }
            _ => {}
        }
    }

    assert!(saw_input_response);
    #[cfg(windows)]
    let marker = b"sidecar-contract-ok".as_slice();
    #[cfg(not(windows))]
    let marker = b"\x1esidecar-contract-ok\x1f".as_slice();
    assert!(
        output.windows(marker.len()).any(|window| window == marker),
        "marker missing from PTY output: {}",
        String::from_utf8_lossy(&output)
    );
    assert!(!sequences.is_empty());
    assert!(sequences.windows(2).all(|pair| pair[1] == pair[0] + 1));

    sidecar.shutdown();
}
