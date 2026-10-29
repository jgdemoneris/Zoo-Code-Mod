import type { SystemPromptSettings } from "../types"
import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"
import { getShell } from "../../../utils/shell"

/** Returns the shell-specific command chaining operator. */
export function getCommandChainOperator(): string {
	const shell = getShell().toLowerCase()
	return shell.includes("powershell") || shell.includes("pwsh") ? ";" : "&&"
}

/** Builds the RULES section of the system prompt. */
export function getRulesSection(
	_cwd: string,
	_settings: SystemPromptSettings | undefined,
	_policy: EffectiveToolPolicy,
): string {
	return `====

RULES

- All relative file paths resolve against the Current Working Directory defined in SYSTEM INFORMATION. Do not use ~ or $HOME in file paths.
- When executing CLI commands outside the workspace root, pass the target path via the \`cwd\` parameter rather than chaining \`cd\`.
- Inspect target files or symbol definitions before modifying unfamiliar code; do not guess file contents.
- Respond directly with technical substance; omit conversational filler at the start and end of messages.`
}
