# Plan: DeepSeek conversation switching through Chat Completions

Status: Part 1 and Part 2 implementation changes are present; Architect follow-up corrections and verification are in progress. Live server acceptance remains unverified.

## Goal and findings

Support switching between GPT, Google, and DeepSeek models within the same conversation, including tool-result continuations, without changing the task engine's public contracts or rewriting stored history.

- Protocol selection and history compatibility are separate concerns. Keep the shared Responses feature for OpenAI Compatible; remove only DeepSeek's opt-in integration.
- The current DeepSeek Chat Completions path already preserves plain reasoning and tool-call/result pairs through [`convertToR1Format()`](../src/api/transform/r1-format.ts:41), but omits the reasoning field when it is absent or empty and overwrites rather than accumulates multiple reasoning blocks.
- [`Task.buildCleanConversationHistory()`](../src/core/task/Task.ts:6119) can emit standalone OpenAI encrypted reasoning items. These are not ordinary role-bearing messages and must not become empty messages for other providers.
- [DeepSeek's current thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode) requires reasoning to be returned for **all previous turns when tools are supplied**, including turns without tool calls. The earlier explanation limiting the requirement to the active turn was too narrow.
- The documentation does **not** establish that an empty reasoning string is accepted for foreign history. The proposed empty-string compatibility fix must be verified against the endpoint; a mock alone cannot establish server acceptance.

## Part 1 — Remove DeepSeek Responses support

### 1. Remove provider-specific execution

- In [`deepseek.ts`](../src/api/providers/deepseek.ts), remove the Responses dispatch branch, adapter import, capability override, protocol-selection override, and Responses-only usage normalizer.
- Retain the native Chat Completions implementation, reasoning extraction, thinking controls, token limits, client configuration, caching metrics, model fetching, and Azure handling.
- Verify that inherited [`OpenAiHandler.completePrompt()`](../src/api/providers/openai.ts:425) cannot select Responses for DeepSeek after removal. The existing exact-class guard in [`OpenAiHandler.shouldUseResponses()`](../src/api/providers/openai.ts:347) should already provide this isolation; do not broaden it.

### 2. Remove selector eligibility without migrating profiles

- Remove DeepSeek from the eligibility list in [`common.ts`](../packages/types/src/provider-settings/common.ts:15). The generic selector in [`ApiOptions.tsx`](../webview-ui/src/components/settings/ApiOptions.tsx) should then disappear automatically for DeepSeek.
- Keep the shared protocol schema, translations, adapter, OpenAI Compatible dispatch, shared-base opt-in infrastructure, and independent transform bug fixes.
- Do not delete saved protocol preferences. For DeepSeek they become inert; switching back to an eligible provider can retain the existing preference. No bulk migration is needed.
- Update [`responses.md`](responses.md) to remove DeepSeek from active implementation scope and point to this plan for cross-provider continuity.

### 3. Regression coverage and acceptance

- Update schema/eligibility and UI tests to assert DeepSeek is ineligible and its selector is hidden, while OpenAI Compatible remains eligible.
- Replace DeepSeek Responses-specific tests with assertions that streaming and inherited single-prompt completion use Chat Completions even when an older profile retains the Responses preference.
- Keep coverage for malformed/foreign history where it protects the remaining shared Responses users; relocate a regression test if it currently depends on DeepSeek's removed branch.
- Acceptance: no DeepSeek execution path calls the Responses endpoint; existing Chat Completions behavior and OpenAI Compatible Responses behavior remain covered.

## Part 2 — Normalize history for DeepSeek Chat Completions

### 1. Reproduce the handoff and verify the endpoint contract

- Build focused regression fixtures for switching after a GPT/Google assistant tool call and returning its matching tool result, with no DeepSeek-compatible reasoning available.
- Include historical text-only assistant turns, completed tool sequences, and native DeepSeek turns with real reasoning. Cover mixed history, not just the last tool call.
- Capture the outgoing request in tests. Distinguish missing reasoning, explicit empty reasoning, readable reasoning, foreign signatures, and opaque encrypted state.
- An explicit standalone live contract check is available at [`scripts/deepseek-live-contract.mjs`](../scripts/deepseek-live-contract.mjs). It requires `DEEPSEEK_RUN_LIVE_CONTRACT=1`, an API key, and an explicitly configured HTTPS base URL. It was not run; empty-string acceptance remains unverified.
- If the server rejects empty strings, stop and revise this compatibility policy before claiming seamless thinking-mode handoff. Do not invent reasoning, retry automatically without thinking, or silently switch protocols.

### 2. Add explicit, request-local compatibility normalization

- Extend [`convertToR1Format()`](../src/api/transform/r1-format.ts:41) with a narrowly named, optional reasoning-field policy, enabled explicitly by [`DeepSeekHandler.createMessage()`](../src/api/providers/deepseek.ts:133) for applicable thinking requests with tools.
- Keep this policy separate from the existing text-merging option. Text placement and required reasoning-field presence are independent concerns.
- The current request-local `deepseek-thinking-tools` policy gives every outgoing assistant entry a string `reasoning_content` when a thinking request carries tools. It preserves actual readable/native reasoning and uses `""` only when no portable reasoning exists; it never turns opaque signatures or encrypted state into reasoning. This is a schema-shaped compatibility mitigation, not proof that the live endpoint accepts an empty value.
- Preserve native top-level reasoning and its explicit empty value. Otherwise accumulate readable reasoning blocks in original order rather than retaining only the last block. Support existing Zoo reasoning and Anthropic thinking representations with typed guards.
- Never overwrite real reasoning with an empty fallback, fabricate chain-of-thought, or treat encrypted payloads/signatures as readable reasoning. Preserve existing Unicode and tool-ID sanitization.
- Keep other callers' defaults unchanged, including LiteLLM, OpenCode Go, and MiMo. Do not use a shared behavior change to solve a DeepSeek-only requirement.

### 3. Keep foreign reasoning state at the correct boundary

- Audit the handoff through [`Task.buildCleanConversationHistory()`](../src/core/task/Task.ts:6119), [`apiMessages.ts`](../src/core/task-persistence/apiMessages.ts), and [`convertToR1Format()`](../src/api/transform/r1-format.ts:41).
- Filter unsupported standalone provider-state items at the receiving adapter boundary, while preserving all ordinary messages and tool pairs. Never turn a role-less encrypted item into a role-less empty message.
- A missing readable reasoning value is valid foreign history, not evidence of a malformed assistant message. Use the verified compatibility policy rather than requiring another provider's hidden state.
- Do not equate Google signatures, OpenAI encrypted state, or public reasoning summaries with authentic DeepSeek continuation state. Readable summaries may remain context, but must not be relabeled as recovered hidden reasoning.
- Avoid changing the task history builder unless a focused integration test proves it loses **actual native DeepSeek reasoning** before the handler receives it. If needed, make only a targeted request-projection correction; preserve stored history, OpenAI encrypted replay, and Google signatures. Do not use the generic reasoning-preservation flag as proof that encrypted state is portable.

### 4. Preserve tool execution and native controls

- Retain call/result IDs, ordering, assistant text, and tool outputs across the handoff. Never replay completed tools to manufacture a fresh DeepSeek turn.
- Retain environment-text merging, image handling, model-specific thinking/effort selection, token budgeting, and usage behavior. Cover explicit thinking-disabled mode separately.
- Keep normalization pure: no mutation of persisted messages, settings, or task lifecycle state; no global provider hierarchy refactor or new user setting.

### 5. Tests and verification

- Converter tests in [`r1-format.spec.ts`](../src/api/transform/__tests__/r1-format.spec.ts): missing/empty/present reasoning; all assistant entry shapes; multiple reasoning blocks; merged messages; Unicode; tool pairs; standalone foreign state; unchanged default behavior for other callers.
- Provider tests in [`deepseek.spec.ts`](../src/api/providers/__tests__/deepseek.spec.ts): GPT/Google-style history to DeepSeek; native DeepSeek reasoning returned on subsequent requests; historical non-tool assistant turns; thinking disabled; retained protocol preference ignored; no duplicate tools or history mutation.
- Added a focused `Task.buildCleanConversationHistory()`-to-converter boundary test for a foreign assistant tool-call/tool-result pair, genuine readable DeepSeek reasoning, and reverse GPT-format projection. Limitation: it does not instantiate `DeepSeekHandler` with the Task-built history. Provider request tests separately verify the serialized handler request, so the two boundaries are covered separately rather than by one end-to-end test.
- Use an extension-host smoke test only if the provider-switch/history-projection boundary cannot be represented reliably in a lower-layer integration test. Keep any live API contract test opt-in.
- Run affected types-package, settings UI, DeepSeek, converter, and shared-converter-consumer suites from their owning package directories. Run package typechecks and lint with suppression pruning for touched files; no suppression increases. Run the extension build and whitespace checks. Report any baseline failures separately.
- Do not add changesets, release-log edits, lint suppressions, or unrelated cleanup.

## Final Architect review and completion gates

- Review both parts together against this plan and the existing public provider/stream interfaces.
- Confirm DeepSeek Responses removal is complete without undoing shared OpenAI functionality.
- Unit tests cover foreign tool-call/result conversion and native reasoning on follow-up requests. This does not establish server acceptance of empty reasoning or seamless handoff.
- Do not mark live compatibility verified based solely on mocked tests. If credentials or a test endpoint are unavailable, report that acceptance gate as unverified.
- Live API contract was not run. Empty-string acceptance and seamless handoff remain unverified. Report the focused test results and remaining Task-to-DeepSeek integration limitation.
