# Design specification: Configurable Chat Completions and Responses API

**Project:** Zoo Code VS Code extension
**Architecture:** Shared Responses adapter with minimal provider-level integration
**Active selectable provider:** OpenAI Compatible
**Expansion:** Other eligible Chat Completions providers
**Status:** Revised implementation proposal

DeepSeek is no longer an active Responses provider target. Its Responses dispatch and selector eligibility were removed; cross-provider conversation continuity is handled separately in [the DeepSeek conversation switching plan](deepseek-conversation-switching.md).

---

## A. Executive summary

Introduce a user-selectable API Protocol setting for Zoo Code providers currently using OpenAI Chat Completions, permitting them to use either:

- **Chat Completions** — `/chat/completions`
- **Responses API** — `/responses`

The protocol path is resolved relative to the provider's existing configured base URL.

The implementation must prioritize:

1. Minimal changes to existing provider implementations.
2. No change to existing default behavior.
3. Maximum reuse of existing Responses API code.
4. No changes to Zoo Code's main `ApiHandler` or `ApiStream` contracts.
5. Compatibility with upstream `main` and straightforward future rebasing.
6. Gradual adoption across additional providers without repeated protocol implementation work.

**Primary design decision:** Introduce one shared Responses execution adapter, invoked through small conditional branches in existing handlers.

The existing Chat Completions request paths remain intact.

### Explicit non-goals

- Rewriting all Chat Completions providers.
- Consolidating all provider class hierarchies.
- Replacing OpenAI Native's Responses implementation.
- Changing OpenAI Native or xAI behavior.
- Replacing model-based automatic routing in OpenCode Go.
- Assuming every OpenAI-compatible backend supports Responses.
- Automatically switching protocols after API failures.
- Introducing server-managed conversation state in the initial implementation.

---

## B. Existing source architecture

Zoo Code already provides the necessary protocol-level building blocks.

### B1. Existing Responses components

| Existing source | Role |
|---|---|
| `src/api/providers/openai-native.ts` | Full OpenAI Native Responses implementation |
| `src/api/transform/responses-api-input.ts` | Shared conversion of internal messages into Responses input |
| `src/api/transform/responses-api-stream.ts` | Shared conversion of Responses stream events into `ApiStream` |
| `src/api/providers/opencode-go.ts` | Existing integration using the shared Responses transforms |
| `src/api/providers/xai.ts` | Additional provider-specific Responses reference |
| `src/api/providers/base-provider.ts` | Existing shared tool conversion support |

**Do not create duplicate message-conversion or streaming modules.**

The existing shared transforms should be the starting point.

OpenAI Native contains additional handling that is not yet shared. Reuse individual ideas or extract narrowly scoped helpers only when necessary.

### B2. Existing Chat Completions architectures

Zoo Code does not have one universal Chat Completions request executor.

| Architecture | Providers / examples | Integration strategy |
|---|---|---|
| `OpenAiHandler` | OpenAI Compatible, Moonshot, Kimi Code | One branch in the parent for inherited paths |
| `BaseOpenAiCompatibleProvider` | SambaNova, Fireworks, Baseten, Friendli | One branch in the shared base |
| `RouterProvider` subclasses | LiteLLM, Vercel AI Gateway and others | Small branches in concrete handlers |
| Custom OpenAI SDK handlers | DeepSeek, OpenRouter, Requesty, Kenari, etc. | Small explicit branches |
| Separate SDKs or mixed protocols | Mistral, Poe, OpenCode Go | Individual evaluation |

The existing `RouterProvider` holds a configured OpenAI client and model-resolution functionality, but does not implement a universal `createMessage()` method. Therefore, a single branch in that base class cannot automatically cover all router subclasses.

Providers that override inherited message creation must also be considered separately.

### B3. Target architecture

```text
                   Provider Settings
                          |
                    API Protocol
                          |
                Existing API Handler
                          |
             +------------+------------+
             |                         |
      Chat Completions             Responses API
             |                         |
      Existing request           Shared Responses
      implementation                 adapter
             |                         |
             |                 Existing input converter
             |                 Existing stream converter
             |                 Provider capability policy
             |                         |
             +------------+------------+
                          |
                   Existing ApiStream
                          |
                   Existing task engine
```

