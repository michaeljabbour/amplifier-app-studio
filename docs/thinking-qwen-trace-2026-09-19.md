# Studio 0.1.79 response regressions and 0.1.80 fixes

Investigated against `d6658ea`, the 0.1.79 release source. The patch is prepared as 0.1.80, mobile build 68. This is a focused audit of thinking/answer rendering, stream reconciliation, completion, and related dependency checks, not a claim that every Studio feature has been audited.

## Confirmed defects

| Failure | Cause in 0.1.79 | Fix |
| --- | --- | --- |
| Thinking disclosure reopens and live answer flickers | Keyed Solid `Show` uses the immutable tail object, replaced on every delta; answer entrance animation restarts | Stable request/block identity; sampler scoped to that block |
| Old thinking briefly appears as answer text | Transcript-wide sampler retains the preceding block | Reset sampler at block boundaries; flush ended block text |
| Saved thinking controls remount during updates | Transcript `For` keys on mutable block objects; native toggle echoes allocate another object | Key rows by persistent block ID; redundant disclosure toggles are no-ops |
| Text disappears at stream end | `stream_block_end` clears the live tail before authoritative output arrives | Retain ended tail until reconciliation; preserve unmatched text as partial at empty completion or process exit |
| Empty completion silently returns to idle | Empty final text is ignored without recovery state | Show an accessible missing-answer card with follow-up draft and diagnostics actions |
| New response inherits old reasoning or disappears on another block's end | No request/index/type correlation | Correlate blocks and handle deltas with a missing start |
| Duplicate text after replay/retransmission | Stream sequence is ignored | Ignore duplicate or older sequenced deltas; retain reconciled block identity until turn/response boundary |
| Identical answer missing in a later turn | Final-answer deduplication searches the entire transcript | Restrict reconciliation to the current response after prompt/tool boundaries |
| Multi-block final answer shown twice | Joined completion text appended after separate durable text blocks | Consolidate matching blocks into the final answer |
| Commentary before a tool appears to satisfy an empty final completion | No final-response boundary | Require answer text after the last tool, including plan-only tools |

Durable text takes precedence over provisional stream text, including redacted replacements. Tool argument streams are not rendered as answers. Reasoning-only output is never relabeled as an answer. Interrupted/error turns keep their original status and are not silently retried. A follow-up is drafted for user review; completed tool actions are not automatically rerun.

## Qwen scope and remaining uncertainty

The report came from another machine; only Studio 0.1.79 was available. Its exact model/provider and session could not be inspected. No live Qwen request was sent, and this patch does not change provider configuration or token budgets.

Synthetic probes through the locally installed vLLM adapter reproduced reasoning-only responses converting to `text=None`, both for completed responses and incomplete responses with a token-limit reason. Reasoning plus a message/output_text block converted correctly. The inspected streaming orchestrator can end a no-tool iteration with empty extracted answer text; the provider can also return partial output when continuation fails or exhausts its cap. Those are possible upstream causes, not attribution of the remote report.

The client fixes cover the demonstrated data-loss and silent-empty-completion paths for all providers. If a provider never generates answer text, Studio now explains the missing answer and offers recovery; it cannot reconstruct text the provider did not send. Partial streamed text is held in the current view and available to diagnostics, not written back into the runtime's durable transcript. Historical sessions can only restore what the runtime persisted.

If the report recurs after the patch, useful diagnostics are the exact provider/model/revisions and a structural timeline of stream block IDs/types/sequences, durable content types/text lengths, provider status/incomplete reason/finish reason, and completion response lengths. Full prompts, reasoning, and credentials are not necessary for that first check.

## Validation

- Regression tests reproduce the pre-fix remount, stale sampler, lost stream, empty completion, cross-turn deduplication, and stream-correlation defects.
- Automated coverage includes redacted durable output, late/duplicate events, thinking-only responses, tool boundaries, repeated completion, process exit, interruption, and normal final answers.
- Browser fixture using the shipping Transcript component: continuous thinking stayed collapsed; partial text and the recovery card rendered correctly; the follow-up callback populated a draft. This was a browser component check, not a live-provider or packaged native-app acceptance test.
- Local verification: 403 frontend tests, 28 release-tooling tests, 119 Rust tests, production build, typecheck, release consistency, and Rust all-target check passed. npm audit reports zero vulnerabilities; cargo audit exits successfully with eight existing upstream maintenance/unsoundness warnings.
- Vitest 4.1.11 resolves GHSA-82fw-gwwq-j7x9. rustls 0.23.45 resolves RUSTSEC-2026-0285. Existing upstream Rust maintenance/unsoundness warnings are separate from vulnerability audit failures.

## Delivery

Prepared on `fix/thinking-qwen-trace`. No installed application, active runtime, provider module, or existing worktree was replaced. Publishing signed artifacts, installing them, and confirming behavior on the reporting machine remain distinct from the source fix.
