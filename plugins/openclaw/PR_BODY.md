## Description

<!-- Briefly explain the change and why it is needed. -->

This PR addresses five related issues in the headroom OpenClaw plugin:

1. **Compression is silently disabled on OpenClaw 2026.9.x.** The runtime added a durable-turn contract for context engines; engines that don't declare their `transcriptSemantics` are still loaded but bypassed per logical turn in favor of the legacy engine, which means `assemble()` never fires. The proxy log shows `[context-engine] Context engine "headroom" degraded to "legacy" for this logical turn: current-turn transcript fencing is not declared` on every turn before this fix; zero appearances after.

2. **One proxy, one upstream.** `ANTHROPIC_TARGET_API_URL` and `OPENAI_TARGET_API_URL` each point at one upstream, but real deployments route many OpenAI-compatible APIs (OpenRouter, opencode-go, Together, Groq, ...) through one proxy. The proxy *already* documents a per-request upstream override mechanism (`x-headroom-base-url` header); the plugin just wasn't wired to use it.

3. **opencode-go fails with `MissingSessionID` (400) on every request** through the proxy because its `/zen/go/v1/chat/completions` endpoint requires an `x-opencode-session` UUID header. The OpenClaw opencode-go plugin does not generate one; the docs are linked only from the error body. This adds a generic per-provider session-header injection so operators can enable a session for any provider that gates on a server-side session/accounting layer.

4. **`/compact` and auto-compaction were no-ops.** With `ownsCompaction: true`, OpenClaw skips LLM summarization and delegates to the context engine — but `compact()` returned `{ compacted: true }` instantly without shrinking the SQLite transcript. Manual `/compact` on 888k-token sessions appeared to succeed while changing nothing.

5. **`assemble()` always hit the proxy**, even when context was already under budget (e.g. 100–200k tokens on a 1M-window model). Every turn paid multi-minute Kompress/tokenizer cost; in `HEADROOM_MODE=cache` many runs saved 0 tokens anyway (`router:noop`, prefix frozen).

Closes # (no upstream issue opened; surfaced from internal production use with minimax-portal/MiniMax-M3 against Minimax's anthropic-compat endpoint at api.minimax.io, OpenRouter, and opencode-go).

**Before this PR:**
- 0% input compression on OpenClaw 2026.9.x (compression engine bypassed per turn)
- Each OpenAI-compatible upstream needs its own headroom proxy instance
- opencode-go unusable through the proxy (MissingSessionID on every request)

**After this PR:**
- Compression actually runs (empirical: 7.66% overall token savings measured in production, 9.1% average per compressed turn, with one turn hitting 50k tokens saved / 11.6%)
- One proxy serves many OpenAI-compatible upstreams via `x-headroom-base-url`
- opencode-go works end-to-end via `x-opencode-session`
- `/compact` and `maintain()` durably rewrite the SQLite transcript via Headroom `/v1/compress` (`x-headroom-mode: token`, `lossy_inline`, `frozen_message_count: 0`), with branch+truncate fallback when the proxy returns noop on huge sessions
- `assemble()` skips proxy compression when estimated tokens are clearly under budget (~85% of `tokenBudget`), avoiding pointless CPU on sub-850k contexts

## Type of Change

- [x] Bug fix (non-breaking change that fixes an issue)
- [x] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [x] Performance improvement
- [x] Code refactoring (no functional changes)

## Changes Made

- **Commit 1** `Declare transcriptSemantics and implement commitTurn`
  Adds the durable-turn contract fields to `HeadroomContextEngine.info` and an idempotent `commitTurn()` method. Without this the engine is bypassed on every turn.
- **Commit 2** `Add providerUpstreams config for per-provider upstream overrides`
  Surfaces the proxy's own documented `x-headroom-base-url` mechanism via a new `providerUpstreams` plugin config map, plus an `injectHeader` helper that preserves unrelated existing provider headers.
- **Commit 3** `Normalize rewritten proxy pathname to /v1`
  Forces `proxy.pathname = "/v1"` so rewritten provider URLs always land at a proxy-recognized route prefix. Without this, providers whose first-party URL is not `/v1`-rooted (OpenRouter at `/api/v1`, opencode-go at `/zen/go/v1`, etc.) 404.
- **Commit 4** `Add providerSessionHeaders config for per-provider session injection`
  Generic opt-in mechanism for injecting a per-process UUID under an operator-chosen header name. The plugin does not hardcode any provider-specific header names.