**The protocol switch occurs inside the provider boundary, not inside the task engine.**

---

## C. Provider scope and eligibility

### C1. Phase 1: guaranteed UI coverage

The active selectable integration target is:

- OpenAI Compatible

OpenAI Compatible exposes the API Protocol dropdown. DeepSeek's prior integration proposal is retained below as historical design context, but is no longer active scope.

Chat Completions remains the default.

### C2. Phase 2: additional Chat Completions providers

The shared adapter should be designed to accommodate the following candidates without requiring another protocol implementation.

**Shared OpenAI handler family**

- Moonshot
- Kimi Code

**Shared OpenAI-compatible base family**

- SambaNova
- Fireworks
- Baseten
- Friendli
- Other providers using that shared base, subject to compatible endpoint support

**Router and custom handler family**

- OpenRouter
- LiteLLM
- Requesty
- Unbound
- Vercel AI Gateway
- io.net Intelligence
- NanoGPT
- Zoo Gateway
- Kenari
- Qwen Code
- LM Studio
- MiMo
- Z.ai

Some of these have model-specific or provider-specific request handling that must be retained.

The list represents architectural candidates, not confirmed Responses compatibility for every service.

### C3. Providers that should remain unchanged initially

- OpenAI Native: already implements Responses.
- xAI: already implements Responses.
- OpenCode Go: already selects the appropriate wire protocol by model.
- Poe: uses provider-SDK routing.
- Anthropic-native and other non-OpenAI protocols: outside this feature's scope.
- Mistral and other separate-SDK providers: evaluate independently.

### C4. Capability registry

Introduce one lightweight registry that determines which providers may expose the protocol selector.

Suggested interface:

```typescript
type OpenAiEndpointMode =
  | "chat-completions"
  | "responses"

interface ProtocolSupport {
  selectable: boolean
  defaultMode: OpenAiEndpointMode
}
```

Initial configuration:

```typescript
const selectableProviders = new Set([
  providerIdentifiers.openai,
])
```

Export a shared eligibility predicate from the types package for both UI and extension-side use.

Do not use class inheritance or OpenAI SDK imports alone to determine eligibility.

For runtime request construction, keep a separate, focused provider capability policy describing optional Responses features such as reasoning parameters, token limits, streaming, and tool support.

When a provider is verified, enabling its dropdown should normally require only:

1. Adding it to the selector eligibility registry.
2. Adding a dispatch branch if its handler does not inherit one.
3. Defining provider-specific capabilities where needed.
4. Adding targeted tests.

---

## D. Settings schema and persistence

### D1. New setting

Use:

```typescript
type OpenAiEndpointMode =
  | "chat-completions"
  | "responses"
```

Persist:

```typescript
openAiEndpointMode?: OpenAiEndpointMode
```

Default resolution:

```typescript
const endpointMode =
  options.openAiEndpointMode ?? "chat-completions"
```

The setting must be optional to preserve older configurations.

### D2. Minimal-churn schema registration

The provider settings system already composes a shared base shape with provider-specific fields.

**Preferred minimal-churn option:** Register the optional protocol field once in:

`packages/types/src/provider-settings/common.ts`

within `baseProviderSettingsShape`.

This allows existing and future provider schemas to recognize the property without editing each provider-specific schema.

The tradeoff is that noneligible providers may carry an unused optional field. That is acceptable if:

- The UI hides the control for ineligible providers.
- Runtime eligibility checks prevent unsupported Responses routing.
- The field does not change how unrelated providers execute requests.

If upstream maintainers prefer stricter provider-specific schemas, the fallback is to create a reusable schema fragment and spread it only into selected provider definitions. That is more explicit but creates more provider-file changes.

### D3. Compatibility requirements

Verify that the setting survives:

- Profile creation.
- Profile save and reload.
- Named profile switching.
- Provider switching.
- Settings import/export.
- Extension restart.
- Webview-to-extension state synchronization.

The absence of the setting must always resolve to Chat Completions for the initially selected providers.

No bulk migration should be necessary.

### D4. Provider switching behavior

The selected protocol belongs to the existing API configuration profile.

If switching between two eligible providers, retain the selection.

