import { Anthropic } from "@anthropic-ai/sdk"
import { sanitizeIdentifierSurrogates, sanitizeSurrogates, sanitizeSurrogatesDeep } from "./sanitize-surrogates"

/**
 * Converts Anthropic-format messages to the OpenAI Responses API input format.
 *
 * Key differences from Chat Completions format:
 * - Content parts use { type: "input_text" } instead of { type: "text" }
 * - Images use { type: "input_image" } instead of { type: "image_url" }
 * - Tool results use { type: "function_call_output", call_id } instead of { role: "tool", tool_call_id }
 * - Tool uses become { type: "function_call", call_id, name, arguments } items
 * - System prompt goes via the `instructions` parameter, not as a message
 *
 * @param messages - Array of Anthropic MessageParam objects
 * @returns Array of Responses API input items
 */
export function convertToResponsesApiInput(messages: Anthropic.Messages.MessageParam[]): any[] {
	const input: any[] = []
	const text = (value: string) => sanitizeSurrogates(value)
	const imageContent = (part: any) =>
		part?.source?.type === "base64"
			? {
					type: "input_image",
					detail: "auto",
					image_url: `data:${part.source.media_type};base64,${part.source.data}`,
				}
			: undefined

	for (const message of messages) {
		if (typeof message.content === "string") {
			if (message.role === "assistant") {
				// Assistant messages use output_text in the Responses API format
				input.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: text(message.content) }],
				})
			} else {
				input.push({
					role: message.role,
					content: [{ type: "input_text", text: text(message.content) }],
				})
			}
			continue
		}

		if (!Array.isArray(message.content) || message.content.length === 0) {
			input.push({
				type: "message",
				role: message.role,
				content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: "" }],
			})
			continue
		}

		if (message.role === "assistant") {
			const assistantParts = message.content as Array<
				(typeof message.content)[number] | { type: "reasoning"; text: string }
			>
			for (const part of assistantParts) {
				switch (part.type) {
					case "text":
						input.push({
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: text(part.text) }],
						})
						break
					case "tool_use":
						input.push({
							type: "function_call",
							call_id: sanitizeIdentifierSurrogates(part.id),
							name: text(part.name),
							arguments:
								typeof part.input === "string"
									? text(part.input)
									: JSON.stringify(sanitizeSurrogatesDeep(part.input ?? {})),
						})
						break
					case "thinking":
						// Include reasoning if it has content
						if (part.thinking && part.thinking.trim().length > 0) {
							input.push({
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: `[Thinking] ${text(part.thinking)}` }],
							})
						}
						break
					case "reasoning":
						if (part.text && part.text.trim().length > 0) {
							input.push({
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: `[Thinking] ${text(part.text)}` }],
							})
						}
						break
				}
			}
		} else {
			// User messages
			const contentParts: any[] = []
			for (const part of message.content) {
				switch (part.type) {
					case "text":
						contentParts.push({ type: "input_text", text: text(part.text) })
						break
					case "image": {
						const image = imageContent(part)
						if (image) contentParts.push(image)
						break
					}
					case "tool_result": {
						// Flush any pending user content before the tool result
						if (contentParts.length > 0) {
							input.push({ role: "user", content: [...contentParts] })
							contentParts.length = 0
						}
						// Convert tool result content
						let output: string | unknown[]
						if (typeof part.content === "string") {
							output = text(part.content) || "(empty)"
						} else if (Array.isArray(part.content)) {
							const converted = part.content
								.map((block: any) => {
									if (block.type === "text") return { type: "input_text", text: text(block.text) }
									const image = imageContent(block)
									// Responses function outputs are text or multimodal content. Preserve
									// images as input_image blocks and serialize other block kinds explicitly.
									return (
										image ?? {
											type: "input_text",
											text: JSON.stringify(sanitizeSurrogatesDeep(block)),
										}
									)
								})
								.filter(Boolean)
							output =
								converted.length === 0
									? "(empty)"
									: converted.every(
												(block) =>
													typeof block === "object" &&
													block !== null &&
													block.type === "input_text",
										  )
										? converted.map((block) => (block as { text: string }).text).join("\n")
										: converted
						} else {
							output = "(empty)"
						}
						input.push({
							type: "function_call_output",
							call_id: sanitizeIdentifierSurrogates(part.tool_use_id),
							output,
						})
						break
					}
				}
			}
			// Flush remaining user content
			if (contentParts.length > 0) {
				input.push({ role: "user", content: contentParts })
			}
		}
	}

	return input
}
