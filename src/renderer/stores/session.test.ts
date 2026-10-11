import { describe, expect, it } from "vitest";
import type { RpcSessionState } from "../../shared/rpc-types";
import { createSessionStore } from "./session";

function sessionState(sessionName: string | null | undefined): RpcSessionState {
	return {
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		cwd: "/home/tester/work",
		sessionId: "session-1",
		sessionName,
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: null,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		messageCount: 0,
		queuedMessageCount: 0,
		todoPhases: [],
		planModeEnabled: false,
		agentsPaused: false,
	};
}

describe("session store snapshot", () => {
	it("treats an empty session title as untitled", () => {
		const store = createSessionStore();
		store.setState({ sessionName: "earlier title" });

		store.getState().setFromState(sessionState(""));

		expect(store.getState().sessionName).toBeNull();
	});

	it("keeps a real session title", () => {
		const store = createSessionStore();

		store.getState().setFromState(sessionState("Refactor the store"));

		expect(store.getState().sessionName).toBe("Refactor the store");
	});
});