If switching to an ineligible provider, hide the control and ignore its value. The unrelated provider must keep using its preexisting request implementation.

If a configuration selects Responses for an eligible provider whose backend rejects that protocol, surface the error. Do not silently downgrade it to Chat Completions.

---

## E. Settings UI

### E1. Main component

Modify:

`webview-ui/src/components/settings/ApiOptions.tsx`

Insert the selector directly below the existing API Provider control, before the provider-specific settings.

Illustrative layout:

```text
API Provider
[ OpenAI Compatible          v ]

API Protocol
[ Chat Completions           v ]

Base URL
[ https://example.com/v1      ]

API Key
[ ************************** ]

Model
[ model-name                 v ]
```

Dropdown options:

- `chat-completions` — Chat Completions
- `responses` — Responses API

Suggested test ID:

`api-protocol-select`

Use the existing Select components and settings translations.

### E2. Visibility rules

Show the control only when the current provider passes the shared capability predicate.

Initially:

| Provider | Selector |
|---|---|
| OpenAI Compatible | Visible |
| DeepSeek | Hidden (no longer eligible; see the [conversation switching plan](deepseek-conversation-switching.md)) |
| OpenAI Native | Hidden |
| xAI | Hidden |
| OpenCode Go | Hidden |
| Other providers | Hidden until enabled |

The component should automatically display the control for future providers when the registry is updated.

### E3. User guidance

Include brief explanatory text:

"The Responses API requires an endpoint and model that support `/responses`. Not all OpenAI-compatible providers support this protocol."

For providers with partially supported models, display a nonblocking warning when appropriate.

Do not change the selected model automatically.

### E4. Existing options

Preserve existing settings such as temperature, reasoning effort, token limits, base URL, strict tool schemas, and custom headers.

The Responses adapter decides which values are appropriate for the selected endpoint.

Do not rewrite provider-specific settings panels unless a particular field becomes misleading under Responses mode.

---

## F. Shared Responses adapter

### F1. New module

Create one thin execution module:

`src/api/providers/utils/openai-responses.ts`

Proposed responsibility:

- Build a Responses request using existing settings and model information.
- Reuse the configured OpenAI SDK client.
- Invoke `client.responses.create()`.
- Translate returned events into the existing `ApiStream`.
- Apply provider-specific request capabilities.
- Handle non-streaming single-prompt requests.

The adapter must not own API keys, persistent provider settings, global task state, or model catalogs.

### F2. Proposed interface

```typescript
interface ResponsesContext {
  client: OpenAI
  model: {
    id: string
    info: ModelInfo
  }
  options: ApiHandlerOptions
  systemPrompt: string
  messages: Anthropic.Messages.MessageParam[]
  metadata?: ApiHandlerCreateMessageMetadata
  requestOptions?: OpenAI.RequestOptions
  capabilities: ResponsesCapabilities
  normalizeUsage: (
    usage: unknown,
  ) => ApiStreamUsageChunk | undefined
}
```

Expose conceptually:

```typescript
createResponsesStream(context): ApiStream

completeResponsesPrompt(context): Promise<string>
```

The final signatures may be simplified after examining the existing model and cancellation utilities.

### F3. Client reuse

The shared executor accepts the caller's existing OpenAI SDK client.

Do not create a new client inside the adapter.

This preserves:

- Authentication.
- Provider base URL.
- API version configuration.
- Custom headers.
- Proxy configuration.
- Timeout.
- Request-specific options.

The standard SDK `responses.create()` call should provide the endpoint resolution.

Do not manually concatenate `/v1/responses`.

### F4. Request translation

Reuse:

`src/api/transform/responses-api-input.ts`

Map existing internal data to Responses fields:

| Internal value | Responses field |
|---|---|
| Model ID | `model` |
| System prompt | `instructions` |
| Conversation history | `input` |
| Output limit | `max_output_tokens` |
| Tools | `tools` |
| Tool choice | `tool_choice` |
| Reasoning settings | `reasoning`, when supported |
| Streaming | `stream` |
| Temperature | `temperature`, when supported |

The request builder must be protocol-aware.

Do not copy Chat Completions-only fields into Responses.

### F5. Reuse and harden input conversion

The existing converter already supports text messages, image inputs, function calls, and function outputs.

