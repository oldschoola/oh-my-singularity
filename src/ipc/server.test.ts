import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { startOmsSingularityIpcServer, stringifyIpcResponse } from "./server";

/**
 * On Windows, AF_UNIX socket paths share the same length limits as on POSIX
 * (sun_path is 108 bytes). The OS tmp dir under a profile name can blow that
 * budget — use a short root.
 */
function makeShortTmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "oms-ipc-"));
}

async function connectAndSend(sockPath: string, payload: unknown): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const socket = net.createConnection(sockPath);
		let buf = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buf += chunk;
		});
		socket.on("end", () => resolve(buf.trim()));
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(`${typeof payload === "string" ? payload : JSON.stringify(payload)}\n`);
		});
	});
}

describe("stringifyIpcResponse", () => {
	test("returns 'ok' for undefined", () => {
		expect(stringifyIpcResponse(undefined)).toBe("ok");
	});

	test("returns 'ok' for empty string", () => {
		expect(stringifyIpcResponse("")).toBe("ok");
		expect(stringifyIpcResponse("   ")).toBe("ok");
	});

	test("returns the original string when non-empty", () => {
		expect(stringifyIpcResponse("hello")).toBe("hello");
	});

	test("returns JSON for object payload", () => {
		expect(stringifyIpcResponse({ ok: true, value: 1 })).toBe('{"ok":true,"value":1}');
	});
});

describe("startOmsSingularityIpcServer", () => {
	let tmpRoot: string;
	let sockPath: string;
	const teardown: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		tmpRoot = makeShortTmpRoot();
		sockPath = path.join(tmpRoot, "s.sock");
	});

	afterEach(async () => {
		while (teardown.length > 0) {
			const fn = teardown.pop();
			if (!fn) continue;
			try {
				await fn();
			} catch {
				// best-effort cleanup
			}
		}
		try {
			await fsp.rm(tmpRoot, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	test("binds successfully when no prior socket exists and routes onWake payload", async () => {
		const server = await startOmsSingularityIpcServer({
			sockPath,
			onWake: async payload => {
				return { ok: true, echo: payload };
			},
		});
		teardown.push(() => new Promise<void>(resolve => server.close(() => resolve())));

		const reply = await connectAndSend(sockPath, { hello: "world" });
		expect(reply).toBe('{"ok":true,"echo":{"hello":"world"}}');
	});

	test("clobbers a stale (no-listener) socket file and binds anyway", async () => {
		// Simulate a leftover socket file from a previous crashed session.
		fs.writeFileSync(sockPath, "");
		expect(fs.existsSync(sockPath)).toBe(true);

		const server = await startOmsSingularityIpcServer({
			sockPath,
			onWake: async () => "served",
		});
		teardown.push(() => new Promise<void>(resolve => server.close(() => resolve())));

		const reply = await connectAndSend(sockPath, "ping");
		expect(reply).toBe("served");
	});

	test("refuses to clobber a path that already has a live listener", async () => {
		// Stand up a real listener at the path so probeSocketIsLive sees a peer.
		// The handler echoes back the incoming line so we can verify the
		// incumbent is still serving after the rejected takeover attempt.
		const incumbent = await new Promise<net.Server>((resolve, reject) => {
			const s = net.createServer({ allowHalfOpen: true }, socket => {
				socket.setEncoding("utf8");
				let buf = "";
				socket.on("data", chunk => {
					buf += chunk;
					const idx = buf.indexOf("\n");
					if (idx >= 0) {
						socket.end(`incumbent:${buf.slice(0, idx)}\n`);
					}
				});
			});
			s.once("error", reject);
			s.listen(sockPath, () => resolve(s));
		});
		teardown.push(() => new Promise<void>(resolve => incumbent.close(() => resolve())));

		let thrown: unknown = null;
		try {
			await startOmsSingularityIpcServer({
				sockPath,
				onWake: async () => "should never run",
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("live listener");
		// Incumbent must still answer — guard the live peer, do not clobber it.
		const reply = await connectAndSend(sockPath, "ping");
		expect(reply).toBe("incumbent:ping");
	});

	test("preserves error rejection when the parent directory does not exist", async () => {
		// listen() to a path in a non-existent directory must fail. We assert
		// the function rejects rather than spinning forever in the retry loop.
		const badPath = path.join(tmpRoot, "nope", "child", "s.sock");

		let thrown: unknown = null;
		try {
			await startOmsSingularityIpcServer({
				sockPath: badPath,
				onWake: async () => "x",
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
	});
});
