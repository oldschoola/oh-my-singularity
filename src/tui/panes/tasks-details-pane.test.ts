import { describe, expect, test } from "bun:test";

import type { TaskStoreClient } from "../../tasks/client";
import type { TaskIssue } from "../../tasks/types";
import { type Region, TasksDetailsPane } from "./tasks-details-pane";

function makeIssue(overrides: Partial<TaskIssue> = {}): TaskIssue {
	return {
		id: "task-1",
		title: "Task 1",
		description: "desc",
		acceptance_criteria: null,
		status: "open",
		priority: 2,
		issue_type: "task",
		labels: [],
		assignee: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		comments: [],
		...overrides,
	};
}

function createTerminalStub() {
	let cursorY = 1;
	const lines = new Map<number, string>();

	const term = ((text: string) => {
		lines.set(cursorY, text);
	}) as unknown as {
		moveTo: (x: number, y: number) => void;
		(text: string): void;
	};

	term.moveTo = (_x: number, y: number) => {
		cursorY = y;
	};

	return {
		term,
		reset: () => lines.clear(),
		text: () =>
			[...lines.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, line]) => line)
				.join("\n"),
	};
}

/** Strip CSI/SGR ANSI escape sequences for substring assertions that should
 * be insensitive to per-marker coloring. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("TasksDetailsPane", () => {
	test("refreshes selected issue details when same selection receives new comments", async () => {
		let selectedIssue = makeIssue();

		const tasksClient = {
			show: async () => ({ ...selectedIssue, comments: [...(selectedIssue.comments ?? [])] }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 30 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		expect(term.text()).toContain("comments: (none)");

		selectedIssue = makeIssue({
			updated_at: "2026-01-01T00:01:00.000Z",
			comments: [
				{
					id: 1,
					issue_id: "task-1",
					author: "oms-worker",
					text: "completion: implemented fix",
					created_at: "2026-01-01T00:01:00.000Z",
				},
			],
		});

		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		expect(rendered).toContain("comments: 1");
		expect(rendered).toContain("completion: implemented fix");
	});

	test("renders references metadata when present", async () => {
		const selectedIssue = makeIssue({
			references: ["task-a", " task-b "],
		});
		const tasksClient = {
			show: async () => ({ ...selectedIssue }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 20 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		expect(rendered).toContain("references:");
		expect(rendered).toContain("task-a, task-b");
	});

	test("renders scope metadata when present", async () => {
		const selectedIssue = makeIssue({
			scope: "large",
		});
		const tasksClient = {
			show: async () => ({ ...selectedIssue }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 20 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		expect(rendered).toContain("scope:");
		expect(rendered).toContain("large");
	});

	test("shows per-agent full usage and cost breakdown for selected task", async () => {
		const selectedIssue = makeIssue();
		const tasksClient = {
			show: async () => ({ ...selectedIssue, comments: [...(selectedIssue.comments ?? [])] }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const agents = [
			{
				id: "worker-1",
				agentType: "worker",
				taskId: selectedIssue.id,
				tasksAgentId: "agent-1",
				status: "done",
				usage: {
					input: 12,
					output: 34,
					cacheRead: 5,
					cacheWrite: 2,
					totalTokens: 53,
					cost: 0.321,
				},
				events: [],
				spawnedAt: 1_000,
				lastActivity: 66_000,
				contextWindow: 1_000,
				contextTokens: 45,
				compactionCount: 2,
			},
		];

		const registry = {
			getByTask: () => agents,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
			registry: registry as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 220, height: 40 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();

		expect(rendered).toContain("── Agents ──");
		expect(rendered).toContain("worker");
		expect(rendered).toContain("|  done  |");
		const plain = stripAnsi(rendered);
		expect(plain).toContain("↓  12");
		expect(plain).toContain("↑  34");
		expect(plain).toContain("R   5");
		expect(plain).toContain("W   2");
		expect(plain).toContain("$0.321");
		expect(plain).toContain("C  5%");
		expect(plain).toContain("T65s");
		expect(plain).toContain("C:2");
		expect(rendered).toContain("task duration: 1m 5s");
	});

	test("renders persisted agent history when no live registry agents are present", async () => {
		const selectedIssue = makeIssue();
		const persistedAgentIssue = makeIssue({
			id: "agent-77",
			title: "worker-task-1",
			description: null,
			issue_type: "agent",
			status: "done",
			priority: 0,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:01:05.000Z",
			comments: [],
			hook_task: selectedIssue.id,
			last_activity: "2026-01-01T00:01:05.000Z",
			agent_state: "done",
			usage_totals: {
				input: 10,
				output: 20,
				cacheRead: 4,
				cacheWrite: 1,
				totalTokens: 35,
				cost: 0.1,
			},
		});

		const tasksClient = {
			show: async () => ({ ...selectedIssue, comments: [...(selectedIssue.comments ?? [])] }),
			list: async () => [persistedAgentIssue],
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 220, height: 40 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();

		expect(rendered).toContain("agent usage: 1");
		expect(rendered).toContain("task duration: 1m 5s");
		expect(rendered).toContain("── Agents ──");
		expect(rendered).toContain("worker");
		expect(rendered).toContain("|  done  |");
		const plain = stripAnsi(rendered);
		expect(plain).toContain("↓  10");
		expect(plain).toContain("↑  20");
		expect(plain).toContain("R   4");
		expect(plain).toContain("W   1");
		expect(plain).toContain("$0.100");
	});
	test("re-fetches via show() when poller snapshot lacks comments that show() would return", async () => {
		// Poller path returns the lightweight issue (no comment bodies); show() returns the
		// full version. The pane must fall back to show() when the snapshot key changes,
		// otherwise the inline-swap permanently downgrades the fetched data.
		const fullIssueRev1: TaskIssue = makeIssue({
			updated_at: "2026-01-01T00:00:00.000Z",
			comments: [
				{
					id: 1,
					issue_id: "task-1",
					author: "oms-worker",
					text: "initial-comment-body",
					created_at: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		const fullIssueRev2: TaskIssue = makeIssue({
			updated_at: "2026-01-01T00:01:00.000Z",
			comments: [
				...(fullIssueRev1.comments ?? []),
				{
					id: 2,
					issue_id: "task-1",
					author: "oms-finisher",
					text: "second-comment-body",
					created_at: "2026-01-01T00:01:00.000Z",
				},
			],
		});

		let currentFull = fullIssueRev1;
		// Lightweight snapshot: keep updated_at/comments-count in sync with full, but strip bodies.
		const lightweightSnapshot = (): TaskIssue => ({
			...currentFull,
			comments: (currentFull.comments ?? []).map(c => ({ ...c, text: "" })),
		});

		let showCalls = 0;
		const tasksClient = {
			show: async () => {
				showCalls += 1;
				return { ...currentFull, comments: [...(currentFull.comments ?? [])] };
			},
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => "task-1",
			getSelectedIssue: () => lightweightSnapshot(),
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 30 };

		// First render: selection appears for the first time → fires initial fetch.
		pane.render(term.term, region);
		await Bun.sleep(0);
		expect(showCalls).toBeGreaterThanOrEqual(1);
		const baselineShowCalls = showCalls;
		term.reset();
		pane.render(term.term, region);
		expect(term.text()).toContain("initial-comment-body");

		// External update: a new comment is added. The poller snapshot reports the new
		// comment count but with an empty body; show() returns the full body.
		currentFull = fullIssueRev2;

		term.reset();
		pane.render(term.term, region);
		await Bun.sleep(0);
		// show() must have been re-invoked because the snapshot key changed.
		expect(showCalls).toBeGreaterThan(baselineShowCalls);

		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		// Body from show() must be visible, not the stripped poller snapshot.
		expect(rendered).toContain("initial-comment-body");
		expect(rendered).toContain("second-comment-body");
	});

	test("recordFinisherClose surfaces the summary in the selected task details", async () => {
		const issue = makeIssue({ id: "task-9", title: "Wire the thing" });

		const tasksClient = {
			show: async () => ({ ...issue, comments: [] }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => issue.id,
			getSelectedIssue: () => issue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 30 };

		// Drive the initial fetch.
		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		expect(term.text()).not.toContain("Finisher Summary");

		// Recording a summary for the currently selected task must surface it.
		pane.recordFinisherClose(issue.id, "merged review/foo into main", "merge-success");
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		expect(rendered).toContain("Finisher Summary");
		expect(rendered).toContain("merged review/foo into main");

		// A subsequent record for a different task must NOT show here.
		pane.recordFinisherClose("task-other", "ignored", "other-reason");
		term.reset();
		pane.render(term.term, region);
		const rendered2 = term.text();
		expect(rendered2).toContain("merged review/foo into main");
		expect(rendered2).not.toContain("ignored");
	});
});