Before broad reuse, audit and test:

- Ordering of mixed assistant text and tool calls.
- Multiple function calls.
- Consistent function-call IDs and tool-result IDs.
- Previous assistant messages.
- Base64 image inputs.
- Tool-result content containing images or other nontext blocks.
- Empty content.
- Unicode sanitization.
- Reasoning-content preservation policy.

Some existing conversions can lose information, including nontext tool-result content. Improve these cases only where required for the supported protocol behavior.

Unsupported content must be handled explicitly rather than silently discarded.

Keep the existing converter's public API stable where possible to protect OpenCode Go.

### F6. Tools

Reuse `BaseProvider.convertToolsForOpenAI()` to obtain the established tool definitions, then convert Chat Completions tool objects into the Responses function-tool shape.

Flatten function properties:

```text
Chat:
{ type: "function", function: { name, parameters } }

Responses:
{ type: "function", name, parameters }
```

Preserve:

- Tool names.
- Descriptions.
- JSON schemas.
- Strict-mode preferences.
- MCP tool conventions.
- Tool-choice settings.
- Parallel tool invocation where supported.

Avoid introducing a second independent tool-schema normalization system.

---

## G. Streaming and execution behavior

### G1. Existing stream converter

Reuse:

`src/api/transform/responses-api-stream.ts`

The existing utility already processes:

- Text deltas.
- Reasoning deltas.
- Function-call events.
- Usage data.

Its public interface should remain stable.

### G2. Targeted improvements

Enhance the converter only where the current implementation is insufficient for shared provider use.

Required areas:

**Function-call tracking**

Track tool identity across output-item events and argument deltas.

Responses providers may emit argument deltas without repeating the function name or call ID in every event.

**Duplicate prevention**

Ensure a function call emitted incrementally is not emitted again when its final output item arrives.

**Terminal events**

Distinguish:

- `response.completed`
- `response.failed`
- `response.incomplete`

Propagate failures and incomplete generations appropriately.

**Usage**

Normalize token accounting and emit final usage once.

**Cancellation**

Respect the caller's abort signal throughout request creation and stream iteration.

**Event ordering**

Handle interleaved text, reasoning, and function-call events without corrupting message order.

### G3. No main task-engine changes

The adapter must yield the existing `ApiStreamChunk` variants.

In particular:

- `text`
- `reasoning`
- `tool_call_partial`
- `tool_call`
- `tool_call_end`
- `usage`

No new task-engine protocol should be needed.

### G4. Avoid copying OpenAI Native's retry behavior

The existing OpenAI Native implementation contains SDK and manual-SSE fallback paths.

Do not blindly replicate that pattern in the shared adapter.

A retry after a partially consumed response can duplicate generation or tool execution.

For the first implementation, prefer a single SDK request path with transparent failure reporting.

Introduce a transport fallback only if a specific compatibility requirement justifies it, and only when the original request is known not to have been processed.

### G5. Stateless conversation handling

Initially send complete relevant conversation history with each request.

Do not depend on:

- `previous_response_id`
- `conversation`
- Server-side response storage

This is particularly important for compatibility with providers that implement Responses but not OpenAI's stateful conversation features.

Model-specific encrypted reasoning continuation can be handled separately if a provider requires it.

---

## H. Provider integration

### H1. Common dispatch pattern

Add the protocol branch near the beginning of existing `createMessage()` methods.

Conceptually:

```typescript
if (this.options.openAiEndpointMode === "responses") {
  yield* createResponsesStream({
    client: this.client,
    model: this.getModel(),
    options: this.options,
    systemPrompt,
    messages,
    metadata,
    capabilities: this.responsesCapabilities,
    normalizeUsage: this.normalizeResponsesUsage,
  })
  return
}

// Existing Chat Completions implementation
// continues unchanged below.
```

This is illustrative rather than a copy-paste patch.

The branch must be guarded by the provider eligibility policy.

### H2. OpenAI Compatible

File:

`src/api/providers/openai.ts`

Add protocol dispatch to:

- `createMessage()`
- `completePrompt()`

Place the branch before the special o-series Chat Completions logic.

Reuse the already configured SDK client.

Do not refactor the existing streaming, non-streaming, R1-format, or o-series Chat Completions code as part of this feature.

