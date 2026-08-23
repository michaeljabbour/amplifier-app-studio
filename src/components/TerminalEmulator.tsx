import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type {
  TerminalCoordinatorContract,
  TerminalSession,
} from "../terminal";
import { terminalInputRequest } from "../terminal/input";

interface Props {
  session: TerminalSession;
  coordinator: TerminalCoordinatorContract;
  onError: (error: unknown) => void;
}

/** A real terminal cell grid: ANSI redraws and keyboard bytes stay intact. */
export function TerminalEmulator(props: Props) {
  const [ready, setReady] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let terminal: Terminal | undefined;
  let fit: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let renderedSession = "";
  let renderedSnapshot = "";
  let renderedLive = "";
  let sendQueue = Promise.resolve();

  onMount(() => {
    if (!host) return;
    terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5_000,
      theme: {
        background: "#181715",
        foreground: "#eeeae3",
        cursor: "#d5a34f",
        cursorAccent: "#181715",
        selectionBackground: "#66533299",
      },
    });
    const unicode = new Unicode11Addon();
    fit = new FitAddon();
    terminal.loadAddon(unicode);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(fit);
    terminal.open(host);
    setReady(true);

    const input = terminal.onData((data) => {
      const sessionId = props.session.id;
      sendQueue = sendQueue
        .then(async () => {
          if (props.session.id !== sessionId) return;
          await props.coordinator.send(sessionId, terminalInputRequest(data));
        })
        .catch((error) => props.onError(error));
    });
    const resized = terminal.onResize(({ cols, rows }) => {
      void props.coordinator.resize(props.session.id, { columns: cols, rows }).catch(props.onError);
    });

    const refit = () => {
      try {
        fit?.fit();
      } catch {
        // A hidden or closing webview can briefly have no measurable cells.
      }
    };
    resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(refit);
    resizeObserver?.observe(host);
    queueMicrotask(refit);

    onCleanup(() => {
      resizeObserver?.disconnect();
      input.dispose();
      resized.dispose();
      terminal?.dispose();
      terminal = undefined;
      fit = undefined;
      setReady(false);
    });
  });

  createEffect(() => {
    ready();
    const emulator = terminal;
    const session = props.session;
    const snapshot = session.snapshot || "";
    const live = session.liveOutput || "";
    if (!emulator) return;

    emulator.options.disableStdin = session.capabilities.send !== "input";
    if (session.id !== renderedSession) {
      renderedSession = session.id;
      renderedSnapshot = "";
      renderedLive = "";
      emulator.reset();
    }

    if (session.capabilities.outputMode === "snapshot") {
      if (snapshot !== renderedSnapshot) {
        renderedSnapshot = snapshot;
        renderedLive = "";
        emulator.write(snapshot);
      }
      return;
    }

    if (snapshot !== renderedSnapshot || !live.startsWith(renderedLive)) {
      renderedSnapshot = snapshot;
      renderedLive = live;
      emulator.reset();
      emulator.write(`${snapshot}${live}`);
      return;
    }
    if (live.length > renderedLive.length) {
      const delta = live.slice(renderedLive.length);
      renderedLive = live;
      emulator.write(delta);
    }
  });

  return (
    <div
      ref={host}
      class="terminal-emulator"
      role="application"
      aria-label={`Interactive terminal for ${props.session.name}`}
      onPointerDown={() => terminal?.focus()}
    />
  );
}
