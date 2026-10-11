/**
 * Contract test for the settings store's display-settings sync: every path in
 * DISPLAY_BOOL_MAP and DISPLAY_NUM_MAP must land on its store field (dotted
 * agent paths onto camelCase fields), and wrongly typed, out-of-range or absent
 * values must be ignored so stale defaults never clobber live state. Stale
 * replies (an older sync, or one that crossed a reset) never win.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { createSettingsStore, DISPLAY_BOOL_MAP, DISPLAY_NUM_MAP, useSettingsStore } from "./settings";

const getSettings = vi.fn<(paths?: string[]) => Promise<RpcResponse>>();

// linkedom-less store test: install a minimal omp bridge on the global scope
// (node env has no `window`; the store resolves it via globalThis).
const ompGlobal = globalThis as unknown as { window: { omp: { rpc: { getSettings: typeof getSettings } } } };
ompGlobal.window = { omp: { rpc: { getSettings } } };

function success(values: Record<string, unknown>): Promise<RpcResponse> {
	return Promise.resolve(settingsReply(values));
}

function settingsReply(values: Record<string, unknown>): RpcResponse {
	return { type: "response", command: "get_settings", success: true, data: { values } };
}

/** A command whose replies the test resolves by hand, in any order. */
function deferredCommand(): {
	command: (request: RpcCommand) => Promise<RpcResponse>;
	replies: PromiseWithResolvers<RpcResponse>[];
} {
	const replies: PromiseWithResolvers<RpcResponse>[] = [];
	const command = (_request: RpcCommand): Promise<RpcResponse> => {
		const reply = Promise.withResolvers<RpcResponse>();
		replies.push(reply);
		return reply.promise;
	};
	return { command, replies };
}

afterEach(() => {
	getSettings.mockReset();
	useSettingsStore.getState().reset();
});

describe("settings store display sync", () => {
	it("maps display.*, tui.titleState, and goal.statusInFooter onto store fields", async () => {
		getSettings.mockResolvedValueOnce(
			await success({
				hideThinkingBlock: true,
				proseOnlyThinking: false,
				omitThinking: true,
				"display.showTokenUsage": true,
				"display.collapseCompacted": false,
				"tui.titleState": false,
				"goal.statusInFooter": false,
			}),
		);
		await useSettingsStore.getState().syncDisplaySettings();
		const state = useSettingsStore.getState();
		expect(state.showTokenUsage).toBe(true);
		expect(state.collapseCompacted).toBe(false);
		expect(state.titleState).toBe(false);
		expect(state.goalStatusInFooter).toBe(false);
		expect(state.hideThinkingBlock).toBe(true);
		expect(state.proseOnlyThinking).toBe(false);
		expect(state.omitThinking).toBe(true);
	});

	it("requests every agent display setting path the GUI renders from", async () => {
		getSettings.mockResolvedValueOnce(await success({}));
		await useSettingsStore.getState().syncDisplaySettings();
		expect(getSettings.mock.calls[0]?.[0]?.toSorted()).toEqual(
			[
				"display.collapseCompacted",
				"display.showTokenUsage",
				"emojiAutocomplete",
				"goal.statusInFooter",
				"hideThinkingBlock",
				"omitThinking",
				"paste.largeMenuThreshold",
				"proseOnlyThinking",
				"speech.enabled",
				"stt.enabled",
				"terminal.showProgress",
				"tui.titleState",
			].toSorted(),
		);
	});

	it.each(Object.entries(DISPLAY_BOOL_MAP))("syncs boolean %s onto %s", async (path, field) => {
		const flipped = !useSettingsStore.getState()[field];
		getSettings.mockResolvedValueOnce(await success({ [path]: flipped }));
		await useSettingsStore.getState().syncDisplaySettings();
		expect(useSettingsStore.getState()[field]).toBe(flipped);
	});

	it.each(Object.entries(DISPLAY_NUM_MAP))("syncs number %s onto %s", async (path, field) => {
		const changed = useSettingsStore.getState()[field] + 7;
		getSettings.mockResolvedValueOnce(await success({ [path]: changed }));
		await useSettingsStore.getState().syncDisplaySettings();
		expect(useSettingsStore.getState()[field]).toBe(changed);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, "250"])("ignores a paste menu threshold of %s", async value => {
		useSettingsStore.setState({ pasteMenuThreshold: 40 });
		getSettings.mockResolvedValueOnce(await success({ "paste.largeMenuThreshold": value }));
		await useSettingsStore.getState().syncDisplaySettings();
		expect(useSettingsStore.getState().pasteMenuThreshold).toBe(40);
	});

	it("accepts a paste menu threshold of 0, which turns the menu off", async () => {
		getSettings.mockResolvedValueOnce(await success({ "paste.largeMenuThreshold": 0 }));
		await useSettingsStore.getState().syncDisplaySettings();
		expect(useSettingsStore.getState().pasteMenuThreshold).toBe(0);
	});

	it("ignores absent and non-boolean values instead of clobbering state", async () => {
		useSettingsStore.setState({ showTokenUsage: true, titleState: false });
		getSettings.mockResolvedValueOnce(
			await success({ "display.showTokenUsage": "yes", "goal.statusInFooter": true }),
		);
		await useSettingsStore.getState().syncDisplaySettings();
		const state = useSettingsStore.getState();
		expect(state.showTokenUsage).toBe(true);
		expect(state.titleState).toBe(false);
		expect(state.goalStatusInFooter).toBe(true);
	});

	it("keeps current values when the read fails", async () => {
		useSettingsStore.setState({ collapseCompacted: false });
		getSettings.mockRejectedValueOnce(new Error("sidecar down"));
		await useSettingsStore.getState().syncDisplaySettings();
		expect(useSettingsStore.getState().collapseCompacted).toBe(false);
	});

	it("keeps the latest sync when an older sidecar reply arrives last", async () => {
		const older = Promise.withResolvers<RpcResponse>();
		const newer = Promise.withResolvers<RpcResponse>();
		getSettings.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

		const firstSync = useSettingsStore.getState().syncDisplaySettings();
		const secondSync = useSettingsStore.getState().syncDisplaySettings();
		newer.resolve({
			type: "response",
			command: "get_settings",
			success: true,
			data: { values: { "tui.titleState": false } },
		});
		await secondSync;
		older.resolve({
			type: "response",
			command: "get_settings",
			success: true,
			data: { values: { "tui.titleState": true } },
		});
		await firstSync;

		expect(useSettingsStore.getState().titleState).toBe(false);
	});
});