For Azure-specific endpoint configurations, explicitly verify Responses support or reject the mode with a clear error.

### H3. DeepSeek

File:

`src/api/providers/deepseek.ts`

DeepSeek overrides `createMessage()`, so it requires its own branch.

Preserve the complete existing Chat Completions implementation.

For Responses:

- Reuse the client configured by the inherited constructor.
- Preserve DeepSeek authentication and base URL.
- Use DeepSeek's model metadata.
- Translate supported reasoning effort settings.
- Omit unsupported OpenAI-specific request fields.
- Use stateless conversation handling.
- Normalize DeepSeek usage and reasoning events.

DeepSeek inherits `completePrompt()` from `OpenAiHandler`, so verify that the parent's new protocol dispatch works with the transformed DeepSeek options.

### H4. Shared OpenAI-compatible base

File:

`src/api/providers/base-openai-compatible-provider.ts`

Introduce one optional Responses branch in `createMessage()` and `completePrompt()`.

This enables compatible subclasses that inherit these methods to reuse the adapter without additional provider-specific edits.

Subclasses with overrides must be tested individually.

The existing `createStream()` Chat Completions method should remain unchanged.

### H5. Router-based providers

The `RouterProvider` base holds the client and model-resolution infrastructure but does not provide a common message-generation implementation.

Do not restructure that hierarchy merely to support Responses.

Instead, add short dispatch branches to individual eligible subclasses such as LiteLLM.

Reuse the same shared adapter.

If a narrowly scoped helper method on `RouterProvider` reduces duplication without changing behavior, it may be added later, but it is not required for the initial feature.

### H6. Custom handlers

For providers such as OpenRouter or Requesty:

- Preserve custom request construction for Chat Completions.
- Invoke the shared Responses adapter only when selected.
- Pass appropriate model, headers, and capability policy.
- Do not assume Chat Completions-specific caching, reasoning, or routing parameters work in Responses mode.

Every custom integration should be a small addition rather than a rewrite.

---

## I. Provider-specific capability policy

Different Responses-compatible services may implement different subsets of OpenAI's protocol.

Represent these differences as explicit capabilities.

Suggested shape:

```typescript
interface ResponsesCapabilities {
  supportsStreaming: boolean
  supportsTools: boolean
  supportsParallelToolCalls?: boolean
  supportsReasoningEffort?: boolean
  supportsTemperature?: boolean
  supportsMaxOutputTokens?: boolean
  supportsStatefulResponses?: boolean
}
```

Only add options actually needed by implemented providers.

Avoid constructing an elaborate provider abstraction before the first two integrations are working.

### Model compatibility

A provider's endpoint may support Responses while an individual model does not.

The system should distinguish:

1. Provider supports Responses generally.
2. Selected model is documented as compatible.
3. Unknown custom model may be compatible through a proxy.

Prefer warnings for unknown models and actionable server errors over arbitrary rejection of user-configured custom models.

### Extra request fields

For OpenAI Compatible, retain existing custom extra-body functionality, but validate Responses-specific reserved fields.

Prevent user-supplied values from overriding:

- `model`
- `input`
- `instructions`
- `stream`
- `tools`
- `tool_choice`
- `max_output_tokens`
- Protocol-owned conversation state

Preserve existing prototype-pollution defenses.

---

## J. Error handling, telemetry, and usage

### J1. Error handling

Retain existing provider-specific error wrapping.

Recognize and report:

- Unsupported endpoint.
- Unsupported model.
- Unsupported request field.
- Authentication failure.
- Rate limiting.
- Timeout or cancellation.
- Stream termination failure.
- Incomplete output.

Never silently fall back from Responses to Chat Completions after a request failure.

### J2. Usage normalization

Map Responses token fields into the existing usage structure:

- `input_tokens` → `inputTokens`
- `output_tokens` → `outputTokens`
- `input_tokens_details.cached_tokens` → `cacheReadTokens`
- `output_tokens_details.reasoning_tokens` → `reasoningTokens`

Use the existing provider's model pricing logic wherever applicable.

Keep usage normalization injectable so gateways with unusual accounting can retain their own behavior.

### J3. Diagnostics

