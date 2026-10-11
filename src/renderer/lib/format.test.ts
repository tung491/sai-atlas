/**
 * Contract test for the tool-result unwrapper (TUI-parity P0.1/P0.2). The same
 * tool result reaches renderers as a live `AgentToolResult` envelope
 * `{content:[{type:"text",text}], details:{…}}` or as hydrated history (same
 * envelope, details now preserved). Renderers must see body text + structured
 * details — never the raw JSON of the envelope itself.
 */

import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	extractImageDataUrl,
	extractImageDataUrls,
	formatShortClock,
	markHtmlMatches,
	resultDetails,
	resultText,
	sanitizeToolText,
} from "./format";

describe("formatShortClock", () => {
	it("keeps timeline labels to hour and minute", () => {
		const label = formatShortClock("2026-08-08T10:42:37+08:00");
		expect(label).toMatch(/^\d{2}:\d{2}$/);
		expect(label).not.toContain("2026");
	});
});

const liveEnvelope = {
	content: [
		{ type: "text", text: "hello output" },
		{ type: "image", data: "base64…", mimeType: "image/png" },
	],
	details: { exitCode: 0, diff: "@@ -1 +1 @@", phases: [{ name: "p" }] },
};

describe("resultText envelope unwrap", () => {
	it("unwraps the live {content,details} envelope to body text, not JSON", () => {
		expect(resultText(liveEnvelope)).toBe("hello output");
		expect(resultText(liveEnvelope)).not.toContain('"details"');
	});

	it("skips non-text content blocks (image) instead of JSON-stringifying them", () => {
		expect(
			resultText({
				content: [
					{ type: "image", data: "x" },
					{ type: "text", text: "cap" },
				],
			}),
		).toBe("cap");
	});

	it("handles a bare hydrated content array", () => {
		expect(
			resultText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});

	it("still handles plain strings / stdout envelopes", () => {
		expect(resultText("plain")).toBe("plain");
		expect(resultText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
	});
});

describe("resultDetails", () => {
	it("returns the details object from a live envelope", () => {
		expect(resultDetails(liveEnvelope)).toEqual({ exitCode: 0, diff: "@@ -1 +1 @@", phases: [{ name: "p" }] });
	});

	it("returns undefined for a bare content array or non-object", () => {
		expect(resultDetails([{ type: "text", text: "a" }])).toBeUndefined();
		expect(resultDetails("str")).toBeUndefined();
		expect(resultDetails(null)).toBeUndefined();
	});
});

describe("image result extraction", () => {
	it("collects multi-image result details without widening the legacy single-image lookup", () => {
		const result = {
			content: [{ type: "text", text: "output" }],
			details: {
				images: [
					{ type: "image", data: "first", mimeType: "image/png" },
					{ type: "image", data: "second", mimeType: "image/jpeg" },
				],
			},
		};

		expect(extractImageDataUrls(result)).toEqual(["data:image/png;base64,first", "data:image/jpeg;base64,second"]);
		expect(extractImageDataUrl(result)).toBeNull();
	});

	it("reads generate_image's untagged {data, mimeType} pairs as pictures", () => {
		// Not content blocks — `generate_image` reports the raw bytes it got back,
		// so a renderer that only understands `{type: "image"}` shows no preview.
		const result = {
			content: [{ type: "text", text: "Provider: openai\nModel: gpt-image-1\nGenerated 2 image(s):" }],
			details: {
				provider: "openai",
				imageCount: 2,
				imagePaths: ["/tmp/omp-image-1.png", "/tmp/omp-image-2.jpg"],
				images: [
					{ data: "first", mimeType: "image/png" },
					{ data: "second", mimeType: "image/jpeg" },
				],
			},
		};

		expect(extractImageDataUrls(result)).toEqual(["data:image/png;base64,first", "data:image/jpeg;base64,second"]);
	});
});

describe("sanitizeToolText", () => {
	it("strips ANSI SGR color codes down to visible text", () => {
		expect(sanitizeToolText("\x1b[31mred\x1b[0m plain")).toBe("red plain");
	});

	it("expands tabs to four spaces so they never punch holes in the layout", () => {
		expect(sanitizeToolText("a\tb")).toBe("a    b");
	});

	it("strips an OSC-8 hyperlink escape but keeps its anchor text", () => {
		expect(sanitizeToolText("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
	});

	it("handles color and tabs together", () => {
		expect(sanitizeToolText("\x1b[1m\x1b[32mgreen\ttab\x1b[0m")).toBe("green    tab");
	});
});

describe("escapeHtml", () => {
	it.each([
		["&", "&amp;"],
		["<", "&lt;"],
		[">", "&gt;"],
		['"', "&quot;"],
		["plain text 123", "plain text 123"],
	])("escapes %j as %j", (input, expected) => {
		expect(escapeHtml(input)).toBe(expected);
	});

	it("escapes & first, so existing entities print literally instead of decoding", () => {
		expect(escapeHtml("&lt;b&gt;")).toBe("&amp;lt;b&amp;gt;");
		expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
	});

	it("leaves no markup in hostile input", () => {
		const out = escapeHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>');
		expect(out).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
		expect(out).not.toMatch(/[<>"]/);
	});
});

describe("markHtmlMatches", () => {
	const mark = (text: string) => `<mark class="omp-hl">${text}</mark>`;

	it("returns the HTML untouched for an empty pattern", () => {
		expect(markHtmlMatches("a &lt; b", "")).toBe("a &lt; b");
	});

	it("marks case-insensitive literal matches, treating regex syntax as text", () => {
		expect(markHtmlMatches(escapeHtml("Foo foo f.o"), "foo")).toBe(`${mark("Foo")} ${mark("foo")} f.o`);
		expect(markHtmlMatches(escapeHtml("a.b axb"), "a.b")).toBe(`${mark("a.b")} axb`);
	});

	it.each([
		["lt", "a < b", "a &lt; b"],
		["amp", "x && y", "x &amp;&amp; y"],
		["quot", 'say "hi"', "say &quot;hi&quot;"],
	])("never matches %j inside the entities of %j", (pattern, source, escaped) => {
		expect(markHtmlMatches(escapeHtml(source), pattern)).toBe(escaped);
	});

	it("still finds the search term as real text next to an entity", () => {
		expect(markHtmlMatches(escapeHtml("alt < lt"), "lt")).toBe(`a${mark("lt")} &lt; ${mark("lt")}`);
	});

	it("matches escaped characters as whole entities", () => {
		expect(markHtmlMatches(escapeHtml("if a < b && c"), "< b &")).toBe(`if a ${mark("&lt; b &amp;")}&amp; c`);
		expect(markHtmlMatches("it&#x27;s", "'")).toBe(`it${mark("'")}s`);
	});

	it("never matches inside a highlight.js tag", () => {
		const html = '<span class="hljs-keyword">class</span> Span';
		expect(markHtmlMatches(html, "class")).toBe(`<span class="hljs-keyword">${mark("class")}</span> Span`);
		expect(markHtmlMatches(html, "span")).toBe(`<span class="hljs-keyword">class</span> ${mark("Span")}`);
	});
});
