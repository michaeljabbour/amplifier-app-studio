# Amplifier Studio dynamic platform plan

Status: proposed execution plan, 2026-08-18

This plan turns the next product requirements into explicit service boundaries.
It avoids making a Spark, a filesystem path, a model vendor, or a release
environment a permanent property of the Studio client.

## Decisions

1. `amplifier.run` is the development and staging trust domain.
   `amplifier.ms` is the production trust domain.
2. Compute, workspace storage, source control, model providers, and session
   history are separate resources. A session joins them with short-lived,
   scoped leases.
3. A project is a logical workspace, not a path on the currently selected
   machine. Paths are checkout details owned by a compute host.
4. Provider configuration is a registry of named instances. One instance is
   primary for each capability and optional fallbacks are explicit.
5. Parallel sessions never write to the same checkout. Each writable session
   receives its own branch and worktree or snapshot.
6. A release is not accepted because CI compiled it. The installed executable,
   app, or store bundle must pass a target-device smoke test.

## Target boundaries

```text
Studio clients
  macOS | Windows | iOS | Android | web
                    |
           identity + control API
                    |
       session and workspace coordinator
         /          |          |          \
 provider broker  Git manager  storage   compute scheduler
         |          |          |          |
 named provider   repository  immutable  leased Spark or
 instances        + worktree  snapshots  personal host
```

The coordinator stores resource IDs, policy, leases, and audit events. It does
not turn host paths into global workspace identities and it does not place raw
provider, Git, or object-store credentials in a mobile or browser client.

## Environment and domain model

Use the same subdomain vocabulary in both environments:

| Purpose | Development | Production |
| --- | --- | --- |
| Web client | `app.amplifier.run` | `app.amplifier.ms` |
| Control API | `api.amplifier.run` | `api.amplifier.ms` |
| Host relay | `relay.amplifier.run` | `relay.amplifier.ms` |
| Workspace transfer | `storage.amplifier.run` | `storage.amplifier.ms` |
| Git integration | `git.amplifier.run` | `git.amplifier.ms` |
| Release/update metadata | `releases.amplifier.run` | `releases.amplifier.ms` |

Each environment must have separate OAuth clients, GitHub App installations,
databases, buckets, encryption keys, host enrollment roots, provider secret
namespaces, telemetry projects, signing permissions, and update channels.
Production credentials must not be readable by a development deployment.

Do not scatter those URLs through components. Add one typed environment
manifest consumed by the transport layer:

```json
{
  "schemaVersion": 1,
  "environment": "development",
  "controlApi": "https://api.amplifier.run",
  "relay": "wss://relay.amplifier.run",
  "storage": "https://storage.amplifier.run",
  "git": "https://git.amplifier.run",
  "audience": "amplifier-studio-development"
}
```

Release builds choose a signed manifest before platform signing. Production
builds are locked to the production trust root; debug and internal builds may
offer an environment switch and must show a persistent non-production badge.
An authenticated `/v1/environment` response lets Studio detect a mismatched
binary, token audience, or backend before starting a session.

## Workspace storage and file manager

Studio should consume a logical workspace API rather than browsing S3 keys or
assuming a Unix filesystem:

- `list`, `stat`, `read`, `write`, `mkdir`, `rename`, and `delete` for file UX;
- `changes` and `diff` for review;
- `snapshot`, `restore`, and `export` for durable checkpoints;
- multipart upload/download sessions with hashes for large artifacts;
- optimistic revision IDs so an overwrite cannot silently lose another edit.

The durable storage model has three layers:

1. repository origin and commit identity;
2. immutable, content-addressed workspace snapshots and artifacts;
3. a writable checkout leased to exactly one session.

The first file-manager milestone should provide breadcrumbs, back/up
navigation, recent workspaces, new-folder and new-project actions, search, Git
status badges, and an explicit location label such as `Stored in Amplifier
Cloud · running on spark-288f`. The client should cache directory metadata and
small read-only content so mobile remains useful through brief disconnects.

Object storage is an implementation detail behind this API. Clients receive
short-lived, object-specific transfer URLs and checksums, never bucket
credentials. Compute leases are scoped to one workspace revision and cannot
enumerate every workspace owned by the user.

## Git manager and safe parallelism

Use a GitHub App for GitHub-hosted repositories. Its installation is limited to
selected repositories and its short-lived token is minted server-side. Add
other Git providers behind the same repository-credential interface later.

For each writable session:

1. resolve the repository and base revision;
2. create a session branch such as `amplifier/<session-id>`;
3. create or restore a dedicated worktree/snapshot;
4. lease that checkout to one compute host;
5. publish commits and diffs to the session ledger;
6. merge, rebase, open a pull request, or discard only through an explicit
   user action.

Fan-out creates independent branches/worktrees. Fan-in compares their recorded
base revisions and produces a merge plan; it never lets multiple agents mutate
one shared checkout. Protected branches remain protected, conflicts are a
first-class state, and destructive Git actions require confirmation plus an
audit event.

## Dynamic model-provider registry

Replace the current fixed settings paths such as
`providers.anthropic.api_key` with a host-owned collection:

```ts
interface ProviderInstance {
  id: string;
  driver: "anthropic" | "openai" | "azure-openai" | "gemini" | string;
  displayName: string;
  credentialRef: string;
  baseUrl?: string;
  defaultModel?: string;
  models: string[];
  capabilities: Array<"chat" | "vision" | "image" | "embedding" | "audio">;
  enabled: boolean;
  scope: "host" | "organization" | "project";
  health: "unknown" | "ready" | "degraded" | "unavailable";
}

interface ProviderPolicy {
  primaryByCapability: Record<string, string>;
  fallbackByCapability: Record<string, string[]>;
  projectOverrides: Record<string, string>;
}
```

