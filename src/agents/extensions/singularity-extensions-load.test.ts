import { describe, expect, test } from "bun:test";
import { SINGULARITY_EXTENSION_FILENAMES } from "../../config/constants";
import { probeExtensionLoad, resolveSingularityExtensionCandidates } from "../../setup/extensions";

describe("singularity extension modules", () => {
	test("interrupt/replace/tasks singularity extensions import cleanly", async () => {
		const modules = await Promise.all([
			import("./interrupt-agent.ts"),
			import("./replace-agent.ts"),
			import("./tasks-singularity.ts"),
			import("./tasks-command.ts"),
		]);

		for (const mod of modules) {
			expect(typeof mod.default).toBe("function");
		}
	});

	test("every SINGULARITY_EXTENSION_FILENAMES entry resolves to a file with a callable default export", async () => {
		const { candidates } = resolveSingularityExtensionCandidates();
		expect(candidates).toHaveLength(SINGULARITY_EXTENSION_FILENAMES.length);

		// Every candidate must probe ok — same path tui.ts/pipe.ts gate on at startup.
		const probeResults = await Promise.all(
			candidates.map(async candidatePath => ({
				candidatePath,
				probe: await probeExtensionLoad(candidatePath),
			})),
		);

		const failures = probeResults.filter(r => !r.probe.ok);
		if (failures.length > 0) {
			const summary = failures.map(f => `${f.candidatePath}: ${f.probe.reason ?? "unknown"}`).join("\n  ");
			throw new Error(`Singularity extension probe failures:\n  ${summary}`);
		}
	});
});
