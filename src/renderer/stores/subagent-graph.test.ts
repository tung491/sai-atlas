import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage, SubagentSnapshot } from "../../shared/rpc-types";
import { buildSubagentDag, MAIN_NODE_ID, registerTranscriptToolCalls } from "../components/panels/subagent-graph";
import { createSubagentGraphStore, useSubagentGraphStore } from "./subagent-graph";

function taskCall(id: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "task", arguments: { agent: "explore" } }],
		timestamp: 1,
	};
}

function agent(id: string, index: number, parentToolCallId: string): SubagentSnapshot {
	return { id, index, agent: "explore", status: "running", lastUpdate: 0, parentToolCallId };
}

afterEach(() => {
	useSubagentGraphStore.getState().reset();
});

describe("subagent graph store", () => {
	it("records which subagent owns each tool call", () => {
		const store = createSubagentGraphStore();

		store.getState().registerToolCallOwners("agent-1", ["call-a", "call-b"]);
		store.getState().registerToolCallOwners("agent-2", ["call-c"]);

		expect([...store.getState().toolCallOwners]).toEqual([
			["call-a", "agent-1"],
			["call-b", "agent-1"],
			["call-c", "agent-2"],
		]);
	});

	it("keeps the same map when a reload registers known owners again", () => {
		const store = createSubagentGraphStore();
		store.getState().registerToolCallOwners("agent-1", ["call-a"]);
		const owners = store.getState().toolCallOwners;

		store.getState().registerToolCallOwners("agent-1", ["call-a"]);

		expect(store.getState().toolCallOwners).toBe(owners);
	});

	it("forgets every owner on reset", () => {
		const store = createSubagentGraphStore();
		store.getState().registerToolCallOwners("agent-1", ["call-a"]);

		store.getState().reset();

		expect(store.getState().toolCallOwners.size).toBe(0);
	});
});

describe("subagent DAG with transcript owners", () => {
	it("nests a subagent under the subagent whose transcript spawned it", () => {
		const parent = agent("parent", 0, "root-call");
		const child = agent("child", 1, "nested-call");
		registerTranscriptToolCalls("parent", [taskCall("nested-call")]);

		const layout = buildSubagentDag(
			[parent, child],
			new Set(["root-call"]),
			useSubagentGraphStore.getState().toolCallOwners,
		);

		expect(layout.edges.map(edge => edge.id)).toEqual([`${MAIN_NODE_ID}->parent`, "parent->child"]);
		expect(layout.nodes.find(node => node.id === "child")?.depth).toBe(2);
		expect(layout.unresolved).toEqual([]);
	});
});