Example instances could be `Anthropic personal`, `Anthropic work`, `OpenAI
production`, and `Azure East US`. The UI lists all instances, supports add,
edit, disable, test, and remove, and uses a radio-style `Primary` control per
capability. It should summarize `Primary: Anthropic work · 2 fallbacks` rather
than treating a provider type as a singleton.

`credentialRef` points to the runtime host's OS credential store or the managed
secret broker. Studio receives only masked metadata and readiness. A fallback
must never silently change data residency, organization billing, or tool-call
compatibility: those changes require an allowed policy and are recorded on the
turn. Provider instance, model, policy revision, and effective fallback are
pinned in the turn envelope for reproducibility.

This requires a versioned provider-registry contract in `amplifier-runtime`
before Studio removes the legacy settings fields. During migration, import one
legacy provider setting as one named instance and retain a read-only legacy
view until the host confirms the new registry was persisted.

## Session composition

A start request references resources by ID instead of copying configuration:

```json
{
  "workspaceId": "ws_...",
  "workspaceRevision": "rev_...",
  "computePoolId": "pool_sparks_dev",
  "providerPolicyId": "policy_...",
  "bundleId": "bundle_...",
  "mode": "auto"
}
```

The resulting turn records the resolved compute host, checkout, provider
instance/model, bundle digest, environment, and lease IDs. That makes retry,
resume, billing, and audit independent of whichever device opened the chat.

## Compilation and promotion pipeline

Build from an immutable commit and separate these gates:

1. **Source:** formatting, generated-file drift, typecheck, frontend tests,
   Rust tests, dependency audit, and protocol-contract tests.
2. **Platform build:** macOS arm64, Windows x64, iOS, and Android AAB; add
   Windows arm64 only after an actual ARM64 toolchain/device gate exists.
3. **Package:** platform signing, notarization, Android upload-key signing,
   SBOM, checksums, and provenance attestation.
4. **Installed smoke:** launch the exact signed artifact, connect to the
   environment, select a remote host, verify provider readiness, run one
   read-only session, resume it, and verify an attachment round trip.
5. **Internal distribution:** GitHub draft release, TestFlight internal group,
   Play Internal testing, and Windows certification ring.
6. **Promotion:** human approval promotes the same source revision and recorded
   evidence to the production channel. Store state and deployed backend SHA are
   reported separately.

Desktop CI should retain the raw executable test only as a diagnostic; release
acceptance uses the signed installer and verifies the installed executable
path. Mobile CI should use a simulator/emulator for deterministic flows and a
small physical-device matrix for keyboard, scrolling, file picking, audio,
background/resume, and unreliable-network behavior.

## Android readiness

The generated Android project already has the correct structural starting
point: `com.amplifier.studio`, minimum API 24, target API 36, cleartext disabled
for release, upload-key enforcement, and a workflow that builds and verifies a
signed AAB. It is **build-ready**, not yet Play-ready.

Required next gates:

- generate and protect the upload key, enable Play App Signing, and configure
  the four GitHub release secrets;
- make `versionCode` monotonic and add a Play service-account credential whose
  role is limited to the required application and release track;
- upload to Internal testing from CI and report the resulting release ID;
- complete Data safety, app access, microphone rationale, privacy policy,
  content rating, support metadata, icon, feature graphic, and screenshots;
- test edge-to-edge insets, system back, keyboard/composer, settings and chat
  scrolling, file chooser, microphone denial, lifecycle resume, and remote-host
  reconnection on physical phone and tablet form factors;
- give store reviewers a dedicated demo account and reachable demo host that do
  not require membership in a personal tailnet.

## Delivery slices and acceptance criteria

### Slice 0: remove current false blockers

- latest selected host wins every runtime-status refresh;
- a fresh Windows x64 executable launches and completes one read-only Spark
  turn without the provider setup card;
- the installed build reports its exact executable path and source revision.

### Slice 1: environment foundation

- typed development and production manifests land;
- dev and prod identities, storage, secrets, DNS/TLS, telemetry, and releases
  are isolated;
- CI rejects cross-environment audiences and production credentials in dev.

### Slice 2: provider registry

- runtime supports create/list/update/test/delete for multiple instances;
- one primary can be selected per capability, with explicit ordered fallbacks;
- Studio migration preserves the existing configured provider without exposing
  its key.

### Slice 3: workspace and Git foundation

- a user can create a cloud workspace, connect a repository, browse/edit files,
  and snapshot it without selecting a compute host;
- two parallel sessions receive distinct branches/worktrees and cannot write
  each other's checkout;
- diff, commit, pull request, conflict, and discard states are visible.

### Slice 4: managed Sparks

- a session obtains a short-lived compute lease against a workspace revision;
- stop/resume can move between compatible Sparks at a clean checkpoint;
- storage, Git, provider, and compute access are independently revocable and
  audit-visible.

### Slice 5: mobile and release automation

- Android passes the physical-device matrix and reaches Play Internal testing;
- TestFlight and Play tester/build states are queried in CI;
- every distributed build links to source, signatures, checksums, installed
  smoke evidence, backend environment, and store state.

## Explicit non-goals for the first implementation

- mounting one shared writable filesystem on every Spark;
- exposing S3 buckets as the product file manager;
- storing long-lived Git, storage, or model-provider secrets on a phone;
- treating Tailscale reachability as user identity or authorization;
- silently switching provider instances to keep a turn running;
- claiming a successful compile is a certified or published release.

## Primary implementation references

- [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri Google Play distribution](https://v2.tauri.app/distribute/google-play/)
- [Google Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [Upload an Android App Bundle](https://developer.android.com/studio/publish/upload-bundle)
- [GitHub App authorization and installation](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps)
- [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [S3 time-limited object transfers](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [App Store Connect API token generation](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