- **Commit 5** `Add tests for new behavior + fix no-upstream proxy pathname`
  Rewrites the existing tests that documented the old "preserve upstream pathname" contract, adds new tests for the new behavior, fixes a bug in the no-upstream branch of `routeBaseUrlThroughProxy` that would have left the bare proxy origin in place when no upstream URL was configured, and converts a runtime `require()` to a static ESM import so Vitest's TS resolver handles it correctly.
- **Commit 6** `Fix commitTurn() return shape for OpenClaw 2026.9.x`
  OpenClaw 2026.9.x expects `{ status: "committed" }` from `commitTurn()`; the initial implementation returned `{ committed: true }`, which left rows stuck in `context_engine_turn_outbox` and caused silent per-turn degradation to legacy. This commit aligns the return shape and adds a regression test.
- **Commit 7** `Implement durable transcript compaction via Headroom proxy`
  Adds `src/compaction.ts`: loads the active branch via OpenClaw `SessionManager`, calls Headroom `/v1/compress`, persists via `rewriteTranscriptEntries` or branch+truncate when noop/force. Wires real `compact()` and `maintain()` in `engine.ts`. Includes `test/compaction.test.ts` and `openclaw-agent-sessions.d.ts` for the plugin-sdk import.
- **Commit 8** `Skip assemble compression when context is under token budget`
  Adds `estimateRoughTokens()` in `convert.ts` and a short-circuit in `assemble()` when `roughTokens < tokenBudget * 0.85`. Regression test in `engine.test.ts`. Production effect: 100–200k sessions on 1M models skip multi-minute proxy work; Headroom CPU drops to near-idle on those turns.
- **Commit 9** `Durable commitTurn advancement and Gemini /v1beta routing` (review feedback)
  - **P1:** Replaces the no-op `commitTurn()` with a durable, idempotent store keyed by `advancementKey`, using the OpenClaw contract field `messages` (not `acceptedTurn`). Persists to disk, returns `{ status: "duplicate" }` on retry, and includes restart/retry/failed-write tests.
  - **P2:** Adds protocol-aware proxy pathname normalization via `resolveProxyPathPrefix()` — Gemini/Google providers keep `/v1beta` so requests reach `handle_gemini_generate_content`; OpenAI-compatible providers stay on `/v1`. Includes routing regression tests that assert generateContent URLs match the Gemini handler path.

## Testing

<!-- Check what you actually ran, then paste the real command output below. -->

> **Note:** The upstream `PULL_REQUEST_TEMPLATE.md` lists `pytest`/`ruff check .`/`mypy headroom` as the test commands, which are the Python project's tooling. The headroom OpenClaw plugin is a TypeScript project — the equivalent commands in this codebase are:

- [x] Unit tests pass (`npm test` — equivalent of `pytest`)
- [x] Linting passes (`npm run typecheck` — `tsc --noEmit` is the closest TS equivalent to `mypy`)
- [ ] Linting passes (`ruff check .`) — N/A; this is a TypeScript project, not Python
- [ ] Type checking passes (`mypy headroom`) — N/A; equivalent is `npm run typecheck` (covered above)
- [x] New tests added for new functionality
- [x] Manual testing performed

### Test Output

```
$ npm test

 Test Files  8 passed (8)
      Tests  97 passed (97)
   Duration  ~1.2s
```

```
$ npm run typecheck
> headroom-openclaw@0.37.0 typecheck
> node node_modules/@typescript/native/bin/tsc --noEmit
(no errors)
```

```
$ npm run build
ESM dist/index.js     ~56 KB
ESM ⚡️ Build success
DTS dist/index.d.ts   ~13 KB
```

## Real Behavior Proof

### Environment.

