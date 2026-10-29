import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"

/** Builds the CAPABILITIES section of the system prompt. */
export function getCapabilitiesSection(policy: EffectiveToolPolicy): string {
	const mcpServersSection =
		policy.hasMcpGroup && (policy.hasMcpTools || policy.hasMcpResources)
			? "\n- You have access to MCP servers that may provide additional tools and/or resources for this mode."
			: ""

	return `====

CAPABILITIES

You have access to the tools explicitly provided in your active tool definitions for this mode.${mcpServersSection}`
}
