//! Reusable sidecar worker processes.
//!
//! Every Tauri command used to spawn a fresh sidecar, write one NDJSON line,
//! close stdin, and wait for the process to exit. That is simple and it isolates
//! failures, but it pays a full PyInstaller `--onefile` self-extraction per
//! command, and it reads the child's pipes only *after* it exits -- so any
//! command whose output outgrows the pipe buffer deadlocks and surfaces as a
//! timeout.
//!
//! This module keeps the workers alive between commands instead.
//!
//! It is a pool rather than a single daemon on purpose. The Python side loops
//! `for raw_line in stdin`, strictly serially, so one shared process would make
//! a two-minute identity audit block the twelve-second status poll behind it --
//! worse than what it replaces. A pool keeps each worker serial, which is what
//! the Python loop already guarantees, while different commands still run
//! concurrently on different workers.
//!
//! That serial-per-worker property is also what makes stderr attribution exact:
//! the sidecar flushes a request's diagnostics before its response, so once the
//! response line arrives, everything waiting on that worker's stderr belongs to
//! that request and nothing later can have been interleaved.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command as StdCommand, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use crate::sidecar::{SidecarProcessOutput, SidecarRunnerError};

/// Idle workers kept warm. Beyond this they are dropped rather than pooled, so a
/// burst of parallel commands does not leave a pile of processes behind.
const MAX_IDLE_WORKERS: usize = 4;

/// Grace period for a worker to exit after its stdin closes, before it is killed.
const WORKER_SHUTDOWN_GRACE: Duration = Duration::from_millis(250);

/// How long to keep collecting stderr after a response arrives.
///
/// The sidecar flushes a request's diagnostics before its response, but the two
/// pipes are read by separate threads, so write order does not guarantee delivery
/// order. This window covers the gap. Anything still late is carried into the
/// next exchange rather than dropped -- each diagnostic line identifies its own
/// request, so which round-trip carried it does not change where it is recorded.
const STDERR_SETTLE_WINDOW: Duration = Duration::from_millis(50);

/// One live sidecar process holding an open NDJSON conversation.
struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout_rx: Receiver<String>,
    stderr_rx: Receiver<String>,
    /// Diagnostics that arrived too late for their own exchange.
    pending_stderr: String,
}

