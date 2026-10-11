import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { UpdateBanner } from "./UpdateBanner";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	click: () => void;
	remove: () => void;
	querySelectorAll: (selector: string) => TestElement[];
}

const check = vi.fn(() => Promise.resolve({ state: "checking" } as const));
const download = vi.fn(() => Promise.resolve({ state: "idle" } as const));
const apply = vi.fn(() => Promise.resolve());
Object.assign(window, { omp: { updater: { check, download, apply } } });

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
	check.mockClear();
	download.mockClear();
	apply.mockClear();
});

describe("UpdateBanner", () => {
	it("offers a download for an available version the user has not dismissed", async () => {
		useUpdaterStore.setState({
			status: { state: "available", version: "0.9.20", mode: "automatic" },
			dismissed: { version: "0.9.19" },
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toContain("Version 0.9.20 is available");
		const downloadButton = container
			.querySelectorAll("button")
			.find(button => button.textContent?.includes("Download update"));
		await act(async () => {
			downloadButton?.click();
		});
		expect(download).toHaveBeenCalledOnce();
	});

	it("hides the version the user dismissed", async () => {
		useUpdaterStore.setState({
			status: { state: "available", version: "0.9.20", mode: "automatic" },
			dismissed: { version: "0.9.20" },
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toBe("");
	});

	it("shows download progress", async () => {
		useUpdaterStore.setState({
			status: {
				state: "downloading",
				version: "0.9.20",
				mode: "automatic",
				percent: 42,
				bytesPerSecond: 1_000,
				transferred: 42_000_000,
				total: 100_000_000,
			},
			dismissed: { version: "0.9.20" },
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toContain("Downloading update…");
		expect(container.textContent).toContain("42% · 42.0 MB/100.0 MB");
	});

	it("offers restart-and-install once the update is downloaded", async () => {
		useUpdaterStore.setState({
			status: { state: "downloaded", version: "0.8.5", mode: "automatic" },
			dismissed: {},
		});
		await mount(<UpdateBanner />);

		const restartButton = container
			.querySelectorAll("button")
			.find(button => button.textContent?.includes("Restart & install"));
		await act(async () => {
			restartButton?.click();
		});
		expect(apply).toHaveBeenCalledOnce();
	});

	it("asks for a reopen instead of offering an install that cannot ask for administrator access", async () => {
		useUpdaterStore.setState({
			status: { state: "downloaded", version: "0.9.18", mode: "automatic", reopenRequired: true },
			dismissed: {},
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toContain("0.9.18 is downloaded");
		expect(container.textContent).toContain("Quit and reopen Sai ATLAS, then try again.");
		expect(container.textContent).not.toContain("Restart & install");
		expect(container.querySelectorAll("button")).toHaveLength(0);
	});

	it("keeps user-initiated verification failures visible with a retry action", async () => {
		useUpdaterStore.setState({
			status: { state: "error", message: "Installer failed SHA-512 verification.", showInBanner: true },
			dismissed: {},
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toContain("Installer failed SHA-512 verification.");
		const retryButton = container
			.querySelectorAll("button")
			.find(button => button.textContent?.includes("Check again"));
		await act(async () => {
			retryButton?.click();
		});
		expect(check).toHaveBeenCalledOnce();
	});

	it("tells the user which command installs the update when apt could not resolve its dependencies", async () => {
		const command = "sudo apt install /home/u/.cache/sai-atlas/sai-atlas_0.9.18_amd64.deb";
		useUpdaterStore.setState({
			status: {
				state: "error",
				message:
					"The update could not be installed. (E: Unable to correct problems, you have held broken packages.)",
				showInBanner: true,
				manualInstallCommand: command,
			},
			dismissed: {},
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toContain("apt could not resolve the packages it needs");
		expect(container.textContent).toContain(`Run this in a terminal to see why and install it: ${command}`);
		expect(container.textContent).not.toContain("held broken packages");
		expect(container.querySelectorAll("button").some(button => button.textContent?.includes("Check again"))).toBe(
			true,
		);
	});

	it("lets a user close a failure banner, and keeps the closed notice closed", async () => {
		useUpdaterStore.setState({
			status: { state: "error", message: "GitHub release feed unreachable.", showInBanner: true },
			dismissed: {},
		});
		await mount(<UpdateBanner />);

		const [dismissButton] = container.querySelectorAll('[aria-label="Dismiss this update notice"]');
		expect(dismissButton).toBeDefined();
		await act(async () => {
			dismissButton?.click();
		});
		expect(container.textContent).toBe("");

		// The four-hourly poll replays the same failure: still hidden.
		await act(async () => {
			useUpdaterStore.getState().setStatus({
				state: "error",
				message: "GitHub release feed unreachable.",
				showInBanner: true,
			});
		});
		expect(container.textContent).toBe("");
	});

	it("stays away while the notice a previous launch dismissed is still current", async () => {
		useUpdaterStore.setState({
			status: { state: "error", message: "GitHub release feed unreachable.", showInBanner: true },
			dismissed: { error: true },
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toBe("");
	});

	it("keeps passive polling failures out of the banner", async () => {
		useUpdaterStore.setState({
			status: { state: "error", message: "Offline", showInBanner: false },
			dismissed: {},
		});
		await mount(<UpdateBanner />);

		expect(container.textContent).toBe("");
	});
});
