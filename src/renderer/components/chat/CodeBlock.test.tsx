/**
 * CodeBlock renders code through dangerouslySetInnerHTML: escaped plain text
 * past the highlight cap, highlight.js markup below it, and an optional search
 * pattern wrapped in `<mark>`. Code is untrusted (model output, file content),
 * so the block must show the source verbatim, and a pattern may add `<mark>`
 * elements and nothing else: no markup from the code, and no match that
 * splits a highlight.js tag or an escaped entity.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { CodeBlock } = await import("./CodeBlock");
const { HIGHLIGHT_CHAR_CAP, loadHljs } = await import("../../lib/highlight");

const HOSTILE = [
	`<img src=x onerror="alert(1)"><script>alert('xss')</script>`,
	"if (a < b && c > d) return &lt;tag&gt; &amp;",
	`<mark class="omp-hl" style="position:fixed">fake</mark></span><b>`,
].join("\n");
/** Past the highlight cap, so the block renders escaped plain text. */
const HOSTILE_OVER_CAP = `${HOSTILE}\n${"x".repeat(HIGHLIGHT_CHAR_CAP)}`;

let container: HTMLElement;
let root: Root;

async function mount(code: string, highlightPattern?: string): Promise<HTMLElement> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CodeBlock code={code} language="html" highlightPattern={highlightPattern} />
			</I18nProvider>,
		);
	});
	const element = container.querySelector("pre > code");
	if (!element) throw new Error("code element not rendered");
	return element as HTMLElement;
}

async function unmount(): Promise<void> {
	await act(async () => root.unmount());
	container.remove();
}

/** Code HTML with every highlight unwrapped back to its text. */
function unmarkedHtml(code: HTMLElement): string {
	const copy = code.cloneNode(true) as HTMLElement;
	for (const mark of Array.from(copy.querySelectorAll("mark"))) {
		mark.replaceWith(document.createTextNode(mark.textContent ?? "") as never);
	}
	return copy.innerHTML;
}

function expectOnlyMarksAdded(code: HTMLElement, baseline: string, pattern: string): Element[] {
	const marks = Array.from(code.querySelectorAll("mark"));
	for (const mark of marks) {
		expect(Array.from(mark.attributes, attr => `${attr.name}=${attr.value}`)).toEqual(["class=omp-hl"]);
		expect(mark.textContent?.toLowerCase()).toBe(pattern.toLowerCase());
		expect(mark.children.length).toBe(0);
	}
	expect(unmarkedHtml(code)).toBe(baseline);
	return marks;
}

function occurrences(text: string, pattern: string): number {
	return text.toLowerCase().split(pattern.toLowerCase()).length - 1;
}

afterEach(async () => {
	if (container?.isConnected) await unmount();
});

describe("CodeBlock hostile content, escaped plain text", () => {
	it("shows the code verbatim with no elements", async () => {
		const code = await mount(HOSTILE_OVER_CAP);
		expect(code.textContent).toBe(HOSTILE_OVER_CAP);
		expect(code.querySelectorAll("*").length).toBe(0);
	});

	it.each(["img", "<script>", "lt", "amp", 'mark class="omp-hl"'])(
		"adds only <mark> elements for %j",
		async pattern => {
			const baseline = (await mount(HOSTILE_OVER_CAP)).innerHTML;
			await unmount();

			const code = await mount(HOSTILE_OVER_CAP, pattern);
			expect(code.textContent).toBe(HOSTILE_OVER_CAP);
			const marks = expectOnlyMarksAdded(code, baseline, pattern);
			expect(marks.length).toBe(occurrences(HOSTILE_OVER_CAP, pattern));
		},
	);
});

describe("CodeBlock hostile content, highlight.js markup", () => {
	beforeAll(async () => {
		// Loaded up front so the block highlights synchronously on first render.
		await loadHljs();
	});

	it("shows the code verbatim through highlight.js spans only", async () => {
		const code = await mount(HOSTILE);
		expect(code.textContent).toBe(HOSTILE);
		const elements = Array.from(code.querySelectorAll("*"));
		expect(elements.length).toBeGreaterThan(0);
		for (const element of elements) {
			expect(element.localName).toBe("span");
			expect(element.getAttribute("class")).toMatch(/^(?:hljs|language)-[\w-]+(?: [\w-]+)*$/);
		}
	});

	it.each(["lt", "amp", "class", "hljs", "span"])("adds only <mark> elements for %j", async pattern => {
		const baseline = (await mount(HOSTILE)).innerHTML;
		await unmount();

		const code = await mount(HOSTILE, pattern);
		expect(code.textContent).toBe(HOSTILE);
		const marks = expectOnlyMarksAdded(code, baseline, pattern);
		// A match split across highlight.js tokens stays unmarked, so the count
		// is bounded by, not equal to, the occurrences in the source.
		expect(marks.length).toBeLessThanOrEqual(occurrences(HOSTILE, pattern));
	});
});
