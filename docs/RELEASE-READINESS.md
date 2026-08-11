# Amplifier Studio release-readiness questions

This document separates what the repository proves today from the product
direction. It should be updated with each release rather than treated as a
one-time roadmap.

## Engine and installation

1. **What does Studio actually depend on?** Desktop Studio invokes
   `amplifier-tui serve`, the JSONL host shipped by `amplifier-app-tui`.
   That Python package brings `amplifier-core` and `amplifier-foundation`.
   Studio does not import or execute `amplifier-app-cli`, and
   `amplifier-agent` is a future engine-adapter direction rather than a current
   dependency.
2. **Is Python embedded in the app?** No. The desktop bridge runs the runtime
   out of process. This protects the protocol boundary, but it means the GUI
   and engine currently have separate lifecycles.
3. **Can Studio set up a clean machine?** On macOS and Linux, yes as an interim
   source-channel path: the welcome screen can run the donor's hardened
   installer and verify `amplifier-tui --version`. The long-term distribution
   target is a signed, versioned runtime pack with an A/B repair slot. Native
   Windows runtime bootstrap is not release-proven yet.
4. **Who configures providers and keys?** The existing Amplifier runtime owns
   provider configuration under `~/.amplifier`. Studio does not copy secrets
   into Web storage. A native setup/diagnostics surface is still needed so a
   new user does not have to discover terminal commands.
5. **Can the GUI and runtime drift?** Today, yes. The GUI updater and the
   source-installed runtime are independent. A production runtime pack needs a
   manifest containing runtime revision and supported protocol range, with a
   repair action when compatibility fails.

## Platforms and placement

6. **Is this a native app on all four targets?** Tauri produces native shells
   for macOS, Windows, iOS, and Android. Only desktop hosts can spawn the local
   Python runtime. Mobile shells are native clients of a Rust runtime host.
7. **Can a phone connect securely today?** Not by exposing the included server
   directly. The v0.1 bridge deliberately binds only to loopback because it
   does not yet implement TLS, device pairing, authentication, tenant
   isolation, or revocation. An authenticated tunnel is required for testing.
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
13. **Are disconnects durable?** Transcripts are durable, but live Studio tabs
    are memory-only and a WebSocket disconnect currently stops its child.
    Reconnect tokens, tab restoration, mobile-background semantics, and
    durable pending approvals remain open work.
14. **Is the bridge enterprise-safe?** Loopback binding limits exposure, but
    the server still lacks authenticated WebSockets, Origin enforcement,
    project-root authorization, RBAC, quotas, and audit identity. Those are
    prerequisites for hosted or LAN use.
15. **Is rendered model content hardened?** Markdown is sanitized and remote
    images/active elements are blocked. The application CSP is still disabled
    and must be tightened before calling the WebView hardened.
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
19. **Does auto-update work?** The code checks, downloads, installs, and
    restarts on desktop. A release build must embed the GitHub endpoint, be
    signed with the Tauri updater key, and have a newer published version in
    `latest.json`. Local builds intentionally disable checks. Release proof is
    an older installed binary visibly offering the newer release.
20. **Are packages signed?** macOS local packages are Developer-ID signed with
    a stable designated requirement. Public macOS packages still require Apple
    notarization. Windows needs an Authenticode certificate; Android needs a
    protected upload keystore; iOS needs App Store signing/provisioning. Do not
    label unsigned/debug mobile artifacts as releases.

## Release claim

The defensible v0.1 claim is: **a real local macOS and browser Amplifier Studio,
with cross-platform Tauri clients and a shared Rust transport architecture.**
Secure hosted/mobile operation, native Windows runtime bootstrap, store-ready
mobile packages, and enterprise control-plane features remain explicit gates.
