import { afterEach, describe, expect, it } from "vitest";
import {
	deleteSessionRuntime,
	focusedSessionRuntime,
	registerSessionRuntime,
	type SessionRuntime,
	setFocusedSessionRuntime,
	withSessionRuntime,
} from "./session-runtime-context";

function runtime(tabId: string): SessionRuntime {
	return registerSessionRuntime({
		tabId,
		command: async command => ({ type: "response", command: command.type, success: true }),
		stores: new Map(),
	});
}

afterEach(() => {
	deleteSessionRuntime("tab-a");
	deleteSessionRuntime("tab-b");
	setFocusedSessionRuntime(null);
});

describe("withSessionRuntime", () => {
	it("restores the focused runtime when the scoped work throws", () => {
		const focused = runtime("tab-a");
		runtime("tab-b");
		setFocusedSessionRuntime("tab-a");

		expect(() =>
			withSessionRuntime("tab-b", () => {
				expect(focusedSessionRuntime()?.tabId).toBe("tab-b");
				throw new Error("reducer failed");
			}),
		).toThrow("reducer failed");

		expect(focusedSessionRuntime()).toBe(focused);
	});
});
