import { addCustomInstructions } from "../sections/custom-instructions"
import { getCapabilitiesSection } from "../sections/capabilities"
import { getRulesSection, getCommandChainOperator } from "../sections/rules"
import { getSystemInfoSection } from "../sections/system-info"
import { getObjectiveSection } from "../sections/objective"
import { getToolUseGuidelinesSection } from "../sections/tool-use-guidelines"
import { getSkillsSection } from "../sections/skills"
import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"
import { resolveEffectiveToolPolicy } from "../tools/effective-tool-policy"
import type { GroupEntry, ModelInfo } from "@roo-code/types"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { SkillsManager } from "../../../services/skills/SkillsManager"
import type { SkillMetadata } from "../../../shared/skills"
import * as shellUtils from "../../../utils/shell"

// Mock os-name so getSystemInfoSection never spawns PowerShell on Windows (cold
// launches can exceed the CI test timeout). Matches the form used in
// sections/__tests__/system-info.spec.ts, but returns a constant since no test
// here asserts on the OS string itself.
vi.mock("os-name", () => ({
	default: vi.fn(() => "MockOS"),
}))

/**
 * Build an {@link EffectiveToolPolicy} for arbitrary mode groups. `mode` is the
 * custom-mode slug so the resolver derives everything from `groups` (never from
 * built-in names), which keeps assertions mode-neutral.
 */
function policyFor(
	groups: GroupEntry[],
	extra: Partial<{
		mcpHub: ReturnType<typeof makeMcpHub>
		disabledTools: string[]
		modelInfo: ModelInfo
		experiments: Record<string, boolean>
		todoListEnabled: boolean
		codeIndexManager: CodeIndexManager
		allowedMcpServers: string[]
	}> = {},
): EffectiveToolPolicy {
	return resolveEffectiveToolPolicy({
		mode: "p",
		customModes: [{ slug: "p", name: "Policy Under Test", roleDefinition: "", groups }],
		...extra,
	})
}

/** Minimal McpHub stub. `tools`/`resources` mirror the McpServer shape the resolver reads. */
function makeMcpHub(
	servers: Array<{
		name: string
		tools?: Array<{ name: string; description?: string; enabledForPrompt?: boolean }>
		resources?: Array<{ uri: string; name?: string }>
	}>,
) {
	return { getServers: () => servers }
}

/** Minimal SkillsManager stub returning a fixed skill list. */
function makeSkillsManager(n: number): Pick<SkillsManager, "getSkillsForMode"> {
	return {
		getSkillsForMode: () =>
			Array.from({ length: n }, (_, i): SkillMetadata => ({
				name: `skill-${i}`,
				description: `Skill ${i}`,
				path: `./skills/${i}`,
				source: "global",
			})),
	}
}

describe("addCustomInstructions", () => {
	it("adds vscode language to custom instructions", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
			{ language: "fr" },
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain('You should always speak and think in the "Français" (fr) language')
	})

	it("works without vscode language", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
		)

		expect(result).not.toContain("Language Preference:")
		expect(result).not.toContain("You should always speak and think in")
	})
})

