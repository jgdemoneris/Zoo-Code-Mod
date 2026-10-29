import { getObjectiveSection } from "../objective"
import type { EffectiveToolPolicy } from "../../tools/effective-tool-policy"

describe("getObjectiveSection", () => {
	it("returns an empty string", () => {
		const policy: EffectiveToolPolicy = {
			tools: new Set<string>(),
			hasMcpGroup: false,
			hasMcpTools: false,
			hasMcpResources: false,
		}

		expect(getObjectiveSection(policy)).toBe("")
	})
})