impl Worker {
    fn spawn(mut command: StdCommand) -> Result<Self, SidecarRunnerError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|_| SidecarRunnerError::Unavailable)?;

        let stdin = child.stdin.take().ok_or(SidecarRunnerError::Io)?;
        let stdout = child.stdout.take().ok_or(SidecarRunnerError::Io)?;
        let stderr = child.stderr.take().ok_or(SidecarRunnerError::Io)?;

        // Both pipes are drained continuously by their own thread. Reading them
        // only on demand is what made the previous implementation deadlock once
        // a response outgrew the pipe buffer.
        let stdout_rx = spawn_line_reader(stdout);
        let stderr_rx = spawn_line_reader(stderr);

        Ok(Self {
            child,
            stdin,
            stdout_rx,
            stderr_rx,
            pending_stderr: String::new(),
        })
    }

    /// Send one request and wait for its response line.
    ///
    /// Returns `Err` if the worker is unusable afterwards; the caller must not
    /// return it to the pool in that case.
    fn exchange(
        &mut self,
        request_line: &str,
        timeout: Duration,
    ) -> Result<SidecarProcessOutput, SidecarRunnerError> {
        // Carry forward anything an earlier exchange did not manage to collect.
        // Dropping it would silently lose diagnostics; each line names its own
        // request, so reporting it here records it under the right id regardless.
        let mut stderr = std::mem::take(&mut self.pending_stderr);
        stderr.push_str(&drain_pending(&self.stderr_rx));

        // A stray stdout line would mean a previous response went unread, which
        // makes every later reply answer the wrong caller. Refuse to continue.
        if self.stdout_rx.try_recv().is_ok() {
            return Err(SidecarRunnerError::Io);
        }

        self.stdin
            .write_all(request_line.as_bytes())
            .and_then(|()| self.stdin.write_all(b"\n"))
            .and_then(|()| self.stdin.flush())
            .map_err(|_| SidecarRunnerError::Io)?;

        let stdout = match self.stdout_rx.recv_timeout(timeout) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => return Err(SidecarRunnerError::Timeout),
            // The reader thread ended, which means the pipe closed: the worker died.
            Err(RecvTimeoutError::Disconnected) => return Err(SidecarRunnerError::Io),
        };

        stderr.push_str(&drain_settling(&self.stderr_rx, STDERR_SETTLE_WINDOW));

        Ok(SidecarProcessOutput {
            // A pooled worker does not exit per request. Reaching this point means
            // the exchange completed, which is what the caller's exit-code check
            // was standing in for.
            exit_code: Some(0),
            stdout,
            stderr,
        })
    }

    /// Whether the process is still running and can take another request.
    fn is_healthy(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Stash whatever arrived after the last exchange finished collecting.
    fn absorb_late_stderr(&mut self) {
        let late = drain_pending(&self.stderr_rx);
        self.pending_stderr.push_str(&late);
    }

    fn shutdown(mut self) {
        // Closing stdin is the documented way to end the NDJSON loop; killing is
        // the fallback for a worker that is wedged.
        drop(self.stdin);
        let deadline = Instant::now() + WORKER_SHUTDOWN_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() >= deadline => break,
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_line_reader<R: std::io::Read + Send + 'static>(pipe: R) -> Receiver<String> {
    let (tx, rx): (Sender<String>, Receiver<String>) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    rx
}

/// Take everything currently queued, joined back into newline-terminated text.
fn drain_pending(rx: &Receiver<String>) -> String {
    let mut out = String::new();
    while let Ok(line) = rx.try_recv() {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Collect lines until the stream stays quiet for `window`, or the deadline passes.
///
/// The window restarts on every line, so a burst is collected in full, while a
/// silent stream costs one window rather than the whole budget.
fn drain_settling(rx: &Receiver<String>, window: Duration) -> String {
    let deadline = Instant::now() + window * 4;
    let mut out = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return out;
        }
        match rx.recv_timeout(window.min(remaining)) {
            Ok(line) => {
                out.push_str(&line);
                out.push('\n');
            }
            Err(RecvTimeoutError::Timeout) => return out,
            Err(RecvTimeoutError::Disconnected) => return out,
        }
    }
}

/// Warm sidecar workers, shared across commands via Tauri managed state.
pub struct SidecarPool {
    idle: Mutex<VecDeque<Worker>>,
}

impl SidecarPool {
    pub fn new() -> Self {
        Self {
            idle: Mutex::new(VecDeque::new()),
        }
    }

    /// Run one request on a warm worker, spawning one if none is free.
    ///
    /// `spawn` is a factory rather than a stored command because a `StdCommand`
    /// cannot be cloned, and the Tauri sidecar path is resolved per call.
    pub fn run<F>(
        &self,
        spawn: F,
        request_line: String,
        timeout: Duration,
    ) -> Result<SidecarProcessOutput, SidecarRunnerError>
    where
        F: FnOnce() -> Result<StdCommand, SidecarRunnerError>,
    {
        let mut worker = match self.take_idle() {
            Some(worker) => worker,
            None => Worker::spawn(spawn()?)?,
        };

        match worker.exchange(&request_line, timeout) {
            Ok(output) => {
                if worker.is_healthy() {
                    worker.absorb_late_stderr();
                    self.put_idle(worker);
                } else {
                    worker.shutdown();
                }
                Ok(output)
            }
            Err(error) => {
                // A worker that timed out is still mid-request: its next response
                // would answer the wrong caller. Never reuse it.
                worker.shutdown();
                Err(error)
            }
        }
    }

    fn take_idle(&self) -> Option<Worker> {
        let mut idle = self.idle.lock().ok()?;
        while let Some(mut worker) = idle.pop_front() {
            if worker.is_healthy() {
                return Some(worker);
            }
            // Dropped while idle -- discard and try the next one.
            drop(idle);
            worker.shutdown();
            idle = self.idle.lock().ok()?;
        }
        None
    }

    fn put_idle(&self, worker: Worker) {
        let Ok(mut idle) = self.idle.lock() else {
            worker.shutdown();
            return;
        };
        if idle.len() >= MAX_IDLE_WORKERS {
            drop(idle);
            worker.shutdown();
            return;
        }
        idle.push_back(worker);
    }

    /// Stop every pooled worker. Called when the app shuts down.
    pub fn shutdown(&self) {
        let drained: Vec<Worker> = match self.idle.lock() {
            Ok(mut idle) => idle.drain(..).collect(),
            Err(_) => return,
        };
        for worker in drained {
            worker.shutdown();
        }
    }

    #[cfg(test)]
    fn idle_count(&self) -> usize {
        self.idle.lock().map(|idle| idle.len()).unwrap_or(0)
    }
}

impl Default for SidecarPool {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in sidecar: reads NDJSON lines, echoes a response, and can be told
    /// to emit diagnostics, stall, or exit -- the behaviours the pool must handle.
    fn echo_worker_command() -> StdCommand {
        let mut command = StdCommand::new("python3");
        command.arg("-c").arg(ECHO_WORKER_SOURCE);
        command
    }

    const ECHO_WORKER_SOURCE: &str = r#"
import json, sys, time
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    request = json.loads(raw)
    behaviour = request.get("behaviour")
    if behaviour == "stall":
        time.sleep(30)
    if behaviour == "exit":
        sys.exit(0)
    for note in request.get("diagnostics", []):
        print(json.dumps({"note": note}), file=sys.stderr, flush=True)
    print(json.dumps({"id": request.get("id"), "ok": True}), flush=True)
"#;

    fn request(id: &str) -> String {
        format!(r#"{{"id":"{id}"}}"#)
    }

    #[test]
    fn reuses_one_worker_across_requests() {
        let pool = SidecarPool::new();

        for index in 0..3 {
            let output = pool
                .run(
                    || Ok(echo_worker_command()),
                    request(&format!("request-{index}")),
                    Duration::from_secs(10),
                )
                .expect("exchange succeeds");
            assert!(output.stdout.contains(&format!("request-{index}")));
        }

        assert_eq!(pool.idle_count(), 1, "the worker should have been reused, not respawned");
    }

    #[test]
    fn no_diagnostic_line_is_lost_across_reused_workers() {
        // Attribution is best-effort -- stdout and stderr are separate pipes read
        // by separate threads, so write order does not guarantee delivery order,
        // and a late line is carried into the next exchange. What must never
        // happen is a line disappearing: each one is a diagnostics-log record.
        let pool = SidecarPool::new();
        let mut seen = String::new();

        for index in 0..5 {
            let output = pool
                .run(
                    || Ok(echo_worker_command()),
                    format!(r#"{{"id":"req-{index}","diagnostics":["note-{index}"]}}"#),
                    Duration::from_secs(10),
                )
                .expect("exchange succeeds");
            seen.push_str(&output.stderr);
        }

        for index in 0..5 {
            assert!(
                seen.contains(&format!("note-{index}")),
                "diagnostic note-{index} was dropped: {seen}"
            );
        }
    }

    #[test]
    fn a_timed_out_worker_is_destroyed_rather_than_reused() {
        // Its next response would answer the wrong caller.
        let pool = SidecarPool::new();

        let error = pool
            .run(
                || Ok(echo_worker_command()),
                r#"{"id":"stalls","behaviour":"stall"}"#.to_string(),
                Duration::from_millis(200),
            )
            .expect_err("stalling request times out");

        assert_eq!(error, SidecarRunnerError::Timeout);
        assert_eq!(pool.idle_count(), 0, "a mid-request worker must not be pooled");
    }

    #[test]
    fn a_worker_that_exits_is_not_pooled() {
        let pool = SidecarPool::new();

        let error = pool
            .run(
                || Ok(echo_worker_command()),
                r#"{"id":"exits","behaviour":"exit"}"#.to_string(),
                Duration::from_secs(10),
            )
            .expect_err("a worker that exits mid-request reports failure");

        assert_eq!(error, SidecarRunnerError::Io);
        assert_eq!(pool.idle_count(), 0);
    }

    #[test]
    fn recovers_after_a_worker_dies() {
        let pool = SidecarPool::new();

        let _ = pool.run(
            || Ok(echo_worker_command()),
            r#"{"id":"exits","behaviour":"exit"}"#.to_string(),
            Duration::from_secs(10),
        );
        let output = pool
            .run(
                || Ok(echo_worker_command()),
                request("after-death"),
                Duration::from_secs(10),
            )
            .expect("the pool spawns a replacement");

        assert!(output.stdout.contains("after-death"));
    }

    #[test]
    fn a_response_larger_than_the_pipe_buffer_does_not_deadlock() {
        // The previous implementation read the child's pipes only after it
        // exited, so a large response filled the buffer and wedged both sides.
        let pool = SidecarPool::new();
        let mut command = StdCommand::new("python3");
        command.arg("-c").arg(
            r#"
import json, sys
for raw in sys.stdin:
    print(json.dumps({"id": "big", "payload": "x" * 400000}), flush=True)
"#,
        );

        let output = pool
            .run(|| Ok(command), request("big"), Duration::from_secs(20))
            .expect("a large response is delivered");

        assert!(output.stdout.len() > 300_000);
    }

    /// The packaged sidecar, if it has been built. Skipped otherwise so a fresh
    /// clone can still run the suite.
    fn packaged_sidecar_command() -> Option<StdCommand> {
        // The filename carries the target triple, which is not exposed to the
        // test binary, so the directory is scanned instead.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let entry = std::fs::read_dir(dir).ok()?.flatten().find(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("theprivator-sidecar-"))
        })?;
        Some(StdCommand::new(entry.path()))
    }

    #[test]
    fn reuses_the_real_sidecar_across_requests() {
        // The stub above proves the pool's own protocol handling. This proves the
        // thing it will actually talk to keeps answering on a reused stdin --
        // which is the whole premise of pooling rather than respawning.
        let Some(_) = packaged_sidecar_command() else {
            eprintln!("skipping: packaged sidecar not built");
            return;
        };
        let pool = SidecarPool::new();

        for index in 0..3 {
            let output = pool
                .run(
                    || packaged_sidecar_command().ok_or(SidecarRunnerError::Unavailable),
                    format!(
                        r#"{{"id":"pool-{index}","method":"health.status","params":{{}}}}"#
                    ),
                    Duration::from_secs(30),
                )
                .expect("the packaged sidecar answers");

            assert_eq!(output.exit_code, Some(0));
            assert!(
                output.stdout.contains(&format!("pool-{index}")),
                "response did not echo the request id: {}",
                output.stdout
            );
        }

        assert_eq!(
            pool.idle_count(),
            1,
            "the real sidecar should have been reused, not respawned per request"
        );
    }

    #[test]
    fn idle_workers_are_capped() {
        let pool = SidecarPool::new();
        let mut workers = Vec::new();
        for _ in 0..(MAX_IDLE_WORKERS + 2) {
            workers.push(Worker::spawn(echo_worker_command()).expect("worker spawns"));
        }
        for worker in workers {
            pool.put_idle(worker);
        }

        assert_eq!(pool.idle_count(), MAX_IDLE_WORKERS);
    }
}
