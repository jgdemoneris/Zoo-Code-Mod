import OpenAI from "openai"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo, ReasoningEffortExtended } from "@roo-code/types"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../../index"
import { convertToResponsesApiInput } from "../../transform/responses-api-input"
import { processResponsesApiStream } from "../../transform/responses-api-stream"
import { sanitizeSurrogates } from "../../transform/sanitize-surrogates"
import type { ApiStream, ApiStreamUsageChunk } from "../../transform/stream"

export interface ResponsesCapabilities {
	supportsStreaming: boolean
	supportsTools: boolean
	supportsParallelToolCalls?: boolean
	supportsReasoningEffort?: boolean
	supportsTemperature?: boolean
	supportsMaxOutputTokens?: boolean
	supportsStatefulResponses?: boolean
}

type ChatTool = {
	type: string
	function?: { name?: string; description?: string; parameters?: unknown; strict?: boolean }
}

export interface ResponsesContext {
	client: OpenAI
	model: { id: string; info: ModelInfo; reasoningEffort?: ReasoningEffortExtended }
	options: ApiHandlerOptions
	systemPrompt?: string
	messages?: Anthropic.Messages.MessageParam[]
	metadata?: ApiHandlerCreateMessageMetadata
	requestOptions?: OpenAI.RequestOptions
	completePromptOptions?: CompletePromptOptions
	capabilities: ResponsesCapabilities
	normalizeUsage: (usage: unknown) => ApiStreamUsageChunk | undefined
	/** Pass the provider's bound BaseProvider.convertToolsForOpenAI method. */
	convertToolsForOpenAI: (tools: ApiHandlerCreateMessageMetadata["tools"]) => unknown[] | undefined
	extraBody?: Record<string, unknown>
}

const RESERVED_FIELDS = new Set([
	"model",
	"input",
	"instructions",
	"stream",
	"tools",
	"tool_choice",
	"max_output_tokens",
	"previous_response_id",
	"conversation",
	"store",
])
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function getSignal(context: ResponsesContext): AbortSignal | undefined {
	const signals = [
		context.requestOptions?.signal,
		context.completePromptOptions?.abortSignal,
		context.metadata?.abortSignal,
	].filter((signal): signal is AbortSignal => signal !== undefined)
	return signals.length > 1 ? AbortSignal.any(signals) : signals[0]
}

function mergeExtraBody(extraBody?: Record<string, unknown>): Record<string, unknown> {
	const safe: Record<string, unknown> = Object.create(null)
	if (!extraBody) return safe
	for (const [key, value] of Object.entries(extraBody)) {
		if (!RESERVED_FIELDS.has(key) && !UNSAFE_KEYS.has(key)) safe[key] = cloneSafeValue(value)
	}
	return safe
}

function cloneSafeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneSafeValue)
	if (value && typeof value === "object") {
		const copy: Record<string, unknown> = Object.create(null)
		for (const [key, nested] of Object.entries(value)) {
			if (!UNSAFE_KEYS.has(key)) copy[key] = cloneSafeValue(nested)
		}
		return copy
	}
	return value
}

function isChatTool(tool: unknown): tool is ChatTool {
	if (!tool || typeof tool !== "object") return false
	const candidate = tool as { type?: unknown; function?: { name?: unknown } }
	return candidate.type === "function" && typeof candidate.function?.name === "string"
}

function flattenTools(context: ResponsesContext): Array<Record<string, unknown>> | undefined {
	if (!context.capabilities.supportsTools) return undefined
	const chatTools = context.convertToolsForOpenAI(context.metadata?.tools)
	const tools = (chatTools ?? []).filter(isChatTool).map((tool) => ({
		type: "function",
		name: tool.function?.name,
		description: tool.function?.description,
		parameters: tool.function?.parameters,
		strict: tool.function?.strict,
	}))
	return tools.length ? tools : undefined
}

function toolChoice(choice: ApiHandlerCreateMessageMetadata["tool_choice"]): unknown {
	if (typeof choice === "string") return choice
	if (choice?.type === "function") return { type: "function", name: choice.function.name }
	return choice
}

function buildRequest(context: ResponsesContext, stream: boolean): Record<string, unknown> {
	const { model, options, capabilities } = context
	const request: Record<string, unknown> = {
		...mergeExtraBody(context.extraBody),
		model: model.id,
		input: convertToResponsesApiInput(context.messages ?? []),
		stream,
	}
	if (context.systemPrompt !== undefined) request.instructions = sanitizeSurrogates(context.systemPrompt)
	const maxOutputTokens = options.includeMaxTokens
		? options.modelMaxTokens || model.info.maxTokens
		: model.info.maxTokens
	if (capabilities.supportsMaxOutputTokens && typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
		request.max_output_tokens = maxOutputTokens
	}
	if (
		capabilities.supportsTemperature &&
		model.info.supportsTemperature !== false &&
		typeof options.modelTemperature === "number"
	) {
		request.temperature = options.modelTemperature
	}
	if (capabilities.supportsReasoningEffort) {
		const effort =
			options.enableReasoningEffort === false || options.reasoningEffort === "disable"
				? undefined
				: (model.reasoningEffort ??
					(model.info.supportsReasoningEffort
						? (options.reasoningEffort ?? model.info.reasoningEffort)
						: undefined))
		if (effort) request.reasoning = { effort }
	}
	const tools = flattenTools(context)
	if (tools) {
		request.tools = tools
		request.tool_choice = toolChoice(context.metadata?.tool_choice) ?? "auto"
		if (capabilities.supportsParallelToolCalls !== false) {
			request.parallel_tool_calls = context.metadata?.parallelToolCalls ?? true
		}
	}
	return request
}

/** Execute a stateless Responses stream using the caller's configured SDK client. */
export async function* createResponsesStream(context: ResponsesContext): ApiStream {
	if (!context.capabilities.supportsStreaming) throw new Error("This Responses endpoint does not support streaming")
	const signal = getSignal(context)
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
	const requestOptions = { ...context.requestOptions, ...(signal ? { signal } : {}) }
	const request = buildRequest(context, true)
	const stream = (await context.client.responses.create(
		request as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
		requestOptions,
	)) as unknown as AsyncIterable<unknown>
	const iterator = stream[Symbol.asyncIterator]()
	try {
		yield* processResponsesApiStream({ [Symbol.asyncIterator]: () => iterator }, context.normalizeUsage)
	} finally {
		try {
			await iterator.return?.()
		} catch {
			// Cleanup failures must not mask a request, stream, or cancellation error.
		}
	}
}

/** Execute a single stateless Responses request and return its combined text output. */
export async function completeResponsesPrompt(context: ResponsesContext): Promise<string> {
	const signal = getSignal(context)
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
	const options = { ...context.requestOptions, ...(signal ? { signal } : {}) }
	const request = buildRequest(context, false)
	const response = await context.client.responses.create(
		request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
		options,
	)
	return response.output_text || ""
}
