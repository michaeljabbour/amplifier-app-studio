# Fast Decisions in Studio

Choose **Ways to start → Fast Decisions → Start with Fast Decisions**. Select
the project, compute host, and main provider/model, then start the session.
Studio launches the active `amplifier-bundle-fast-decisions` profile in a new
runtime. It does not alter the default composition or an existing session.

On that compute host, run Ollama and install the small local judge:

```sh
ollama pull qwen3:0.6b
```

For a remote session, Ollama must run on the remote host. A model downloaded on
the Studio client is not available to a different runtime host. Update the host
to runtime **0.1.11** or later; Studio's desktop runtime installer pins the
reviewed revision. Existing custom compositions are not combined automatically
with this separate execution profile.

The judge can select prepared, bounded read/list actions for explicitly named
workspace files. The upstream loop retains native tool permissions, execution,
steering, and cancellation. Your selected main model still reasons, edits, and
produces the answer. The active profile also requests low effort during early
exploration; it does not route to a different main model. Missing, uncertain,
or slow judge responses fall back to the main model. The judge uses the local
Ollama service, with external judge state sharing disabled.

This can avoid model turns during file exploration. It does not accelerate
every turn, and first launch can take longer while dependencies are prepared.
"Available on demand" describes bundle availability, not judge health or a
measured speedup. Fast-decisions telemetry records actual routed actions and
fallbacks; its CLI/Observatory can inspect those traces on the compute host.

The active profile and its root package/loop module are pinned. Foundation's
transitive dependencies and user-configured overlays are not a fully locked
environment. Explicit settings/module-source overrides retain precedence.

## Verification

The integration was exercised through `amplifier-runtime serve`, the same
process interface Studio uses, with Qwen as the main model and Ollama
`qwen3:0.6b` as the judge. A disposable README fixture returned its exact marker,
with one real fast action and one main-provider call. This establishes the
active runtime path; it is not a general coding-task speedup claim.

A [six-turn smoke comparison](fast-decisions-smoke-2026-09-21.json) used the
same task, main model, and profile, toggling only decision mode. All six answers
were correct. Two of three active runs used one main-model call instead of two;
one active run fell back. Median prompt-to-completion time was 26.2 seconds
active versus 27.1 seconds off; including startup, medians were 30.8 versus
32.8 seconds. One active run was slower than all controls. These small, variable
results do not establish a general speedup. The control retains the profile's
exploration effort settings and is not an unmodified default Studio session.

The integration also exposed and fixed two activation problems: an app overlay
could replace the selected loop, and the bundle could resolve an old namespace
registration or lack its wrapped loop on a fresh host. Regression tests cover
composition precedence, package dependencies, and the Studio launch contract.
An additional synthetic fixture exercised allow and deny hooks through the
actual installed upstream loop; denial prevented the prepared tool from running.
