//! Process-wide logging setup.
//!
//! Studio previously had no logging at all: sixteen `println!` calls, no `tracing`, no panic
//! hook. Every failure mode the hardening audit found was invisible in production -- a session
//! wedged by a dropped reader logged nothing, an infinite reconnect was silent server-side, and
//! a "damaged transcript" never said which line failed to parse. An operator running
//! `amplifier-host` under systemd got a startup banner and then nothing at all.
//!
//! Verbosity is controlled by `RUST_LOG` (the iOS scheme already sets `RUST_LOG=info`, which
//! previously did nothing). Defaults to `info` for Studio's own crates and `warn` elsewhere so
//! dependency chatter does not drown the signal.

use std::sync::Once;

static INIT: Once = Once::new();

/// Installs the tracing subscriber and a panic hook. Safe to call more than once.
pub fn init(component: &'static str) {
    INIT.call_once(|| {
        use tracing_subscriber::{fmt, prelude::*, EnvFilter};

        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("warn,amplifier_studio=info,amplifier_host=info"));

        // Writing to stderr keeps stdout free: the desktop app pipes runtime stdout as protocol
        // JSONL, and mixing log lines into it would desynchronize the frame reader.
        let layer = fmt::layer()
            .with_target(true)
            .with_level(true)
            .with_writer(std::io::stderr);

        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(layer)
            .try_init();

        install_panic_hook(component);
        tracing::info!(
            component,
            version = env!("CARGO_PKG_VERSION"),
            "logging started"
        );
    });
}

/// Logs panics before the process dies. Without this a panicking task left no trace at all.
fn install_panic_hook(component: &'static str) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".to_owned());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| (*value).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic payload".to_owned());
        tracing::error!(
            component,
            location = %location,
            payload = %payload,
            thread = ?std::thread::current().name(),
            "panic",
        );
        previous(info);
    }));
}