describe("getCapabilitiesSection", () => {
	it("refers to active tool definitions without enumerating tools", () => {
		const result = getCapabilitiesSection(policyFor(["read", "edit", "command"]))

		expect(result).toContain("CAPABILITIES")
		expect(result).toContain("tools explicitly provided in your active tool definitions for this mode")
		expect(result).not.toContain("execute CLI commands")
		expect(result).not.toContain("read files")
	})

	it("uses the same tool-definition wording for a control-tools-only mode", () => {
		const result = getCapabilitiesSection(policyFor(["modes"]))

		expect(result).toContain("tools explicitly provided in your active tool definitions for this mode")
	})

	it("does not restate edit restrictions enforced by tools", () => {
		const result = getCapabilitiesSection(
			policyFor(["read", ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]]),
		)

		expect(result).not.toContain("only files matching")
	})

	it("keeps the edit-restriction suffix off the MCP bullet when MCP is active", () => {
		const result = getCapabilitiesSection(
			policyFor(["read", ["edit", { fileRegex: "\\.md$" }], "mcp"], {
				mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]),
			}),
		)

		expect(result).toContain("MCP servers")
		expect(result).not.toContain("only files matching")
	})

	it("omits the edit-restriction suffix without a fileRegex", () => {
		const result = getCapabilitiesSection(policyFor(["read", "edit"]))
		expect(result).not.toContain("only files matching")
	})

	it("omits the edit-restriction suffix when no edit tool is available", () => {
		const result = getCapabilitiesSection(
			policyFor([["edit", { fileRegex: "\\.md$" }]], { disabledTools: ["write_to_file", "apply_diff"] }),
		)
		expect(result).not.toContain("only files matching")
	})

	it("does not enumerate model-included tools", () => {
		const result = getCapabilitiesSection(
			policyFor([["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]], {
				disabledTools: ["write_to_file", "apply_diff"],
				modelInfo: { contextWindow: 128_000, supportsPromptCache: true, includedTools: ["edit"] },
			}),
		)

		expect(result).toContain("tools explicitly provided in your active tool definitions for this mode")
	})

	it("does not duplicate tool-specific usage guidance", () => {
		const withListFiles = getCapabilitiesSection(policyFor(["read"]))
		expect(withListFiles).not.toContain("you can use the list_files tool")

		const withoutListFiles = getCapabilitiesSection(policyFor(["command"]))
		expect(withoutListFiles).not.toContain("execute_command tool")
	})

	it("does not enumerate execute_command usage", () => {
		const withCmd = getCapabilitiesSection(policyFor(["command"]))
		expect(withCmd).not.toContain("You can use the execute_command tool")

		const withoutCmd = getCapabilitiesSection(policyFor(["read"]))
		expect(withoutCmd).not.toContain("You can use the execute_command tool")
	})

	it("emits the MCP bullet only when the mode has the mcp group AND effective MCP availability", () => {
		// mcp group, server with a prompt-enabled tool -> present
		const hasTools = getCapabilitiesSection(
			policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]) }),
		)
		expect(hasTools).toContain("MCP servers")

		// mcp group, server with no tools but a resource -> present via resources
		const hasResources = getCapabilitiesSection(
			policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s", resources: [{ uri: "x" }] }]) }),
		)
		expect(hasResources).toContain("MCP servers")

		// mcp group, empty server (no tools, no resources) -> absent
		const nothing = getCapabilitiesSection(policyFor(["mcp"], { mcpHub: makeMcpHub([{ name: "s" }]) }))
		expect(nothing).not.toContain("MCP servers")

		// no mcp group -> absent even with a working server
		const noGroup = getCapabilitiesSection(
			policyFor(["read"], { mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d" }] }]) }),
		)
		expect(noGroup).not.toContain("MCP servers")
	})

	it("omits the MCP bullet when every tool is enabledForPrompt:false and no resources exist", () => {
		const result = getCapabilitiesSection(
			policyFor(["mcp"], {
				mcpHub: makeMcpHub([{ name: "s", tools: [{ name: "t", description: "d", enabledForPrompt: false }] }]),
			}),
		)
		expect(result).not.toContain("MCP servers")
	})

	it("omits the MCP bullet when a disallowed server is the only one with tools/resources", () => {
		const result = getCapabilitiesSection(
			policyFor(["mcp"], {
				mcpHub: makeMcpHub([
					{ name: "allowed", tools: [] },
					{ name: "blocked", tools: [{ name: "t", description: "d" }], resources: [{ uri: "x" }] },
				]),
				allowedMcpServers: [],
			}),
		)
		expect(result).not.toContain("MCP servers")
	})

	it("includes the MCP bullet for an allowed server under an allowlist", () => {
		const result = getCapabilitiesSection(
			policyFor(["mcp"], {
				mcpHub: makeMcpHub([{ name: "allowed", tools: [{ name: "t", description: "d" }] }]),
				allowedMcpServers: ["allowed"],
			}),
		)
		expect(result).toContain("MCP servers")
	})
})