describe("settings store approval mode", () => {
	it("offers no way to write the approval mode", () => {
		const approvalActions = Object.entries(useSettingsStore.getState())
			.filter(([key, value]) => typeof value === "function" && /approval/i.test(key))
			.map(([key]) => key);
		expect(approvalActions).toEqual(["syncApproval"]);
	});

	it("reads the approval mode without migrating the stored preference into the user's config", async () => {
		const commands: RpcCommand[] = [];
		const command = async (request: RpcCommand): Promise<RpcResponse> => {
			commands.push(request);
			return {
				type: "response",
				command: request.type,
				success: true,
				data: {
					values: { "tools.approvalMode": "always-ask" },
					provenance: { "tools.approvalMode": { layers: [] } },
				},
			} as RpcResponse;
		};
		const prefsGet = vi.fn(async () => "yolo");
		const prefsSet = vi.fn(async () => {});
		const bridge = ompGlobal.window.omp as unknown as Record<string, unknown>;
		bridge.prefs = { get: prefsGet, set: prefsSet };
		try {
			const store = createSettingsStore(command);
			await store.getState().syncApproval();
			expect(store.getState().approvalMode).toBe("always-ask");
			expect(commands.map(entry => entry.type)).toEqual(["get_settings"]);
			expect(commands.some(entry => entry.type === "set_setting")).toBe(false);
			expect(prefsGet).not.toHaveBeenCalled();
			expect(prefsSet).not.toHaveBeenCalled();
		} finally {
			delete bridge.prefs;
		}
	});

	it("ignores an approval mode the GUI does not know", async () => {
		const { command, replies } = deferredCommand();
		const store = createSettingsStore(command);
		store.setState({ approvalMode: "write" });
		const sync = store.getState().syncApproval();
		replies[0]?.resolve(settingsReply({ "tools.approvalMode": "bogus" }));
		await sync;
		expect(store.getState().approvalMode).toBe("write");
	});

	it("keeps the latest approval read when an older reply arrives last", async () => {
		const { command, replies } = deferredCommand();
		const store = createSettingsStore(command);
		const firstSync = store.getState().syncApproval();
		const secondSync = store.getState().syncApproval();
		replies[1]?.resolve(settingsReply({ "tools.approvalMode": "write" }));
		await secondSync;
		replies[0]?.resolve(settingsReply({ "tools.approvalMode": "always-ask" }));
		await firstSync;
		expect(store.getState().approvalMode).toBe("write");
	});
});

describe("settings store reset", () => {
	it("drops approval and display replies that were in flight across a reset", async () => {
		const { command, replies } = deferredCommand();
		const store = createSettingsStore(command);
		const approvalSync = store.getState().syncApproval();
		const displaySync = store.getState().syncDisplaySettings();
		store.getState().reset();
		replies[0]?.resolve(settingsReply({ "tools.approvalMode": "always-ask" }));
		replies[1]?.resolve(settingsReply({ "tui.titleState": false }));
		await Promise.all([approvalSync, displaySync]);
		expect(store.getState().approvalMode).toBe("yolo");
		expect(store.getState().titleState).toBe(true);
	});
});
