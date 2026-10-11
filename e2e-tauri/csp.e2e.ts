/**
 * Tauri-only: the Content-Security-Policy reaches the renderer. Only the
 * embedded-assets build counts here. `bun run dev:tauri` serves the page from
 * Vite, outside the Tauri protocol that adds the header, and
 * `vite.tauri.config.ts` strips the meta CSP, so a dev run has no CSP at all.
 *
 * Each case waits for the policy's own `securitypolicyviolation` report, so a
 * request that fails for another reason (no network on the runner) never
 * passes for a blocked one.
 */
import { browser, expect } from "@wdio/globals";
import { awaitBridge } from "./session";

interface Violation {
	effectiveDirective: string;
	blockedURI: string;
}

type Probe = "fetch" | "img";

interface ProbeResult {
	violation: Violation | null;
	/** Whether the request itself failed in the page (a fetch rejection, an image error). */
	failed: boolean;
}

/** Make one cross-origin request of the given kind and report the first violation it raises. */
async function probe(kind: Probe, url: string): Promise<ProbeResult> {
	return await browser.execute(
		(kind: Probe, url: string) =>
			new Promise<ProbeResult>(resolve => {
				let violation: Violation | null = null;
				let failed: boolean | null = null;
				const timer = setTimeout(() => finish(), 5_000);
				const finish = () => {
					clearTimeout(timer);
					document.removeEventListener("securitypolicyviolation", onViolation);
					resolve({ violation, failed: failed ?? false });
				};
				const settle = () => {
					if (violation && failed !== null) finish();
				};
				const onViolation = (event: SecurityPolicyViolationEvent) => {
					if (event.blockedURI !== url || violation) return;
					violation = { effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI };
					settle();
				};
				document.addEventListener("securitypolicyviolation", onViolation);
				if (kind === "fetch") {
					fetch(url).then(
						() => {
							failed = false;
							settle();
						},
						() => {
							failed = true;
							settle();
						},
					);
				} else {
					const image = document.createElement("img");
					image.onerror = () => {
						failed = true;
						image.remove();
						settle();
					};
					image.onload = () => {
						failed = false;
						image.remove();
						settle();
					};
					image.src = url;
					document.body.appendChild(image);
				}
			}),
		kind,
		url,
	);
}

describe("content security policy", () => {
	before(async () => {
		// The policy is a property of the page; the sidecar plays no part.
		await awaitBridge(browser);
	});

	it("connect-src refuses a cross-origin fetch", async () => {
		const url = "https://example.com/";
		const result = await probe("fetch", url);
		expect(result.violation).toEqual({ effectiveDirective: "connect-src", blockedURI: url });
		expect(result.failed).toBe(true);
	});

	it("img-src refuses a cross-origin image", async () => {
		const url = "https://example.com/x.png";
		const result = await probe("img", url);
		expect(result.violation).toEqual({ effectiveDirective: "img-src", blockedURI: url });
		expect(result.failed).toBe(true);
	});
});