describe("getRulesSection", () => {
	const cwd = "/test/path"

	const settings = {
		todoListEnabled: true,
		useAgentRules: true,
		newTaskRequireTodos: false,
	}

	it("contains concise workspace invariants without duplicating the workspace path", () => {
		const result = getRulesSection(cwd, settings, policyFor(["read", "edit", "command"]))

		expect(result).toContain("RULES")
		expect(result).toContain("Current Working Directory defined in SYSTEM INFORMATION")
		expect(result).not.toContain(cwd)
		expect(result).toContain("pass the target path via the `cwd` parameter")
		expect(result).toContain("Inspect target files or symbol definitions")
		expect(result).toContain("Respond directly with technical substance")
	})
})

describe("getSystemInfoSection", () => {
	const cwd = "/some/real/path"

	it("keeps the header lines", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read", "edit", "command"]))
		expect(result).toContain("SYSTEM INFORMATION")
		expect(result).toContain("Operating System:")
		expect(result).toContain("Default Shell:")
		expect(result).toContain("Home Directory:")
		expect(result).toContain(`Current Workspace Directory: ${cwd}`)
	})

	it("contains no /test/path literal", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read", "edit", "command"]))
		expect(result).not.toContain("/test/path")
	})

	it("omits the terminal-cd sentence when execute_command is absent", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read"]))
		expect(result).not.toContain("New terminals will be created")
		expect(result).not.toContain("change directories in a terminal")
	})

	it("includes the terminal-cd sentence when execute_command is present", () => {
		const result = getSystemInfoSection(cwd, policyFor(["command"]))
		expect(result).toContain("New terminals will be created")
	})

	it("states the file-tree fact once and omits list_files guidance here", () => {
		const result = getSystemInfoSection(cwd, policyFor(["read"]))
		expect(result).toContain(
			"a recursive list of all filepaths in the current workspace directory will be included in environment_details",
		)
		// the list_files *guidance* belongs in CAPABILITIES, not SYSTEM INFORMATION
		expect(result).not.toContain("you can use the list_files tool")
	})
})

describe("getObjectiveSection", () => {
	it("returns an empty string", () => {
		expect(getObjectiveSection(policyFor(["read"]))).toBe("")
	})
})

describe("getToolUseGuidelinesSection", () => {
	it("includes the list_files example when list_files is available", () => {
		const result = getToolUseGuidelinesSection(policyFor(["read"]))
		expect(result).toContain(
			"For example using the list_files tool is more effective than running a command like `ls` in the terminal.",
		)
	})

	it("omits the list_files example when list_files is absent", () => {
		const result = getToolUseGuidelinesSection(policyFor(["command"]))
		expect(result).not.toContain("using the list_files tool is more effective")
	})
})

describe("getSkillsSection", () => {
	it("returns the skills XML when the skill tool is available", async () => {
		const result = await getSkillsSection(makeSkillsManager(2), "code", policyFor(["read", "edit", "command"]))
		expect(result).toContain("AVAILABLE SKILLS")
		expect(result).toContain("<name>skill-0</name>")
	})

	it("returns an empty string when the skill tool is disabled", async () => {
		const result = await getSkillsSection(
			makeSkillsManager(2),
			"code",
			policyFor(["read", "edit", "command"], { disabledTools: ["skill"] }),
		)
		expect(result).toBe("")
	})
})

describe("getCommandChainOperator", () => {
	it("returns && for bash shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for zsh shell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/zsh")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns ; for PowerShell", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		)
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns ; for PowerShell Core (pwsh)", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns && for cmd.exe", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for Git Bash on Windows", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("C:\\Program Files\\Git\\bin\\bash.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for WSL bash", () => {
		vi.spyOn(shellUtils, "getShell").mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})
})
