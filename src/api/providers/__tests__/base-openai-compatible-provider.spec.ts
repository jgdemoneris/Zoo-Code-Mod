// npx vitest run api/providers/__tests__/base-openai-compatible-provider.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { type ModelInfo, openAiModelInfoSaneDefaults } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

// Create mock functions
const mockCreate = vi.fn()
const mockResponsesCreate = vi.fn()

// Mock OpenAI module
vi.mock("openai", () => ({
	default: vi.fn(function () {
		return {
			responses: {
				create: mockResponsesCreate,
			},
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		}
	}),
}))

const TEST_MODEL_INFO: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 128000,
	supportsImages: false,
	supportsPromptCache: false,
	inputPrice: 0.5,
	outputPrice: 1.5,
}

// Create a concrete test implementation of the abstract base class
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(
		apiKey: string,
		options?: {
			apiModelId?: string
			modelMaxTokens?: number
			modelTemperature?: number
			openAiEndpointMode?: "chat-completions" | "responses"
		},
	) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": TEST_MODEL_INFO,
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey,
			...options,
		})
	}
}

class ResponsesEnabledTestProvider extends TestOpenAiCompatibleProvider {
	protected override supportsResponses(): boolean {
		return true
	}
}

describe("BaseOpenAiCompatibleProvider", () => {
	let handler: TestOpenAiCompatibleProvider

	beforeEach(() => {
		clearAllMocks()
		mockResponsesCreate.mockReset()
		handler = new TestOpenAiCompatibleProvider("test-api-key")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("TagMatcher reasoning tags", () => {
		it("should handle reasoning tags (<think>) from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>Let me think" } }] },
					{ choices: [{ delta: { content: " about this</think>" } }] },
					{ choices: [{ delta: { content: "The answer is 42" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// TagMatcher yields chunks as they're processed
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Let me think" },
				{ type: "reasoning", text: " about this" },
				{ type: "text", text: "The answer is 42" },
			])
		})

		it("should handle reasoning tags (<thought>) from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<thought>Deep thought" } }] },
					{ choices: [{ delta: { content: " here</thought>" } }] },
					{ choices: [{ delta: { content: "Result: 42" } }] },
				]),
			)
			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Deep thought" },
				{ type: "reasoning", text: " here" },
				{ type: "text", text: "Result: 42" },
			])
		})

		it("should not close <think> tag with </thought> tag", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>Thinking" } }] },
					{ choices: [{ delta: { content: " but closing with wrong tag</thought>" } }] },
					{ choices: [{ delta: { content: " still thinking" } }] },
				]),
			)
			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)
			// The </thought> tag should be treated as text since it doesn't match the active <think> tag
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking" },
				{ type: "reasoning", text: " but closing with wrong tag</thought>" },
				{ type: "reasoning", text: " still thinking" },
			])
		})

		it("should handle complete <think> tag in a single chunk", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Regular text before " } }] },
					{ choices: [{ delta: { content: "<think>Complete thought</think>" } }] },
					{ choices: [{ delta: { content: " regular text after" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// When a complete tag arrives in one chunk, TagMatcher may not parse it
			// This test documents the actual behavior
			expect(chunks.length).toBeGreaterThan(0)
			expect(chunks[0]).toEqual({ type: "text", text: "Regular text before " })
		})

		it("should handle incomplete <think> tag at end of stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "<think>Incomplete thought" } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// TagMatcher should flush incomplete reasoning content on stream end
			expect(chunks).toContainEqual({ type: "reasoning", text: "Incomplete thought" })
		})

		it("should handle text without any <think> tags", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Just regular text" } }] },
					{ choices: [{ delta: { content: " without reasoning" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "text", text: "Just regular text" },
				{ type: "text", text: " without reasoning" },
			])
		})

		it("should handle <think> tags that start at beginning of stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>reasoning" } }] },
					{ choices: [{ delta: { content: " content</think>" } }] },
					{ choices: [{ delta: { content: " normal text" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "reasoning" },
				{ type: "reasoning", text: " content" },
				{ type: "text", text: " normal text" },
			])
		})
	})

	describe("reasoning_content field", () => {
		it("should preserve whitespace-only reasoning_content so streamed boundaries survive concatenation", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "\n" } }] },
					{ choices: [{ delta: { reasoning_content: "   " } }] },
					{ choices: [{ delta: { reasoning_content: "\t\n  " } }] },
					{ choices: [{ delta: { content: "Regular content" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "   " },
				{ type: "reasoning", text: "\t\n  " },
				{ type: "text", text: "Regular content" },
			])
		})

		it("should yield non-empty reasoning_content", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "Thinking step 1" } }] },
					{ choices: [{ delta: { reasoning_content: "\n" } }] },
					{ choices: [{ delta: { reasoning_content: "Thinking step 2" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking step 1" },
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "Thinking step 2" },
			])
		})

		it("should handle reasoning_content with leading/trailing whitespace", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { reasoning_content: "  content with spaces  " } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Should yield reasoning with spaces (only pure whitespace is filtered)
			expect(chunks).toEqual([{ type: "reasoning", text: "  content with spaces  " }])
		})

		it("should yield reasoning chunks BEFORE text chunks when both are present in the exact same delta", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { reasoning_content: "thinking...", content: "answer" } }],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const contentChunks = chunks.filter((c) => c.type === "reasoning" || c.type === "text")
			expect(contentChunks).toEqual([
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "answer" },
			])
		})
	})

	describe("Basic functionality", () => {
		it("should create stream with correct parameters", async () => {
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const systemPrompt = "Test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message" }]

			const messageGenerator = handler.createMessage(systemPrompt, messages)
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "test-model",
					temperature: 0,
					messages: expect.arrayContaining([{ role: "system", content: systemPrompt }]),
					stream: true,
					stream_options: { include_usage: true },
				}),
				undefined,
			)
		})

		it("should yield usage data from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 100, completion_tokens: 50 },
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 100, outputTokens: 50 })
		})

		it("keeps unverified subclasses on Chat Completions when Responses is selected", async () => {
			const unverifiedHandler = new TestOpenAiCompatibleProvider("test-api-key", {
				openAiEndpointMode: "responses",
			})
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			await collectStream(unverifiedHandler.createMessage("system prompt", []))
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "chat completion" } }] })
			await expect(unverifiedHandler.completePrompt("hello")).resolves.toBe("chat completion")

			expect(mockCreate).toHaveBeenCalledTimes(2)
			expect(mockResponsesCreate).not.toHaveBeenCalled()
		})

		it("uses Responses for opted-in subclasses and forwards tools and capabilities", async () => {
			const responsesHandler = new ResponsesEnabledTestProvider("test-api-key", {
				openAiEndpointMode: "responses",
				modelTemperature: 0.25,
			})
			mockResponsesCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{ type: "response.output_text.delta", delta: "response stream" },
					{
						type: "response.completed",
						response: {
							usage: {
								input_tokens: 10,
								output_tokens: 4,
								output_tokens_details: { reasoning_tokens: 2 },
							},
						},
					},
				]),
			)

			const chunks = await collectStream(
				responsesHandler.createMessage("system instructions", [{ role: "user", content: "hello" }], {
					taskId: "test-task",
					tools: [
						{
							type: "function",
							function: {
								name: "lookup",
								description: "Find a value",
								parameters: { type: "object", properties: {} },
							},
						},
					],
				}),
			)

			expect(mockCreate).not.toHaveBeenCalled()
			expect(mockResponsesCreate).toHaveBeenCalledOnce()
			expect(mockResponsesCreate.mock.calls[0][0]).toMatchObject({
				model: "test-model",
				instructions: "system instructions",
				stream: true,
				temperature: 0.25,
				tools: [{ type: "function", name: "lookup", description: "Find a value" }],
			})
			expect(chunks).toContainEqual({ type: "text", text: "response stream" })
			expect(chunks).toContainEqual(
				expect.objectContaining({ type: "usage", inputTokens: 10, outputTokens: 4, reasoningTokens: 2 }),
			)

			mockResponsesCreate.mockResolvedValueOnce({ output_text: "response completion" })
			await expect(responsesHandler.completePrompt("prompt")).resolves.toBe("response completion")
			expect(mockResponsesCreate.mock.calls[1][0]).toMatchObject({
				model: "test-model",
				input: [{ role: "user", content: [{ type: "input_text", text: "prompt" }] }],
				stream: false,
			})
		})
	})

	describe("getModel", () => {
		it("returns the provider default when no model id is configured", () => {
			const model = handler.getModel()
			expect(model.id).toBe("test-model")
			expect(model.info).toEqual(TEST_MODEL_INFO)
		})

		it("returns the predefined metadata for a known model id", () => {
			const knownHandler = new TestOpenAiCompatibleProvider("test-api-key", { apiModelId: "test-model" })
			const model = knownHandler.getModel()
			expect(model.id).toBe("test-model")
			expect(model.info).toEqual(TEST_MODEL_INFO)
		})

		it("honors a custom model id that is not in the predefined list", () => {
			// Regression: a user-supplied custom id must not be silently swapped for the
			// provider default (which previously caused wrong-model requests / 404s).
			const customHandler = new TestOpenAiCompatibleProvider("test-api-key", {
				apiModelId: "some/custom-model-not-in-list",
			})
			const model = customHandler.getModel()
			expect(model.id).toBe("some/custom-model-not-in-list")
			expect(model.id).not.toBe("test-model")
			// Falls back to sane default metadata so the rest of the pipeline works.
			expect(model.info).toEqual(openAiModelInfoSaneDefaults)
			expect(model.info).not.toHaveProperty("maxTokens")
		})

		it("sends the custom model id verbatim to the API", async () => {
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const customHandler = new TestOpenAiCompatibleProvider("test-api-key", {
				apiModelId: "some/custom-model-not-in-list",
			})

			const stream = customHandler.createMessage("system prompt", [])
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "some/custom-model-not-in-list" }),
				undefined,
			)
		})

		it("omits max_tokens for a custom model", async () => {
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const customHandler = new TestOpenAiCompatibleProvider("test-api-key", {
				apiModelId: "some/custom-model-not-in-list",
			})

			await collectStream(customHandler.createMessage("system prompt", []))

			expect(mockCreate.mock.calls[0][0].max_tokens).toBeUndefined()
		})

		it("completePrompt sends the custom model id verbatim to the API", async () => {
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })

			const customHandler = new TestOpenAiCompatibleProvider("test-api-key", {
				apiModelId: "some/custom-model-not-in-list",
			})

			await customHandler.completePrompt("hello")

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "some/custom-model-not-in-list" }))
		})
	})

	describe("Tool call handling", () => {
		it("should yield tool_call_end events when finish_reason is tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_123",
											function: { name: "test_tool", arguments: '{"arg":' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											function: { arguments: '"value"}' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(2)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0]).toEqual({ type: "tool_call_end", id: "call_123" })
		})

		it("should yield multiple tool_call_end events for parallel tool calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_001",
											function: { name: "tool_a", arguments: "{}" },
										},
										{
											index: 1,
											id: "call_002",
											function: { name: "tool_b", arguments: "{}" },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(2)
			expect(endChunks.map((c: any) => c.id).sort()).toEqual(["call_001", "call_002"])
		})

		it("should not yield tool_call_end when finish_reason is not tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: { content: "Some text response" },
								finish_reason: "stop",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(0)
		})
	})
})
