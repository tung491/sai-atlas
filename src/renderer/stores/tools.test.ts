import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import { createToolsStore } from "./tools";

function call(id: string, timestamp = 1): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
		timestamp,
	};
}

function result(id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	};
}

const start = (toolCallId: string): AgentSessionEvent => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: "read",
	args: { path: `${toolCallId}.ts` },
});

describe("tools store history rebuild", () => {
	it("ends an unanswered call from a finished turn instead of spinning forever", () => {
		const store = createToolsStore();
		// A turn interrupted before the tool returned leaves the call in the
		// transcript with no result row. Reloading such a session used to render
		// every one of those cards as still running, with a live duration clock.
		store.getState().hydrateMessages([call("read:0")]);

		expect(store.getState().activeTools.get("read:0")).toMatchObject({
			status: "aborted",
			endTime: null,
		});
	});

	it("keeps only the trailing unanswered call live while the turn is streaming", () => {
		const store = createToolsStore();
		const messages = [call("first"), result("first"), call("last")];
		store.getState().hydrateMessages(messages, { turnIsLive: true });

		expect(store.getState().activeTools.get("first")).toMatchObject({ status: "done" });
		expect(store.getState().activeTools.get("last")).toMatchObject({ status: "running" });
	});

	it("aborts the trailing unanswered call once the session reports it is idle", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("first"), result("first"), call("last")], { turnIsLive: false });

		expect(store.getState().activeTools.get("last")).toMatchObject({ status: "aborted" });
	});

	it("promotes the aborted placeholder when a late execution event arrives", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0")]);
		// Mid-run attach: hydrate saw no result yet, then the live events resume
		// for the same call. The card must switch to running, not duplicate.
		store.getState().applyEvents([start("read:0")]);

		expect(store.getState().activeTools.size).toBe(1);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "running" });

		store.getState().applyEvents([
			{
				type: "tool_execution_end",
				toolCallId: "read:0",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
		]);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "done" });
	});

	it("does not resurrect an already answered call", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([call("read:0"), result("read:0")]);
		store.getState().applyEvents([start("read:0")]);

		// The finished call keeps its result; the new event opens its own card.
		expect(store.getState().activeTools.size).toBe(2);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "done" });
	});
});

describe("tools store live stream", () => {
	const callBlock = (name: string, path: string) => ({
		type: "toolCall" as const,
		id: "read:0",
		name,
		arguments: { path },
	});
	const first = callBlock("read", "a.ts");
	const second = callBlock("grep", "b.ts");
	const partial: AgentMessage = { role: "assistant", content: [first, second], timestamp: 1 };

	const argsDelta = (contentIndex: number, delta: string): AgentSessionEvent => ({
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex, delta, partial },
	});
	const update = (partialResult: unknown): AgentSessionEvent => ({
		type: "tool_execution_update",
		toolCallId: "read:0",
		toolName: "read",
		args: {},
		partialResult,
	});
	const end = (text: string): AgentSessionEvent => ({
		type: "tool_execution_end",
		toolCallId: "read:0",
		toolName: "read",
		result: { content: [{ type: "text", text }] },
		isError: false,
	});

	it("accumulates streamed args and routes each execution of a reused id to its own card", () => {
		const store = createToolsStore();
		store.getState().applyEvents([{ type: "message_start", message: partial }, argsDelta(0, '{"pa')]);
		store.getState().applyEvents([argsDelta(0, 'th":"a.ts"}'), argsDelta(1, '{"path":"b.ts"}')]);

		const streaming = [...store.getState().activeTools.values()];
		expect(streaming.map(entry => entry.streamingArgs)).toEqual(['{"path":"a.ts"}', '{"path":"b.ts"}']);

		const final: AgentMessage = { role: "assistant", content: [first, second], timestamp: 1 };
		store.getState().applyEvents([{ type: "message_end", message: final }]);
		const [firstKey, secondKey] = [...store.getState().activeTools.keys()];

		store.getState().applyEvents([start("read:0"), update("line 1"), update("line 1\nline 2")]);
		expect(store.getState().activeTools.get(firstKey ?? "")).toMatchObject({
			status: "running",
			partialResult: "line 1\nline 2",
		});

		store.getState().applyEvents([end("first done"), start("read:0"), update("matching"), end("second done")]);

		const tools = store.getState().activeTools;
		expect(tools.size).toBe(2);
		expect(tools.get(firstKey ?? "")).toMatchObject({
			status: "done",
			result: { content: [{ type: "text", text: "first done" }] },
		});
		expect(tools.get(secondKey ?? "")).toMatchObject({
			status: "done",
			partialResult: "matching",
			result: { content: [{ type: "text", text: "second done" }] },
		});
	});
});
