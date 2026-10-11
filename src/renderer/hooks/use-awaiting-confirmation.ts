import { BLOCKING_UI_METHODS } from "../../shared/rpc-types";
import { useExtensionUiStore } from "../stores/extension-ui";

/**
 * True while the attached session blocks on a user confirmation — an ask or
 * a permission prompt. Shared by the sidebar signal light
 * and the window-title run-state marker.
 */
export function useAwaitingConfirmation(): boolean {
	return useExtensionUiStore(s => s.pendingRequests.some(request => BLOCKING_UI_METHODS[request.method] === true));
}
