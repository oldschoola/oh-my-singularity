import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OmsRpcClient } from "./rpc-wrapper";

// These tests pin down the microtask-race fix in send(): when forceKill (or any
// other rejectAllPending caller) fires while a send() is still suspended on
// `await stdin.write(line)`, the underlying resultPromise must already have a
// handler attached so Bun does not emit `unhandledRejection`.

type WritableStub = { write: (line: string) => Promise<unknown>; end?: () => Promise<void> };

function installStubProc(client: OmsRpcClient, stdin: WritableStub): void {
	const hangingPromise = new Promise<never>(() => {});
	const emptyReader = {
		read: async (): Promise<{ done: boolean; value: undefined }> => ({ done: true, value: undefined }),
		releaseLock: () => {},
	};
	const procStub = {
		kill: () => {},
		stdin,
		stdout: { getReader: () => emptyReader },
		stderr: { getReader: () => emptyReader },
		exited: hangingPromise,
	};
	const internal = client as unknown as { proc: unknown; stdin: WritableStub };
	internal.proc = procStub;
	internal.stdin = stdin;
}

describe("OmsRpcClient", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};

	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	test("forceKill during in-flight send rejects the caller without unhandled rejection", async () => {
		const client = new OmsRpcClient();

		const { promise: writePromise, resolve: resolveWrite } = Promise.withResolvers<number>();
		installStubProc(client, { write: () => writePromise });

		// Kick off an abort. The internal send() will register a pending entry
		// and then suspend on `await stdin.write(...)` until resolveWrite() runs.
		// Attach a catch immediately so the *outer* abort() promise itself does
		// not trigger unhandledRejection — we are only testing the inner
		// resultPromise.
		const abortError: Promise<Error | undefined> = client.abort().then(
			() => undefined,
			(err: unknown) => err as Error,
		);

		// Yield enough microtasks for send() to register the pending request
		// and reach `await stdin.write(line)`.
		await Bun.sleep(0);
		await Bun.sleep(0);

		// Reject every pending request synchronously, mirroring the
		// advance_lifecycle -> forceKill path from handlers.ts.
		client.forceKill();

		// Let the write resolve so send() can resume, observe the rejection on
		// resultPromise, and propagate it out of abort().
		resolveWrite(1);

		const err = await abortError;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("RPC process force-killed");
		expect((err as Error).message).toContain("abort");

		// Drain any deferred unhandledRejection bookkeeping.
		await Bun.sleep(10);
		expect(unhandled).toEqual([]);
	});

	test("rejectAllPending without an awaiter does not surface as unhandled", async () => {
		// Covers the case where send() has registered a pending request but the
		// outer awaiter has not yet wired up its handler chain (e.g. the
		// resultPromise was just created on this tick).
		const client = new OmsRpcClient();
		installStubProc(client, { write: () => new Promise<number>(() => {}) });

		const abortError: Promise<Error | undefined> = client.abort().then(
			() => undefined,
			(err: unknown) => err as Error,
		);

		// Reject immediately, before the next microtask tick.
		client.forceKill();

		await Bun.sleep(10);
		expect(unhandled).toEqual([]);

		// Abort itself never resolves because stdin.write hangs forever in this
		// stub; that is fine — the production code would have exited the
		// subprocess by now, releasing the write. We just need to confirm no
		// stray unhandled rejection escaped during the race window.
		void abortError;
	});
});
