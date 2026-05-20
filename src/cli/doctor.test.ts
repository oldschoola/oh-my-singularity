import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runDoctorChecks, runDoctorCli } from "./doctor";

function newSink(): { write: (chunk: string) => void; text: string } {
	const sink: { write: (chunk: string) => void; text: string } = {
		write: () => {},
		text: "",
	};
	sink.write = (chunk: string) => {
		sink.text += chunk;
	};
	return sink;
}

async function makeTempDir(prefix: string): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("runDoctorChecks", () => {
	test("returns one result per declared check and includes every extension", async () => {
		const projectRoot = await makeTempDir("oms-doctor-project-");
		const omsHome = await makeTempDir("oms-doctor-home-");
		try {
			const out = newSink();
			const report = await runDoctorChecks({ projectRoot, omsHome, out });
			// 5 fixed checks + at least one extension check
			expect(report.results.length).toBeGreaterThanOrEqual(6);
			expect(out.text).toContain("bun >=");
			expect(out.text).toContain("~/.oms writable");
			expect(out.text).toContain("replica root writable");
			// Extensions: each rendered line has the filename in the name field.
			const extLines = report.results.filter(r => r.name.startsWith("extension loads:"));
			expect(extLines.length).toBeGreaterThan(5);
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true });
			await fs.rm(omsHome, { recursive: true, force: true });
		}
	});

	test("oms-home check passes against a writable temp dir", async () => {
		const omsHome = await makeTempDir("oms-doctor-home-");
		const projectRoot = await makeTempDir("oms-doctor-project-");
		try {
			const out = newSink();
			const report = await runDoctorChecks({ projectRoot, omsHome, out });
			const homeResult = report.results.find(r => r.name.startsWith("~/.oms writable"));
			expect(homeResult?.status).toBe("pass");
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true });
			await fs.rm(omsHome, { recursive: true, force: true });
		}
	});

	test("replica-root check passes against a writable project root", async () => {
		const projectRoot = await makeTempDir("oms-doctor-project-");
		const omsHome = await makeTempDir("oms-doctor-home-");
		try {
			const out = newSink();
			const report = await runDoctorChecks({ projectRoot, omsHome, out });
			const replicaResult = report.results.find(r => r.name.startsWith("replica root writable"));
			expect(replicaResult?.status).toBe("pass");
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true });
			await fs.rm(omsHome, { recursive: true, force: true });
		}
	});

	test("output lines start with status icon", async () => {
		const omsHome = await makeTempDir("oms-doctor-home-");
		const projectRoot = await makeTempDir("oms-doctor-project-");
		try {
			const out = newSink();
			await runDoctorChecks({ projectRoot, omsHome, out });
			for (const line of out.text.split("\n").filter(Boolean)) {
				expect(/^[✓✗!]/.test(line)).toBe(true);
			}
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true });
			await fs.rm(omsHome, { recursive: true, force: true });
		}
	});
});

describe("runDoctorCli", () => {
	test("emits header and summary footer", async () => {
		const omsHome = await makeTempDir("oms-doctor-home-");
		const projectRoot = await makeTempDir("oms-doctor-project-");
		try {
			const out = newSink();
			const code = await runDoctorCli({ projectRoot, omsHome, out });
			expect(typeof code).toBe("number");
			expect(out.text).toContain("oms doctor");
			expect(out.text).toContain("Summary:");
			expect(out.text).toMatch(/\d+ passed/);
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true });
			await fs.rm(omsHome, { recursive: true, force: true });
		}
	});

	test("exit code is 1 when ~/.oms is not writable", async () => {
		// Use a path inside a regular file so mkdir fails.
		const blocker = path.join(await makeTempDir("oms-doctor-blocker-"), "file");
		await fs.writeFile(blocker, "");
		const omsHome = path.join(blocker, "nested");
		const projectRoot = await makeTempDir("oms-doctor-project-");
		try {
			const out = newSink();
			const code = await runDoctorCli({ projectRoot, omsHome, out });
			expect(code).toBe(1);
			expect(out.text).toContain("✗");
		} finally {
			await fs.rm(path.dirname(blocker), { recursive: true, force: true });
			await fs.rm(projectRoot, { recursive: true, force: true });
		}
	});
});