Record the selected provider and protocol in existing diagnostics where appropriate.

Avoid logging API keys, raw prompts, function results, or image data.

---

## K. Minimal file-change strategy

### K1. Essential changes for the first release

| File | Change |
|---|---|
| `packages/types/src/provider-settings/common.ts` | Add optional protocol field |
| Shared types exports / provider registry | Export protocol enum and eligibility check |
| `webview-ui/src/components/settings/ApiOptions.tsx` | Add conditional dropdown |
| Settings localization files | Add control labels and help text |
| `src/api/providers/utils/openai-responses.ts` | New shared adapter |
| `src/api/transform/responses-api-input.ts` | Targeted compatibility improvements |
| `src/api/transform/responses-api-stream.ts` | Targeted streaming robustness improvements |
| `src/api/providers/openai.ts` | Add Responses branches |
| `src/api/providers/deepseek.ts` | Add Responses branch |
| Associated test files | Add regression and protocol tests |

### K2. Subsequent integration changes

| File | Change |
|---|---|
| `src/api/providers/base-openai-compatible-provider.ts` | Shared opt-in dispatch |
| `src/api/providers/lite-llm.ts` | Thin Responses branch |
| `src/api/providers/openrouter.ts` | Thin Responses branch |
| Other eligible provider handlers | Thin integration when verified |

### K3. Files to avoid modifying unless necessary

- `src/api/providers/openai-native.ts`
- `src/api/providers/xai.ts`
- `src/api/providers/opencode-go.ts`
- `src/api/index.ts`
- `src/api/transform/stream.ts`
- Task execution and native tool parsing infrastructure.
- Existing provider model catalogs, except for necessary compatibility metadata.

Tests may need updating if existing shared transforms change behavior.

**Avoid broad provider hierarchy refactors, global SDK interception, and wholesale replacement of legacy request code.**

---

## L. Testing strategy

### L1. Backward compatibility

Verify:

- Older profiles default to Chat Completions.
- Existing requests continue using their old endpoints.
- New optional settings do not invalidate existing profiles.
- Existing provider constructors retain their behavior.
- OpenAI Native and xAI remain unchanged.
- OpenCode Go's automatic routing still works.

### L2. UI

Test:

- Protocol selector appears immediately below API Provider.
- The default option is Chat Completions.
- The selector appears only for eligible providers.
- Changes persist across saved profiles and restarts.
- Provider switching does not change unrelated provider behavior.
- Keyboard and screen-reader interactions work.
- Localization fallback behaves correctly.

### L3. Shared adapter

Unit-test:

- URL routing.
- Model and system instructions.
- Request parameter filtering.
- Image input.
- Assistant history.
- Multiple tool calls.
- Function-call outputs.
- Tool-call ID consistency.
- Strict function schemas.
- Non-streaming completion.
- Provider-specific capability restrictions.

### L4. Streaming

Test:

- Text deltas.
- Reasoning deltas.
- Interleaved tool calls.
- Argument fragments without repeated function names.
- Final function-call events.
- No duplicate tool execution.
- Final token usage.
- Incomplete responses.
- Failed responses.
- Cancellation during streaming.

### L5. Provider tests

For each integrated provider, test both protocol modes.

The Chat Completions assertions should remain unchanged.

For Responses, assert:

- The SDK invokes `responses.create()`.
- The correct model is sent.
- Existing client configuration is reused.
- Tool schemas use Responses format.
- Conversation history is correctly transformed.
- Usage and errors are normalized.
- Unsupported models or endpoints yield actionable errors.

### L6. Upstream compatibility

Run the project's existing:

- Type checking.
- Linting.
- Provider unit tests.
- Shared transform tests.
- Settings component tests.
- Extension build.
- Relevant integration tests.

Add one end-to-end test that performs a Responses function call, receives the tool result, and continues generation.

This is the most important functional acceptance test.

---

## M. Implementation and pull-request sequence

### PR 1 — Minimal settings and UI

Implement:

- Shared optional protocol setting.
- Provider eligibility predicate.
- Conditional dropdown.
- Localization.
- Persistence tests.

No network request changes.

**Result:** Backward-compatible protocol selection.

### PR 2 — Shared Responses adapter

Implement:

