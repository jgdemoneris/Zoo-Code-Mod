import type { ApiStream, ApiStreamUsageChunk } from "./stream"

interface TrackedFunctionCall {
	id: string
	name?: string
	index: number
	streamed: boolean
	emitted: boolean
}

/**
 * Processes Responses API stream events and yields ApiStreamChunks.
 *
 * This is a shared utility for providers that use OpenAI's Responses API
 * (POST /v1/responses with stream: true). It handles the core event types:
 *
 * - Text deltas (response.output_text.delta)
 * - Reasoning deltas (response.reasoning_text.delta, response.reasoning_summary_text.delta)
 * - Tool/function calls (response.output_item.done with function_call type)
 * - Usage data (response.completed)
 *
 * Provider-specific concerns (WebSocket mode, SSE fallback, duplicate detection,
 * pending tool tracking) are intentionally left to individual providers.
 *
 * @param stream - AsyncIterable of Responses API stream events
 * @param normalizeUsage - Provider-specific function to normalize usage data into ApiStreamUsageChunk
 */
export async function* processResponsesApiStream(
	stream: AsyncIterable<any>,
	normalizeUsage: (usage: any) => ApiStreamUsageChunk | undefined,
): ApiStream {
	const callsById = new Map<string, TrackedFunctionCall>()
	const callsByIndex = new Map<number, TrackedFunctionCall>()
	let usageEmitted = false
	const getCall = (callId: unknown, itemId: unknown, index: unknown) => {
		const numericIndex = typeof index === "number" ? index : undefined
		const id = typeof callId === "string" && callId ? callId : typeof itemId === "string" ? itemId : undefined
		return (
			(id ? callsById.get(id) : undefined) ??
			(numericIndex !== undefined ? callsByIndex.get(numericIndex) : undefined)
		)
	}
	const argumentsString = (value: unknown): string =>
		typeof value === "string" ? value : value && typeof value === "object" ? JSON.stringify(value) : ""

	for await (const event of stream) {
		if (event?.type === "response.output_item.added") {
			const item = event.item
			if (item?.type === "function_call" || item?.type === "tool_call") {
				const id = item.call_id || item.tool_call_id || item.id
				if (typeof id === "string" && id.length > 0) {
					const index = typeof event.output_index === "number" ? event.output_index : (event.index ?? 0)
					const previous = callsById.get(id) ?? callsByIndex.get(index)
					const call = {
						id,
						name: item.name || item.function?.name || previous?.name,
						index,
						streamed: previous?.streamed ?? false,
						emitted: previous?.emitted ?? false,
					}
					callsById.set(id, call)
					if (typeof item.id === "string" && item.id !== id) callsById.set(item.id, call)
					callsByIndex.set(index, call)
				}
			}
			continue
		}
		// Text content deltas
		if (event?.type === "response.output_text.delta" || event?.type === "response.text.delta") {
			if (event?.delta) {
				yield { type: "text", text: event.delta }
			}
			continue
		}

		// Reasoning deltas
		if (
			event?.type === "response.reasoning_text.delta" ||
			event?.type === "response.reasoning.delta" ||
			event?.type === "response.reasoning_summary_text.delta" ||
			event?.type === "response.reasoning_summary.delta"
		) {
			if (event?.delta) {
				yield { type: "reasoning", text: event.delta }
			}
			continue
		}

		// Output item events — handle completed function calls and fallback text
		if (event?.type === "response.output_item.done") {
			const item = event?.item
			if (item?.type === "function_call" || item?.type === "tool_call") {
				const callId = item.call_id || item.tool_call_id || item.id
				const call = getCall(callId, item.id, event.output_index ?? event.index)
				const id = typeof callId === "string" && callId ? callId : call?.id
				const name = item.name || item.function?.name || call?.name
				const args = argumentsString(item.arguments ?? item.function?.arguments ?? item.input)

				if (typeof id === "string" && id.length > 0 && typeof name === "string" && name.length > 0) {
					const tracked: TrackedFunctionCall = call ?? {
						id,
						index: event.output_index ?? event.index ?? 0,
						streamed: false,
						emitted: false,
					}
					tracked.name = name
					callsById.set(id, tracked)
					// Deltas are consumed by NativeToolCallParser; final call chunks are
					// only needed when no arguments were streamed.
					if (!tracked.streamed && !tracked.emitted) {
						yield {
							type: "tool_call",
							id,
							name,
							arguments: args,
						}
						tracked.emitted = true
					}
				}
			}
			continue
		}

		// Function call argument deltas (for streaming tool calls)
		if (
			event?.type === "response.function_call_arguments.delta" ||
			event?.type === "response.tool_call_arguments.delta"
		) {
			const call = getCall(
				event.call_id || event.tool_call_id || event.id,
				event.item_id,
				event.output_index ?? event.index,
			)
			const callId = event.call_id || event.tool_call_id || event.id || call?.id
			const name = event.name || event.function_name || call?.name
			if (typeof callId === "string" && callId.length > 0) {
				const tracked: TrackedFunctionCall = call ?? {
					id: callId,
					index: event.index ?? 0,
					streamed: false,
					emitted: false,
				}
				tracked.name = typeof name === "string" ? name : tracked.name
				callsById.set(callId, tracked)
				callsByIndex.set(tracked.index, tracked)
				if (tracked.name) {
					tracked.streamed = true
					yield {
						type: "tool_call_partial",
						index: tracked.index,
						id: callId,
						name: tracked.name,
						arguments: typeof event.delta === "string" ? event.delta : "",
					}
				}
			}
			continue
		}

		if (
			event?.type === "response.function_call_arguments.done" ||
			event?.type === "response.tool_call_arguments.done"
		) {
			const call = getCall(event.call_id || event.tool_call_id, event.item_id, event.output_index ?? event.index)
			const callId = event.call_id || event.tool_call_id || call?.id
			const name = event.name || event.function_name || call?.name
			if (typeof callId === "string" && typeof name === "string" && name && !call?.streamed && !call?.emitted) {
				const tracked: TrackedFunctionCall = call ?? {
					id: callId,
					name,
					index: event.output_index ?? event.index ?? 0,
					streamed: false,
					emitted: false,
				}
				tracked.name = name
				tracked.emitted = true
				callsById.set(callId, tracked)
				callsByIndex.set(tracked.index, tracked)
				yield {
					type: "tool_call",
					id: callId,
					name,
					arguments: argumentsString(event.arguments ?? event.delta),
				}
			}
			continue
		}

		// Completion events — extract usage
		if (event?.type === "response.failed") {
			const error = event.response?.error ?? event.error
			throw new Error(error?.message ?? "Responses API generation failed")
		}
		if (event?.type === "response.incomplete") {
			const details = event.response?.incomplete_details
			throw new Error(
				details?.reason
					? `Responses API generation incomplete: ${details.reason}`
					: "Responses API generation incomplete",
			)
		}
		if (event?.type === "response.completed" || event?.type === "response.done") {
			if (usageEmitted) continue
			usageEmitted = true
			const usage = event?.response?.usage || event?.usage
			const usageData = normalizeUsage(usage)
			if (usageData) {
				yield usageData
			}
			continue
		}
	}
}

/**
 * Creates a standard usage normalizer for providers with per-token pricing.
 * Extracts input/output tokens, cache tokens, reasoning tokens, and computes cost.
 *
 * @param calculateCost - Optional function to compute total cost from token counts
 */
export function createUsageNormalizer(
	calculateCost?: (inputTokens: number, outputTokens: number, cacheReadTokens: number) => number,
): (usage: any) => ApiStreamUsageChunk | undefined {
	return (usage: any): ApiStreamUsageChunk | undefined => {
		if (!usage) return undefined

		const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details
		const cachedTokens = inputDetails?.cached_tokens ?? 0

		const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
		const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
		const cacheReadTokens = usage.cache_read_input_tokens ?? cachedTokens ?? 0
		const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0

		const reasoningTokens =
			typeof usage.output_tokens_details?.reasoning_tokens === "number"
				? usage.output_tokens_details.reasoning_tokens
				: undefined

		const totalCost = calculateCost ? calculateCost(inputTokens, outputTokens, cacheReadTokens) : undefined

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			...(typeof totalCost === "number" ? { totalCost } : {}),
		}
	}
}