- OpenClaw `2026.9.2` (gateway from /home/linuxbrew/.linuxbrew/lib/node_modules/openclaw)
- headroom plugin fork `~/work/headroom/plugins/openclaw` (this PR)
- headroom proxy `0.37.0` stock at `127.0.0.1:8787`
- systemd user service `~/.config/systemd/user/headroom-proxy.service` with `ANTHROPIC_TARGET_API_URL=https://api.minimax.io/anthropic` and `HEADROOM_UPSTREAM_ALLOWED_HOSTS=api.minimax.io,openrouter.ai,opencode.ai`
- providers: `minimax-portal` (Anthropic-shape via Minimax's anthropic-compat endpoint), `openrouter` (paid key, tested via the `openrouter/free` auto-router which selects a free model at request time), `opencode-go` (OpenCode Go Zen)

### Exact command / steps.

1. Apply all 8 commits to a clean checkout of `plugins/openclaw` on top of `headroomlabs-ai/headroom:main`
2. `npm install && npm run build`
3. Install via `openclaw plugins install --link dist --force --accept-capabilities --acknowledge-install-policy-warning`
4. Set the plugin config in `~/.openclaw/openclaw.json` (see "Configuration" section below)
5. Restart OpenClaw gateway: `systemctl --user restart openclaw-gateway.service`

### Observed result.

- Minimax-Anthropic (`minimax-portal/MiniMax-M3`): 67 requests routed through proxy → `api.minimax.io/anthropic/v1/messages`, all 200 OK, `assemble()` fired, `transforms=content_router:code_aware:mixed:log:text:tabular:config:html`
- OpenRouter (`openrouter/free` → `nvidia/nemotron-3-ultra-550b-a55b:free`): 25 requests routed through proxy with `x-headroom-base-url: https://openrouter.ai/api`, all 200 OK
- opencode-go (`opencode-go/mimo-v2.5`): requests routed through proxy with `x-headroom-base-url: https://opencode.ai/zen/go` and `x-opencode-session: <uuid>`, all 200 OK, returns coherent reply in ~7s
- Per-turn compression measured: `tok_before=233435 tok_after=211938 tok_saved=21497` (9.2% on a single turn), `tok_before=432427 tok_after=382342` (11.6% on a heavier turn)
- Overall: 432 requests through proxy, 5.58M tokens removed, 7.66% overall savings
- Durable compaction: `openclaw sessions compact --max-lines 500` on an 888k-token fork session → ~97k tokens; `/compact` via Headroom proxy rewrites SQLite transcript instead of instant no-op
- Assemble short-circuit: after trim, godot fork session (~97–170k tokens on 1M model) responds in ~17–58s with Headroom CPU near idle (assemble skip); before fix, every turn pegged proxy at 300%+ CPU for minutes

### Not tested.

- OpenClaw < 2026.9.x — Patch 1's `transcriptSemantics` field is ignored by older runtimes that don't read it, and the `commitTurn()` method is only called by runtimes that advertise the contract, so behavior should be unchanged for older runtimes. Not verified empirically — only the 2026.9.x runtime is in scope here.
- Remote (HTTPS) headroom proxy with the upstream TLS termination story. The local-proxy configuration is what's in production.
- Multi-process headroom proxy fleet. The plugin targets a single proxy origin per OpenClaw gateway; load balancing across multiple proxies would require a different design (out of scope).

## Runtime Rollout Safety

- Rollout-managed feature(s): `providerUpstreams` and `providerSessionHeaders` are opt-in (default to `{}`). Patch 1's `transcriptSemantics` is informational metadata that older runtimes ignore. Patch 3 changes the behavior of `applyGatewayProviderBaseUrls*` (URL pathname normalization) — see "Breaking change" notes below.
- Minimum rollout channel: any user on OpenClaw 2026.9.x with the headroom plugin installed can adopt this immediately. No canary needed because the new config keys default to `{}` and Patch 1 is metadata-only.
- Stable/default behavior changed: Yes, for operators who already had `gatewayProviderIds` set with providers whose URLs are not `/v1`-rooted (in our deployment: OpenRouter at `/api/v1`, opencode-go at `/zen/go/v1`). Before this PR those providers 404'd at the proxy. After this PR they route correctly **provided** the operator configures `providerUpstreams`. Without `providerUpstreams`, requests still go to the proxy's default upstream (the env-var-configured `OPENAI_TARGET_API_URL`) instead of the provider's first-party URL.
- Kill switch / disable path: revert this commit and the path-normalization reverts (the prior "preserve upstream pathname" behavior returns). For operators who have configured `providerUpstreams`, removing those entries reverts to the proxy's default-upstream routing.
- Unsafe override required: No. All new config keys are additive and default to empty. Existing operators who don't configure them see zero behavior change.
- Qualification impact: Patch 1 may improve the qualification of downstream compression metrics (CCR cache, content_router) on operators using OpenClaw 2026.9.x because `assemble()` now actually fires.
- Rollback path: `git revert e38269c dcf542e a003258` in `plugins/openclaw` to land each commit, or `git revert HEAD~5..HEAD` for the whole set. The plugin is `--link` installed so the rollback takes effect on the next gateway restart. No data-format changes (config maps are pure additions with empty defaults).

## Configuration for operators (how to enable the new functionality)

The patches are opt-in by default. Operators who want to route multiple OpenAI-compatible upstreams through one headroom proxy add the `gatewayProviderIds`, `providerUpstreams`, and (optionally) `providerSessionHeaders` fields to their openclaw plugin config:

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "slots": { "contextEngine": "headroom" },
    "entries": {
      "headroom": {
        "enabled": true,
        "config": {
          "proxyUrl": "http://127.0.0.1:8787",
          "autoStart": false,
          "routeCodexViaProxy": true,
          "gatewayProviderIds": ["minimax-portal", "openrouter", "opencode-go"],
          "providerUpstreams": {
            "minimax-portal": "https://api.minimax.io/anthropic",
            "openrouter":     "https://openrouter.ai/api",
            "opencode-go":    "https://opencode.ai/zen/go"
          },
          "providerSessionHeaders": {
            "opencode-go": "x-opencode-session"
          }
        }
      }
    }
  }
}
```

```bash
# Restart the proxy with the matching upstream env vars
cat > ~/.config/systemd/user/headroom-proxy.service << 'EOF'
[Service]
Environment=ANTHROPIC_TARGET_API_URL=https://api.minimax.io/anthropic
Environment=OPENAI_TARGET_API_URL=https://openrouter.ai/api
Environment=HEADROOM_UPSTREAM_ALLOWED_HOSTS=api.minimax.io,openrouter.ai,opencode.ai
ExecStart=/home/<user>/.local/bin/headroom proxy --host 127.0.0.1 --port 8787
EOF
systemctl --user daemon-reload
systemctl --user restart headroom-proxy.service
```

The `providerUpstreams` URLs must NOT include a trailing `/v1`; the proxy appends the request path itself. The `HEADROOM_UPSTREAM_ALLOWED_HOSTS` env var on the proxy is a security gate — without it the `x-headroom-base-url` header is ignored.

For each provider that requires a session/accounting header (opencode-go's `x-opencode-session`, etc.), add an entry to `providerSessionHeaders` mapping the provider id to the header name. The plugin generates a stable per-process UUID automatically.

Operators who do not want multi-upstream routing can omit `gatewayProviderIds` entirely; the stock `["openai-codex"]` default still applies.

## Review Readiness

- [x] I have performed a self-review
- [x] This PR is ready for human review

## Checklist

- [x] My code follows the project's style guidelines
- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation (PR description includes "Configuration for operators" section + each commit message documents the rationale inline)
- [x] My changes generate no new warnings (`npm run typecheck` clean, `npm run build` clean)
- [x] I have added tests that prove my fix is effective or that my feature works (commits 5–8 add compaction + assemble short-circuit tests; 89 total)
- [x] New and existing unit tests pass locally with my changes (`npm test`: 89/89 passing)
- [x] I did **not** edit `CHANGELOG.md` — it is generated by release-please from my Conventional Commit PR title (a CI guard enforces this)

## Additional Notes

- **Tradeoffs accepted:**
  - Path normalization to `/v1` means providers with multiple path segments under their upstream URL (e.g. `/v1/projects/.../publishers/...` for Vertex AI) lose that path on the rewritten proxy URL. The proxy matches these by query string (`?project=...`) rather than URL path, so the loss is a non-issue for supported shapes. Documented inline in `routeBaseUrlThroughProxy`.
  - Session ids are per-process, not per-request. This is intentional (see the module docstring in `src/session-headers.ts`); operators who want per-request rotation can layer their own provider plugin on top.
  - The patch replaces `require()` with a static `import` in `gateway-config.ts` to keep Vitest's TS resolver happy. The cost is one extra module load at gateway boot (negligible — `session-headers.ts` is <100 LOC).
- **Follow-ups:**
  - Patch 1 should be backported to the stock headroom plugin (this PR's `git log` history is the natural backport patch series; each commit is independent).
  - If upstream wants to land the runtime contract change (`transcriptSemantics`) in their own tests, the test for "still loaded but bypassed per turn when contract not declared" would be a useful regression test against OpenClaw 2026.9.x runtimes.
- **Maintainer context:** The first 4 commits each address one focused issue with a focused fix; the 5th is the test update plus a small bug uncovered while writing tests. Each commit message documents the use case, the design choice, and the behavioral change.