- Shared Responses request executor.
- Reuse of existing input and stream converters.
- Narrow fixes for tool-call tracking and terminal events.
- Usage normalization.
- Non-streaming completion.
- Unit tests.

Avoid changing OpenAI Native behavior.

**Result:** Independently tested reusable Responses execution.

### PR 3 — OpenAI Compatible and DeepSeek

Implement:

- Two provider-level dispatch paths.
- `completePrompt()` support through the OpenAI-compatible parent.
- DeepSeek-specific request capabilities.
- UI and protocol integration tests.
- Unsupported endpoint handling.

**Result:** The original user-facing feature is complete.

### PR 4 — Shared base-class integration

Implement:

- Minimal dispatch in `BaseOpenAiCompatibleProvider`.
- Tests for subclasses inheriting its methods.
- Eligibility for verified providers only.

Do not alter existing Chat Completions streaming behavior.

**Result:** Several compatible providers can be enabled with minimal individual changes.

### PR 5+ — Additional providers

Integrate supported routers and custom providers incrementally.

Start with OpenRouter and LiteLLM after verifying their Responses endpoint behavior.

For each provider:

1. Verify Responses compatibility.
2. Add the capability policy.
3. Add a thin dispatch branch where necessary.
4. Enable the protocol dropdown.
5. Add provider-specific integration tests.

**Result:** Gradual expansion without architectural churn.

---

## N. Acceptance criteria

### Functional

- [ ] The API Protocol selector appears below API Provider for supported providers.
- [ ] Chat Completions remains the default for existing and new configurations.
- [ ] Responses mode uses `responses.create()` with the configured base URL.
- [ ] Text and reasoning stream correctly.
- [ ] Function calls and tool results work across multiple turns.
- [ ] Tools are never executed twice due to duplicate events.
- [ ] Images and supported multimodal content are preserved.
- [ ] Usage and costs remain accurate.
- [ ] Unsupported endpoints fail clearly.
- [ ] Profile persistence works correctly.

### Architectural

- [ ] One shared Responses adapter is used by newly integrated providers.
- [ ] Existing input and stream transforms are reused.
- [ ] Existing Chat Completions request logic is retained.
- [ ] No new task-engine interface is introduced.
- [ ] No mass provider class refactor is required.
- [ ] Existing OpenAI Native behavior remains unchanged.
- [ ] New providers can opt in through small, testable integrations.

### Upstream maintenance

- [ ] Changes are predominantly additive.
- [ ] Existing handler methods retain their signatures.
- [ ] No public provider identifiers are renamed.
- [ ] Schema changes are backward-compatible.
- [ ] Existing provider tests pass.
- [ ] Each integration can be reviewed and rebased independently.

---

## O. Expected impact and risk

| Area | Expected impact | Risk |
|---|---|---|
| Provider settings | One optional field | Low |
| Settings UI | One conditional dropdown | Low |
| Existing Chat Completions | Existing paths preserved | Low |
| Shared Responses converter | Small, targeted improvements | Medium |
| Shared Responses adapter | New isolated module | Medium |
| DeepSeek integration | Small branch, provider-specific policy | Medium |
| Other provider integrations | Incremental | Medium |
| Task engine | No intended changes | Low |
| Upstream merge conflicts | Limited to a small number of touched files per PR | Low–medium |

The largest technical risk is incompatibility between different providers' Responses implementations, not the protocol-selection UI or provider dispatch.

The largest upstream-maintenance risk would arise from combining this feature with an unrelated refactor of the existing provider hierarchies. That should be explicitly avoided.

## Final architectural decision

**Implement one reusable Responses adapter, retain existing Chat Completions implementations, and add minimal opt-in dispatch at supported provider boundaries.**

The active selectable target is OpenAI Compatible. DeepSeek is no longer an active Responses provider target; cross-provider history continuity is handled in the [DeepSeek conversation switching plan](deepseek-conversation-switching.md). Additional providers should reuse the same adapter through a combination of shared base-class dispatch and narrow handler-specific branches.

The implementation should preserve Zoo Code's existing public interfaces, configuration compatibility, and task execution behavior.

This provides a scalable solution for eligible Chat Completions consumers while keeping the change set manageable and compatible with continued upstream development.
