import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { $ } from "bun";

import { AGENT_EXTENSION_FILENAMES } from "../config/constants";
import { getSrcDir, probeExtensionLoad } from "../setup/extensions";

const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 3;

type CheckStatus = "pass" | "fail" | "warn";

export interface DoctorCheckResult {
	name: string;
	status: CheckStatus;
	detail?: string;
}

export interface DoctorOptions {
	/** Project root used to resolve replica mount root. Defaults to cwd. */
	projectRoot?: string;
	/** Override `~/.oms/` location for testing. */
	omsHome?: string;
	/** Stream to write per-check status into. Defaults to `process.stdout`. */
	out?: { write: (chunk: string) => void };
}

interface DoctorReport {
	results: DoctorCheckResult[];
	allPassed: boolean;
}

const ICON_PASS = "✓";
const ICON_FAIL = "✗";
const ICON_WARN = "!";

function formatLine(result: DoctorCheckResult): string {
	const icon = result.status === "pass" ? ICON_PASS : result.status === "fail" ? ICON_FAIL : ICON_WARN;
	const detail = result.detail ? ` — ${result.detail}` : "";
	return `${icon} ${result.name}${detail}\n`;
}

/**
 * Run every doctor check, write per-line status to `opts.out`, and return the
 * collected results. The caller decides how to exit; `runDoctorCli` exits 1 on
 * any FAIL.
 */
export async function runDoctorChecks(opts: DoctorOptions = {}): Promise<DoctorReport> {
	const out = opts.out ?? process.stdout;
	const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
	const omsHome = path.resolve(opts.omsHome ?? path.join(os.homedir(), ".oms"));

	const results: DoctorCheckResult[] = [];
	const record = (result: DoctorCheckResult): void => {
		results.push(result);
		out.write(formatLine(result));
	};

	record(await checkOmpBinary());
	record(await checkBunVersion());
	record(await checkOmsHomeWritable(omsHome));
	record(await checkReplicaRootWritable(projectRoot));
	record(await checkGit(projectRoot));
	const extensionResults = await checkExtensions();
	for (const result of extensionResults) record(result);

	const allPassed = results.every(r => r.status !== "fail");
	return { results, allPassed };
}

async function checkOmpBinary(): Promise<DoctorCheckResult> {
	const which = Bun.which("omp");
	if (which) {
		return { name: "omp binary in PATH", status: "pass", detail: which };
	}
	return {
		name: "omp binary in PATH",
		status: "fail",
		detail: "install omp and ensure it is on PATH",
	};
}

async function checkBunVersion(): Promise<DoctorCheckResult> {
	const v = Bun.version;
	const parts = v.split(".").map(p => Number.parseInt(p, 10));
	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	const ok = major > MIN_BUN_MAJOR || (major === MIN_BUN_MAJOR && minor >= MIN_BUN_MINOR);
	if (ok) {
		return { name: `bun >= ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}`, status: "pass", detail: v };
	}
	return {
		name: `bun >= ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}`,
		status: "fail",
		detail: `found ${v}; upgrade required`,
	};
}

async function checkOmsHomeWritable(omsHome: string): Promise<DoctorCheckResult> {
	const label = `~/.oms writable (${omsHome})`;
	try {
		await fs.mkdir(omsHome, { recursive: true });
		const probe = path.join(omsHome, `.doctor-probe-${process.pid}-${Date.now()}`);
		await fs.writeFile(probe, "doctor-probe", "utf8");
		await fs.unlink(probe);
		return { name: label, status: "pass" };
	} catch (err) {
		return {
			name: label,
			status: "fail",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

async function checkReplicaRootWritable(projectRoot: string): Promise<DoctorCheckResult> {
	const replicaRoot = path.join(projectRoot, ".oms", "replica");
	const label = `replica root writable (${replicaRoot})`;
	try {
		await fs.mkdir(replicaRoot, { recursive: true });
		const probe = path.join(replicaRoot, `.doctor-probe-${process.pid}-${Date.now()}`);
		await fs.writeFile(probe, "doctor-probe", "utf8");
		await fs.unlink(probe);
		return { name: label, status: "pass" };
	} catch (err) {
		return {
			name: label,
			status: "fail",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

async function checkGit(projectRoot: string): Promise<DoctorCheckResult> {
	const gitBin = Bun.which("git");
	if (!gitBin) {
		return { name: "git in PATH", status: "fail", detail: "install git" };
	}
	const inside = await $`git -C ${projectRoot} rev-parse --is-inside-work-tree`.quiet().nothrow();
	if (inside.exitCode !== 0) {
		return {
			name: "git repository at project root",
			status: "warn",
			detail: `${projectRoot} is not inside a git work tree`,
		};
	}
	return { name: "git in PATH + inside repo", status: "pass", detail: gitBin };
}

async function checkExtensions(): Promise<DoctorCheckResult[]> {
	const srcDir = getSrcDir();
	const extensionsDir = path.join(srcDir, "agents", "extensions");
	const filenames = Object.values(AGENT_EXTENSION_FILENAMES);
	const results: DoctorCheckResult[] = [];

	for (const filename of filenames) {
		const extPath = path.join(extensionsDir, filename);
		const label = `extension loads: ${filename}`;
		try {
			await fs.access(extPath);
		} catch {
			results.push({
				name: label,
				status: "fail",
				detail: `not found at ${extPath}`,
			});
			continue;
		}
		const probe = await probeExtensionLoad(extPath);
		if (probe.ok) {
			results.push({ name: label, status: "pass" });
		} else {
			results.push({ name: label, status: "fail", detail: probe.reason ?? "probe failed" });
		}
	}
	return results;
}

/**
 * CLI entry point. Prints per-check status and a summary, then exits 1 if any
 * check failed. Returns the exit code so tests can avoid `process.exit`.
 */
export async function runDoctorCli(opts: DoctorOptions = {}): Promise<number> {
	const out = opts.out ?? process.stdout;
	out.write("oms doctor\n");
	out.write("==========\n");
	const report = await runDoctorChecks(opts);

	const passed = report.results.filter(r => r.status === "pass").length;
	const warned = report.results.filter(r => r.status === "warn").length;
	const failed = report.results.filter(r => r.status === "fail").length;
	out.write("\n");
	out.write(`Summary: ${passed} passed, ${warned} warning, ${failed} failed\n`);

	return report.allPassed ? 0 : 1;
}
