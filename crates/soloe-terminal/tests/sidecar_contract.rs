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

    fn receive(&self) -> Value {
        self.messages
            .recv_timeout(Duration::from_secs(10))
            .expect("sidecar response or event")
    }

    fn response(&self, id: u64) -> Value {
        loop {
            let message = self.receive();
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
    let (shell, args, input) = (
        "powershell.exe",
        vec!["-NoLogo", "-NoProfile", "-NoExit"],
        b"[Console]::Write(([char]30).ToString() + 'sidecar-contract-ok' + ([char]31).ToString()); exit 0\r\n"
            .as_slice(),
    );
    #[cfg(not(windows))]
    let (shell, args, input) = (
        "/bin/bash",
        vec!["--noprofile", "--norc"],
        b"printf '\\036%s\\037\\n' 'sidecar-contract-ok'; exit 0\n".as_slice(),
    );
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
            "env": { "TERM": "xterm-256color", "LANG": "C.UTF-8" },
            "cols": 80,
            "rows": 24
        }
    }));
    let started = sidecar.response(2);
    assert_eq!(started["ok"], true);
    assert_eq!(started["value"]["terminalId"], "terminal-contract");
    assert!(started["value"]["pid"].as_u64().is_some_and(|pid| pid > 0));

    sidecar.send(json!({
        "id": 3,
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
        let message = sidecar.receive();
        if message.get("id").and_then(Value::as_u64) == Some(3) {
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
    assert!(
        output
            .windows(b"\x1esidecar-contract-ok\x1f".len())
            .any(|window| window == b"\x1esidecar-contract-ok\x1f"),
        "marker missing from PTY output: {}",
        String::from_utf8_lossy(&output)
    );
    assert!(!sequences.is_empty());
    assert!(sequences.windows(2).all(|pair| pair[1] == pair[0] + 1));

    sidecar.shutdown();
}
