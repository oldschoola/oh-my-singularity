import fs from "node:fs";
import net from "node:net";
import { logger } from "../utils";

export function stringifyIpcResponse(value: unknown): string {
	if (value === undefined) return "ok";
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || "ok";
	}

	try {
		return JSON.stringify(value);
	} catch (err) {
		logger.debug("IPC: failed to stringify response payload; returning fallback 'ok'", { err });
		return "ok";
	}
}

type WakeHandler = (payload: unknown) => unknown | Promise<unknown>;

/** Backoff before each retry attempt, in milliseconds. Length defines max retries. */
const LISTEN_RETRY_BACKOFF_MS: readonly number[] = [50, 100, 200, 400];

/** Connect probe timeout when checking if a stale-looking socket is actually live. */
const LIVENESS_PROBE_TIMEOUT_MS = 250;

/**
 * Probe whether `sockPath` already has a live listener.
 *
 * On Windows/Bun, AF_UNIX socket files can linger on disk after the owning
 * process exits, so `fs.existsSync` alone is not a reliable "in use" signal.
 * We attempt a short non-blocking connect; success means a live peer owns
 * the path and clobbering it would break another session.
 */
async function probeSocketIsLive(sockPath: string): Promise<boolean> {
	return await new Promise<boolean>(resolve => {
		// Construct an unconnected Socket and wire every listener *before*
		// calling `.connect(path)`. On Bun/Windows the connect-error event
		// can fire synchronously inside `net.createConnection`, before any
		// handlers attached afterward — which Node treats as an unhandled
		// 'error' and re-throws at the top level. This shape avoids that.
		const socket = new net.Socket();

		let settled = false;
		const finish = (alive: boolean) => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch (err) {
				logger.debug("IPC: failed to destroy liveness-probe socket", { sockPath, err });
			}
			resolve(alive);
		};

		// Any successful pipeline activity proves a peer is on the other end,
		// even if it immediately closes the connection.
		socket.setTimeout(LIVENESS_PROBE_TIMEOUT_MS, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("data", () => finish(true));
		socket.once("end", () => finish(true));
		socket.once("error", err => {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			// Only treat canonical "no listener" / "no path" errors as proof
			// the path is stale. Anything else (ECONNRESET, EPIPE, etc.) means
			// a peer was there long enough to react — treat as alive.
			const looksDead = code === "ECONNREFUSED" || code === "ENOENT";
			finish(!looksDead);
		});

		try {
			socket.connect(sockPath);
		} catch (err) {
			// Belt-and-braces: if `.connect()` still manages to throw before
			// the 'error' event can fire, treat ENOENT/ECONNREFUSED as dead.
			const code = (err as NodeJS.ErrnoException).code ?? "";
			const looksDead = code === "ECONNREFUSED" || code === "ENOENT";
			logger.debug("IPC: liveness-probe connect threw synchronously", {
				sockPath,
				code,
				looksDead,
			});
			finish(!looksDead);
		}
	});
}

function attachConnectionHandler(server: net.Server, onWake: WakeHandler): void {
	server.on("connection", socket => {
		let buf = "";
		let handled = false;
		socket.setEncoding("utf8");
		const flushLine = async (rawLine: string) => {
			if (handled) return;
			handled = true;
			const line = rawLine.trim();
			let responsePayload: unknown;
			if (line) {
				let payload: unknown = line;
				try {
					payload = JSON.parse(line);
				} catch (err) {
					logger.debug("IPC: incoming payload was not JSON; using raw line", { err });
				}

				try {
					responsePayload = await onWake(payload);
				} catch (err) {
					logger.warn("IPC: wake handler failed; returning error payload", { err });
					responsePayload = { ok: false, error: "ipc handler failed" };
				}
			}
			const responseLine = stringifyIpcResponse(responsePayload);
			try {
				socket.end(`${responseLine}\n`);
			} catch (err) {
				logger.debug("IPC: failed to send response; socket likely closed", { err });
			}
		};
		socket.on("data", chunk => {
			if (handled) return;
			buf += chunk;
			const idx = buf.indexOf("\n");
			if (idx >= 0) {
				const line = buf.slice(0, idx);
				void flushLine(line);
			}
		});

		socket.on("end", () => {
			if (handled) return;
			void flushLine(buf);
		});
		socket.on("error", err => {
			logger.debug("IPC: socket error while handling request", { err });
		});
	});
}

/**
 * Attempt one bind. Resolves with the bound server on success.
 *
 * The server is created fresh each call so that a failed bind never leaves a
 * half-initialized server lying around — Node lets you re-listen after an
 * error, but Bun's behavior is less stable and a clean instance is cheap.
 */
async function bindOnce(sockPath: string, onWake: WakeHandler): Promise<net.Server> {
	return await new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer({ allowHalfOpen: true });
		attachConnectionHandler(server, onWake);

		const onError = (err: Error) => {
			server.removeListener("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			server.removeListener("error", onError);
			resolve(server);
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(sockPath);
	});
}

export async function startOmsSingularityIpcServer(opts: {
	sockPath: string;
	onWake: WakeHandler;
}): Promise<net.Server> {
	const sockPath = opts.sockPath;

	// Fail fast if the path already belongs to a live peer — clobbering it
	// would silently break the other session.
	//
	// Note: we cannot gate on `fs.existsSync(sockPath)` here. On Windows +
	// Bun, `stat()` on a live AF_UNIX socket file fails with EACCES, which
	// makes `existsSync` return false even though a peer is actively bound.
	// The probe-connect is the only reliable signal across platforms.
	if (await probeSocketIsLive(sockPath)) {
		throw new Error(
			`IPC socket already has a live listener at ${sockPath} (another OMS session is bound). ` +
				`Quit the other session or remove the file manually if you are sure it is stale.`,
		);
	}

	const maxAttempts = LISTEN_RETRY_BACKOFF_MS.length + 1;
	let lastErr: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			const delayMs = LISTEN_RETRY_BACKOFF_MS[attempt - 1] ?? 400;
			await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
		}

		// Always attempt to unlink, ignoring ENOENT / EACCES. The Windows quirk
		// above means `existsSync` cannot be trusted; the unlink itself is the
		// only safe way to find out.
		try {
			fs.unlinkSync(sockPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "";
			if (code !== "ENOENT") {
				logger.debug("IPC: failed to remove stale socket before bind", {
					sockPath,
					attempt,
					code,
					err,
				});
			}
		}

		try {
			return await bindOnce(sockPath, opts.onWake);
		} catch (err) {
			lastErr = err;
			logger.debug("IPC: listen attempt failed; will retry", {
				sockPath,
				attempt,
				remainingAttempts: maxAttempts - attempt - 1,
				err,
			});
		}
	}

	throw lastErr instanceof Error ? lastErr : new Error(`Failed to listen at ${sockPath}`);
}
