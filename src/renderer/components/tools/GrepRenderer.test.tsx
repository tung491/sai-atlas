/**
 * GrepRenderer match lines go through dangerouslySetInnerHTML so the search
 * pattern can be highlighted. Matched file content is untrusted (any file in
 * the workspace), so a rendered line must show its source text verbatim and
 * the highlight may add `<mark>` elements and nothing else, whatever the
 * content or pattern holds.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { GrepRenderer } = await import("./GrepRenderer");

const HOSTILE_LINES = [
	`<img src=x onerror="alert(1)"><script>alert('xss')</script>`,
	"if (a < b && c > d) return &lt;tag&gt; &amp;",
	`<mark class="omp-hl" style="position:fixed">fake</mark></span><b>`,
];

const DISPLAY = ["## src/evil.html", ...HOSTILE_LINES.map((line, index) => ` *${index + 1}│${line}`)].join("\n");

let container: HTMLElement;
let root: Root;

async function mount(pattern: string): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<GrepRenderer
					args={{ pattern }}
					result={{ content: [{ type: "text", text: "" }], details: { displayContent: DISPLAY } }}
				/>
			</I18nProvider>,
		);
	});
}

/** The innerHTML-rendered content span of each match line. */
function contentSpans(): HTMLElement[] {
	return Array.from(container.querySelectorAll(".whitespace-pre > span"));
}

/** Content HTML with every highlight unwrapped back to its text. */
function unmarkedHtml(span: HTMLElement): string {
	const copy = span.cloneNode(true) as HTMLElement;
	for (const mark of Array.from(copy.querySelectorAll("mark"))) {
		mark.replaceWith(document.createTextNode(mark.textContent ?? "") as never);
	}
	return copy.innerHTML;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

describe("GrepRenderer hostile content", () => {
	it("renders hostile lines as inert text when there is no pattern", async () => {
		await mount("");
		const spans = contentSpans();
		expect(spans.map(span => span.textContent)).toEqual(HOSTILE_LINES);
		for (const span of spans) expect(span.querySelectorAll("*").length).toBe(0);
	});

	it.each([
		["a tag name", "img"],
		["markup", "<script>"],
		["an entity name", "lt"],
		["an escaped ampersand", "amp"],
		["the highlight markup itself", 'mark class="omp-hl"'],
	])("adds only <mark> elements when highlighting %s", async (_label, pattern) => {
		await mount("");
		const plain = contentSpans().map(span => span.innerHTML);
		await act(async () => root.unmount());
		container.remove();

		await mount(pattern);
		const spans = contentSpans();
		expect(spans.map(span => span.textContent)).toEqual(HOSTILE_LINES);
		const marks = spans.flatMap(span => Array.from(span.querySelectorAll("*")));
		for (const mark of marks) {
			expect(mark.localName).toBe("mark");
			expect(Array.from(mark.attributes, attr => `${attr.name}=${attr.value}`)).toEqual(["class=omp-hl"]);
			expect(mark.textContent?.toLowerCase()).toBe(pattern.toLowerCase());
			expect(mark.children.length).toBe(0);
		}
		expect(spans.map(unmarkedHtml)).toEqual(plain);
		// Each pattern occurs as real text in the hostile lines; "lt" and "amp"
		// also occur inside entities, where they must not be marked.
		const expected = HOSTILE_LINES.join("\n").toLowerCase().split(pattern.toLowerCase()).length - 1;
		expect(marks.length).toBe(expected);
	});
});
