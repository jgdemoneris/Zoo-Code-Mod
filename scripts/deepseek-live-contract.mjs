// Explicit standalone integration check. This file is intentionally outside Vitest,
// whose setup disables network access for all tests.
if (process.env.DEEPSEEK_RUN_LIVE_CONTRACT !== "1") {
	throw new Error("Set DEEPSEEK_RUN_LIVE_CONTRACT=1 to run this live check.")
}

const apiKey = process.env.DEEPSEEK_API_KEY
const baseUrl = process.env.DEEPSEEK_BASE_URL
if (!apiKey || !baseUrl) {
	throw new Error("Set DEEPSEEK_API_KEY and an explicit DEEPSEEK_BASE_URL to run this live check.")
}

const parsedBaseUrl = new URL(baseUrl)
if (parsedBaseUrl.protocol !== "https:") {
	throw new Error("DEEPSEEK_BASE_URL must use HTTPS.")
}

const endpoint = new URL("chat/completions", `${parsedBaseUrl.toString().replace(/\/$/, "")}/`)
const model = process.env.DEEPSEEK_LIVE_CONTRACT_MODEL || "deepseek-v4-flash"
const body = {
	model,
	stream: false,
	thinking: { type: "enabled" },
	messages: [
		{ role: "user", content: "Begin a harmless fixture conversation." },
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "contract-noop-call",
					type: "function",
					function: { name: "contract_noop", arguments: "{}" },
				},
			],
			reasoning_content: "",
		},
		{ role: "tool", tool_call_id: "contract-noop-call", content: "No operation was performed." },
	],
	tools: [
		{
			type: "function",
			function: {
				name: "contract_noop",
				description: "Inert contract-test tool. This script never executes tools.",
				parameters: { type: "object", properties: {} },
			},
		},
	],
}

const response = await fetch(endpoint, {
	method: "POST",
	headers: {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	},
	body: JSON.stringify(body),
})

if (!response.ok) {
	// Do not print response content: providers can echo request details in errors.
	throw new Error(`DeepSeek live contract returned HTTP ${response.status}.`)
}

console.log(`DeepSeek live contract returned HTTP ${response.status}; response body and credentials were not logged.`)
