import OpenAI from "openai"
import type { ModelInfo } from "@roo-code/types"
import type { ApiHandlerOptions } from "../../../../shared/api"
import { completeResponsesPrompt, createResponsesStream, type ResponsesContext } from "../openai-responses"

const modelInfo = {
	maxTokens: 512,
	supportsMaxTokens: true,
	supportsReasoningEffort: ["low", "high"],
	reasoningEffort: "low",
	supportsTemperature: true,
} as ModelInfo

function makeContext(create: ReturnType<typeof vi.fn>, overrides: Partial<ResponsesContext> = {}): ResponsesContext {
	// This structural test double implements only the SDK surface used by the adapter.
	const client = { responses: { create } } as unknown as OpenAI
	return {
		client,
		model: { id: "test-model", info: modelInfo },
		options: {
			includeMaxTokens: true,
			modelMaxTokens: 256,
			modelTemperature: 0.4,
			reasoningEffort: "high",
		} as ApiHandlerOptions,
		systemPrompt: "system instructions",
		messages: [{ role: "user", content: "hello" }],
		convertToolsForOpenAI: (tools) => tools,
		capabilities: {
			supportsStreaming: true,
			supportsTools: true,
			supportsParallelToolCalls: true,
			supportsReasoningEffort: true,
			supportsTemperature: true,
			supportsMaxOutputTokens: true,
		},
		normalizeUsage: () => undefined,
		...overrides,
	}
}

async function* responseEvents() {
	yield { type: "response.output_text.delta", delta: "streamed" }
	yield { type: "response.completed", response: {} }
}

describe("shared OpenAI Responses adapter", () => {
	it("routes through the configured SDK client with translated history and capabilities", async () => {
		const create = vi.fn().mockResolvedValue(responseEvents())
		const context = makeContext(create)
		const chunks = []
		for await (const chunk of createResponsesStream(context)) chunks.push(chunk)

		expect(chunks).toEqual([{ type: "text", text: "streamed" }])
		expect(create).toHaveBeenCalledOnce()
		const [request] = create.mock.calls[0]
		expect(request).toMatchObject({
			model: "test-model",
			instructions: "system instructions",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			stream: true,
			max_output_tokens: 256,
			temperature: 0.4,
			reasoning: { effort: "high" },
		})
	})

	it("omits non-positive max_output_tokens", async () => {
		const create = vi.fn().mockResolvedValue(responseEvents())
		const context = makeContext(create, {
			model: { id: "test-model", info: { ...modelInfo, maxTokens: -1 } },
			options: { includeMaxTokens: true } as ApiHandlerOptions,
		})
		for await (const _chunk of createResponsesStream(context)) {
			// Consume the request stream.
		}
		expect(create.mock.calls[0][0]).not.toHaveProperty("max_output_tokens")
	})

	it("uses resolved reasoning effort, respects disabling, and sanitizes instructions", async () => {
		const create = vi.fn().mockResolvedValue(responseEvents())
		const context = makeContext(create, {
			model: {
				id: "test-model",
				info: { ...modelInfo, supportsReasoningEffort: undefined },
				reasoningEffort: "high",
			},
			options: { includeMaxTokens: true, reasoningEffort: "low" } as ApiHandlerOptions,
			systemPrompt: "system \uD800 instructions",
		})
		for await (const _chunk of createResponsesStream(context)) {
			// Consume the request stream.
		}
		expect(create.mock.calls[0][0]).toMatchObject({
			instructions: "system � instructions",
			reasoning: { effort: "high" },
		})

		const disabledCreate = vi.fn().mockResolvedValue(responseEvents())
		const disabledContext = makeContext(disabledCreate, {
			options: { enableReasoningEffort: false, reasoningEffort: "high" } as ApiHandlerOptions,
		})
		for await (const _chunk of createResponsesStream(disabledContext)) {
			// Consume the request stream.
		}
		expect(disabledCreate.mock.calls[0][0]).not.toHaveProperty("reasoning")
	})

	it("flattens function tools, preserving schema descriptions and strict mode", async () => {
		const create = vi.fn().mockResolvedValue(responseEvents())
		const convertToolsForOpenAI = vi.fn(() => [
			{
				type: "function",
				function: { name: "lookup", description: "Find", parameters: { type: "object" }, strict: true },
			},
		])
		const context = makeContext(create, {
			metadata: {
				taskId: "task",
				tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
				tool_choice: { type: "function", function: { name: "lookup" } },
				parallelToolCalls: false,
			},
			convertToolsForOpenAI,
		})
		const chunks = []
		for await (const chunk of createResponsesStream(context)) chunks.push(chunk)
		expect(chunks).toEqual([{ type: "text", text: "streamed" }])
		expect(create.mock.calls[0][0]).toMatchObject({
			tools: [
				{ type: "function", name: "lookup", description: "Find", parameters: { type: "object" }, strict: true },
			],
			tool_choice: { type: "function", name: "lookup" },
			parallel_tool_calls: false,
		})
	})

	it("filters reserved and prototype-sensitive extra body keys", async () => {
		const create = vi.fn().mockResolvedValue(responseEvents())
		const extraBody = JSON.parse(
			'{"service_tier":"flex","model":"attacker","store":true,"__proto__":{"polluted":true}}',
		)
		const chunks = []
		for await (const chunk of createResponsesStream(makeContext(create, { extraBody }))) chunks.push(chunk)
		expect(chunks).toHaveLength(1)
		const request = create.mock.calls[0][0]
		expect(request.service_tier).toBe("flex")
		expect(request.model).toBe("test-model")
		expect(request.store).toBeUndefined()
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
	})

	it("omits unsupported capabilities and respects cancellation", async () => {
		const create = vi.fn().mockResolvedValue(responseEvents())
		const controller = new AbortController()
		controller.abort(new Error("cancelled"))
		const context = makeContext(create, {
			requestOptions: { signal: controller.signal },
			capabilities: {
				supportsStreaming: true,
				supportsTools: false,
				supportsTemperature: false,
				supportsMaxOutputTokens: false,
			},
		})
		const consume = async () => {
			const chunks = []
			for await (const chunk of createResponsesStream(context)) chunks.push(chunk)
			return chunks
		}
		await expect(consume()).rejects.toThrow("cancelled")
		expect(create).not.toHaveBeenCalled()
	})

	it("completes non-streaming prompts and honors abort options", async () => {
		const create = vi.fn().mockResolvedValue({ output_text: "answer" })
		const context = makeContext(create, {
			requestOptions: { headers: { "x-test": "yes" } },
		})
		expect(await completeResponsesPrompt(context)).toBe("answer")
		expect(create.mock.calls[0][0].stream).toBe(false)
		expect(create.mock.calls[0][1]).toMatchObject({ headers: { "x-test": "yes" } })
	})
})
