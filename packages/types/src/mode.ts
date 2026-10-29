import { z } from "zod"

import { deprecatedToolGroups, toolGroupsSchema } from "./tool.js"

/**
 * GroupOptions
 */

export const groupOptionsSchema = z.object({
	fileRegex: z
		.string()
		.optional()
		.refine(
			(pattern) => {
				if (!pattern) {
					return true // Optional, so empty is valid.
				}

				try {
					new RegExp(pattern)
					return true
				} catch {
					return false
				}
			},
			{ message: "Invalid regular expression pattern" },
		),
	description: z.string().optional(),
})

export type GroupOptions = z.infer<typeof groupOptionsSchema>

/**
 * GroupEntry
 */

export const groupEntrySchema = z.union([toolGroupsSchema, z.tuple([toolGroupsSchema, groupOptionsSchema])])

export type GroupEntry = z.infer<typeof groupEntrySchema>

/**
 * ModeConfig
 */

/**
 * Checks if a group entry references a deprecated tool group.
 * Handles both string entries ("browser") and tuple entries (["browser", { ... }]).
 */
function isDeprecatedGroupEntry(entry: unknown): boolean {
	if (typeof entry === "string") {
		return deprecatedToolGroups.includes(entry)
	}
	if (Array.isArray(entry) && entry.length >= 1 && typeof entry[0] === "string") {
		return deprecatedToolGroups.includes(entry[0])
	}
	return false
}

/**
 * Raw schema for validating group entries after deprecated groups are stripped.
 */
const rawGroupEntryArraySchema = z.array(groupEntrySchema).refine(
	(groups) => {
		const seen = new Set()

		return groups.every((group) => {
			// For tuples, check the group name (first element).
			const groupName = Array.isArray(group) ? group[0] : group

			if (seen.has(groupName)) {
				return false
			}

			seen.add(groupName)
			return true
		})
	},
	{ message: "Duplicate groups are not allowed" },
)

/**
 * Schema for mode group entries. Preprocesses the input to strip deprecated
 * tool groups (e.g., "browser") before validation, ensuring backward compatibility
 * with older user configs.
 *
 * The type assertion to `z.ZodType<GroupEntry[], GroupEntry[]>` is
 * required because `z.preprocess` erases the input type to `unknown`, which
 * propagates through `modeConfigSchema → rooCodeSettingsSchema → createRunSchema`
 * and breaks `zodResolver` generic inference in downstream consumers.
 */
export const groupEntryArraySchema = z.preprocess((val) => {
	if (!Array.isArray(val)) return val
	return val.filter((entry) => !isDeprecatedGroupEntry(entry))
}, rawGroupEntryArraySchema) as z.ZodType<GroupEntry[], GroupEntry[]>

export const modeConfigSchema = z.object({
	slug: z.string().regex(/^[a-zA-Z0-9-]+$/, "Slug must contain only letters numbers and dashes"),
	name: z.string().min(1, "Name is required"),
	roleDefinition: z.string().min(1, "Role definition is required"),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
	groups: groupEntryArraySchema,
	source: z.enum(["global", "project"]).optional(),
	allowedMcpServers: z
		.array(z.string())
		.describe(
			"Optional list of MCP server names to include. When omitted, all servers are available. When set, only the listed servers are injected.",
		)
		.optional(),
})

export type ModeConfig = z.infer<typeof modeConfigSchema>

/**
 * CustomModesSettings
 */

export const customModesSettingsSchema = z.object({
	customModes: z.array(modeConfigSchema).refine(
		(modes) => {
			const slugs = new Set()

			return modes.every((mode) => {
				if (slugs.has(mode.slug)) {
					return false
				}

				slugs.add(mode.slug)
				return true
			})
		},
		{
			message: "Duplicate mode slugs are not allowed",
		},
	),
})

export type CustomModesSettings = z.infer<typeof customModesSettingsSchema>

/**
 * PromptComponent
 */

export const promptComponentSchema = z.object({
	roleDefinition: z.string().optional(),
	whenToUse: z.string().optional(),
	description: z.string().optional(),
	customInstructions: z.string().optional(),
})

export type PromptComponent = z.infer<typeof promptComponentSchema>

/**
 * CustomModePrompts
 */

export const customModePromptsSchema = z.record(z.string(), promptComponentSchema.optional())

export type CustomModePrompts = z.infer<typeof customModePromptsSchema>

/**
 * CustomSupportPrompts
 */

export const customSupportPromptsSchema = z.record(z.string(), z.string().optional())

export type CustomSupportPrompts = z.infer<typeof customSupportPromptsSchema>

/**
 * DEFAULT_MODES
 */

export const DEFAULT_MODES: readonly ModeConfig[] = [
	{
		slug: "architect",
		name: "🏗️ Architect",
		roleDefinition:
			"You are a software architect. Evaluate system boundaries, data flow, failure modes, and trade-offs grounded in the existing codebase.",
		whenToUse: "Plan system architecture, design interfaces, or write technical specifications in Markdown.",
		description: "Plan and design systems",
		customInstructions:
			"Verify existing interfaces and module boundaries before proposing architectural changes. Ask clarifying questions only when requirements are genuinely ambiguous.",
		groups: ["read", ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }], "mcp"],
	},
	{
		slug: "code",
		name: "💻 Code",
		roleDefinition:
			"You are a senior software engineer. Write clean, idiomatic code that conforms to existing project conventions, minimize diff surface area, and verify changes via build or test output.",
		whenToUse: "Write, modify, and refactor production code and tests.",
		description: "Write, modify, and refactor code",
		groups: ["read", "edit", "command", "mcp"],
	},
	{
		slug: "ask",
		name: "❓ Ask",
		roleDefinition:
			"You are a technical codebase analyst. Answer questions accurately and concisely by inspecting the repository, citing exact file paths and symbols.",
		whenToUse:
			"Explore the codebase, explain implementation details, or answer technical questions without modifying files.",
		description: "Explore code and get answers",
		groups: ["read", "mcp"],
	},
	{
		slug: "debug",
		name: "🐞 Debug",
		roleDefinition:
			"You are an expert systems and software debugger. Trace defects to their root cause using stack traces, symbol definitions, and reproduction tests, then apply minimal, targeted fixes.",
		whenToUse: "Diagnose errors, analyze logs or stack traces, and fix software defects.",
		description: "Diagnose and fix issues",
		groups: ["read", "edit", "command", "mcp"],
	},
	{
		slug: "orchestrator",
		name: "🧠 Orchestrator",
		roleDefinition:
			"You are a workflow orchestrator. Decompose complex objectives into isolated subtasks and delegate them to specialized modes via new_task.",
		whenToUse: "Coordinate complex, multi-step tasks across isolated child modes.",
		description: "Coordinate multi-step tasks",
		customInstructions:
			"Because you lack direct read/search tools and each new_task runs in an isolated context window, delegate an 'ask' or 'architect' discovery subtask first when file paths or symbols are unknown, then pass exact paths, symbols, and acceptance criteria to implementation subtasks.",
		groups: [],
	},
] as const
