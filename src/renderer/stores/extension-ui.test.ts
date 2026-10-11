import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { createExtensionUiStore } from "./extension-ui";

function confirm(id: string): ExtensionUIRequest {
	return { type: "extension_ui_request", id, method: "confirm", title: "Allow?", message: `request ${id}` };
}

describe("extension UI requests", () => {
	it("closes only the dialog the sidecar cancelled", () => {
		const store = createExtensionUiStore();
		store.getState().pushRequest(confirm("first"));
		store.getState().pushRequest(confirm("second"));

		store
			.getState()
			.pushRequest({ type: "extension_ui_request", id: "cancel-1", method: "cancel", targetId: "first" });

		expect(store.getState().pendingRequests.map(request => request.id)).toEqual(["second"]);
	});
});
