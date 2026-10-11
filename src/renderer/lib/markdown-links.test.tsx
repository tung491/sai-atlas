/**
 * Link-click routing for model-authored markdown links: a workspace path or a
 * file: URL opens the in-app file preview (scoped to the transcript's tab), a
 * web URL goes to the OS browser through the bridge, and an in-page anchor is
 * left to the webview. The webview itself must never navigate away.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const openExternal = vi.fn(async (_url: string) => {});
// Window carries the omp bridge at runtime; only the system surface is reached here.
(window as unknown as { omp: unknown }).omp = { system: { openExternal } };

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { MarkdownRenderer } = await import("./markdown");
const { useUiStore } = await import("../stores/ui");
const { setFocusedSessionRuntime } = await import("../stores/session-runtime-context");

const initialUi = useUiStore.getState();
let container: HTMLElement;
let root: Root;

async function mount(content: string): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MarkdownRenderer content={content} />
			</I18nProvider>,
		);
	});
}

/** Clicks the only link; returns whether the webview's default navigation still runs. */
async function clickLink(): Promise<boolean> {
	const links = container.querySelectorAll("a");
	expect(links.length).toBe(1);
	let allowed = true;
	await act(async () => {
		allowed = links[0].dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	return allowed;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	openExternal.mockClear();
	setFocusedSessionRuntime(null);
	useUiStore.setState(initialUi, true);
});

describe("markdown link clicks", () => {
	it("opens a relative path in the file preview of the transcript's tab", async () => {
		setFocusedSessionRuntime("tab-7");
		await mount("See [the notes](docs/release%20notes.md#setup).");

		expect(await clickLink()).toBe(false);
		expect(useUiStore.getState().filePreview).toEqual({
			kind: "path",
			path: "docs/release notes.md",
			tabId: "tab-7",
		});
		expect(useUiStore.getState().panelVisible).toBe(true);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("opens a file: URL in the file preview, not the OS handler", async () => {
		await mount("[run log](file:///tmp/run%20log.txt)");

		expect(await clickLink()).toBe(false);
		expect(useUiStore.getState().filePreview).toEqual({ kind: "path", path: "/tmp/run log.txt", tabId: null });
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("sends an https: link to the OS browser and keeps the webview in place", async () => {
		await mount("[docs](https://example.com/guide?x=1)");

		expect(await clickLink()).toBe(false);
		expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/guide?x=1");
		expect(useUiStore.getState().filePreview).toBeNull();
	});

	it("leaves an in-page anchor to the webview: no preview, no browser", async () => {
		await mount("[jump](#install)");

		expect(await clickLink()).toBe(true);
		expect(openExternal).not.toHaveBeenCalled();
		expect(useUiStore.getState().filePreview).toBeNull();
	});
});
