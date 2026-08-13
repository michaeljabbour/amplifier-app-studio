# Amplifier Studio release-readiness questions

This document separates what the repository proves today from the product
direction. It should be updated with each release rather than treated as a
one-time roadmap.

## Engine and installation

1. **What does Studio actually depend on?** Desktop Studio invokes
   `amplifier-runtime serve`, the UI-neutral JSONL host published from the
   standalone `amplifier-runtime` repository. Runtime brings `amplifier-core`
   and `amplifier-foundation`; Studio does not import or execute the TUI or the
   reference CLI.
2. **Is Python embedded in the app?** No. The desktop bridge runs the runtime
   out of process. This protects the protocol boundary, but it means the GUI
   and engine currently have separate lifecycles.
3. **Can Studio set up a clean machine?** The welcome screen can run the
   runtime's pinned shell installer on macOS/Linux or its PowerShell installer
   on Windows, then verifies `amplifier-runtime --version`. Windows bootstrap is
   implemented but remains release-proven only when it passes a clean Windows
   install/launch test. The long-term target is a signed, versioned runtime
   pack with an A/B repair slot.
4. **Who configures providers and keys?** The existing Amplifier runtime owns
   provider configuration under `~/.amplifier`. Studio checks that status
   before enabling the first prompt and offers an explicit setup dialog that
   passes a newly entered key over stdin. It never overwrites an already
   configured provider implicitly and does not copy keys into Web storage.
5. **Can the GUI and runtime drift?** Today, yes. The GUI updater and the
   source-installed runtime are independent. A production runtime pack needs a
   manifest containing runtime revision and supported protocol range, with a
   repair action when compatibility fails.

## Platforms and placement

6. **Is this a native app on all four targets?** Tauri produces native shells
   for macOS, Windows, iOS, and Android. Only desktop hosts can spawn the local
   Python runtime. Mobile shells are native clients of a Rust runtime host.
7. **Can a phone connect securely today?** Only through a trusted TLS tunnel.
   The v0.1 host binds to loopback, requires a strong bearer token, validates
   browser origins, and restricts execution to canonical project roots. It
   still lacks device pairing, per-device revocation, and tenant isolation, so
   it must not be exposed directly to a LAN or the public Internet.
8. **Where do code and data execute?** Desktop local mode executes in the
   selected local project. Web/mobile mode executes on the configured bridge
   host. Studio must show placement explicitly before a turn and never imply
   that remote work stayed on the phone.
9. **Does it work offline?** The shell and local session history do. A turn is
   offline only when the selected Amplifier provider and bundle are offline.
   Mobile always requires its bridge.
10. **Can generated artifacts be used on mobile?** The UI identifies output
    paths, but the bridge does not yet provide authenticated artifact download,
    preview, provenance, or retention APIs. A host path is not yet a mobile
    deliverable.

## Sessions, security, and enterprise operation

11. **Are all existing Amplifier sessions resumable?** Studio scans the shared
    `~/.amplifier/projects` store, not a Studio-only index. Historical paths
    are read as metadata and are touched only when the user chooses to resume,
    avoiding unsolicited protected-folder permission prompts.
12. **Do idle tabs cost resources?** Yes. Each live tab owns a resident Python
    process. Logical sessions should eventually become dormant between clean
    turns and reactivate on composition-keyed warm workers.
13. **Are disconnects durable?** A WebSocket disconnect now detaches without
    stopping its child, and the same in-memory host can reattach and replay
    durable history from a conservative cursor. Host restarts, mobile
    backgrounding, durable tab identity, and approval handoff between devices
    still need end-to-end proof.
14. **Is the bridge enterprise-safe?** No. It now has authenticated WebSockets,
    exact Origin enforcement, bounded fan-out, and symlink-safe project-root
    authorization. It still lacks per-device principals, RBAC, quotas, budget
    enforcement, revocation, TLS termination, and Studio-visible audit/lease
    controls. Loopback plus a trusted authenticated tunnel remains the only
    supported remote posture.
15. **Is rendered model content hardened?** Markdown is sanitized, remote
    images/active elements are blocked, and the native WebView applies a
    restrictive CSP. The browser host must preserve equivalent response
    headers when deployed behind a TLS proxy.
16. **Can sessions be retained, exported, deleted, or placed on legal hold?**
    Not through Studio yet. The current drawer is intentionally read-only.

## Composition, speed, and release operations

17. **Can providers or bundles change without restarting work?** Studio can
    launch a parallel sibling with another bundle/provider. It does not yet
    mutate a running composition. The correct future primitive is a
    turn-pinned composition generation with plan/apply/status/rollback.
18. **Why can a trivial task still be slow?** Measured donor turns show both
    large prompt/model cost and synchronous optional-hook latency. Instrument
    and circuit-break hooks first, then add deterministic quick actions and a
    slim request-scoped fast lane.
19. **Does auto-update work?** The code checks, downloads, verifies, drains
    owned runtimes, installs, restarts, and restores durable sessions on
    desktop. A release build must embed the GitHub endpoint, be signed with the
    Tauri updater key, and have a newer published version in a complete
    cross-platform `latest.json`. Local builds intentionally disable checks.
    Release proof remains an older installed binary visibly offering and
    successfully applying the newer release.
20. **Are packages signed?** macOS local packages are Developer-ID signed with
    a stable designated requirement. Public macOS packages still require Apple
    notarization. Windows needs an Authenticode certificate; Android needs a
    protected upload keystore; iOS needs App Store signing/provisioning. Do not
    label unsigned/debug mobile artifacts as releases.

## Release claim

The defensible v0.1 claim is: **a real local macOS and browser Amplifier Studio,
with cross-platform Tauri clients and a shared Rust transport architecture.**
Secure hosted/mobile operation, clean-machine Windows proof, store-ready mobile
packages, and enterprise control-plane features remain explicit gates.
