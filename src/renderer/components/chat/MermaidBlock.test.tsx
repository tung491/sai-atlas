/**
 * MermaidBlock shows a diagram only as a blob `<img>` of sanitized SVG, never
 * as inline markup. sanitizeSvg is the second layer behind mermaid's strict
 * mode: it must drop the active-content vectors the brand artwork check
 * rejects (src/shared/brand-assets.test.ts), including SMIL elements that
 * retarget a link after sanitization. Mermaid itself needs a real layout
 * engine, so the component test drives the block through its renderer seam.
 */
import { resolveObjectURL } from "node:buffer";
import { DOMParser, NodeFilter, parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node, MutationObserver } = parseHTML(
	'<html data-theme="dark"><body></body></html>',
);
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	MutationObserver,
	DOMParser,
	NodeFilter,
	IS_REACT_ACT_ENVIRONMENT: true,
});
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// linkedom has no CSSOM or XMLSerializer: no theme tokens are set, and linkedom
// serializes empty SVG elements self-closed, as XMLSerializer does.
globals.getComputedStyle = () => ({ getPropertyValue: () => "" });
globals.XMLSerializer = class {
	serializeToString(node: { toString(): string }): string {
		return node.toString();
	}
};

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { MermaidBlock, sanitizeSvg } = await import("./MermaidBlock");
type MermaidRenderer = import("./MermaidBlock").MermaidRenderer;

/** Active content that must never leave sanitizeSvg, as the brand check words it. */
const ACTIVE_CONTENT = [
	/<script\b/i,
	/<!DOCTYPE\b/i,
	/<!ENTITY\b/i,
	/<set\b/i,
	/<animate/i,
	/<iframe\b/i,
	/<embed\b/i,
	/<object\b/i,
	/javascript:/i,
	/\son[a-z]+\s*=/i,
];

function activeContentIn(svg: string): string[] {
	return ACTIVE_CONTENT.filter(pattern => pattern.test(svg)).map(pattern => `matches ${pattern}`);
}

describe("sanitizeSvg", () => {
	// The brand table's remaining rows (foreignObject, <style>, external image,
	// xlink and paint-server references) are kept on purpose: mermaid lays out
	// labels with them, and the blob <img> the SVG is shown through loads no
	// external resource and runs no script.
	it.each([
		["a script", "<svg><script>alert(1)</script><g><text>A</text></g></svg>"],
		["a script inside a label", "<svg><foreignObject><div><script>alert(1)</script>A</div></foreignObject></svg>"],
		["an entity declaration", '<!DOCTYPE svg [<!ENTITY x "y">]><svg><text>A</text></svg>'],
		["an animated link", '<svg><a><set attributeName="href" to="javascript:alert(1)"/><text>A</text></a></svg>'],
		["an animated xlink", '<svg><a><animate attributeName="xlink:href" values="javascript:alert(1)"/>A</a></svg>'],
		["a motion animation", '<svg><g><animateMotion path="M0,0 L9,9" dur="1s"/>A</g></svg>'],
		["a transform animation", '<svg><g><animateTransform attributeName="transform" type="scale"/>A</g></svg>'],
		["an event handler", '<svg onload="alert(1)"><g onclick="alert(2)">A</g></svg>'],
		[
			"a javascript: link",
			'<svg><a href=" JavaScript:alert(1)">A</a><a xlink:href="javascript:alert(2)">B</a></svg>',
		],
		["embedded documents", '<svg><iframe src="https://x"></iframe><object data="x"></object><embed src="x"/>A</svg>'],
	])("drops %s and keeps the diagram", (_label, svg) => {
		const clean = sanitizeSvg(svg);
		expect(activeContentIn(svg)).not.toEqual([]);
		expect(activeContentIn(clean)).toEqual([]);
		expect(clean).toMatch(/^<svg\b/);
		expect(clean).toContain("A");
	});

	it("keeps the label layout mermaid needs", () => {
		const clean = sanitizeSvg(
			'<svg><style>.node{fill:red}</style><foreignObject><div class="label">Start</div></foreignObject><a href="#n1">x</a></svg>',
		);
		expect(clean).toContain("<style>.node{fill:red}</style>");
		expect(clean).toContain('<div class="label">Start</div>');
		expect(clean).toContain('href="#n1"');
	});

	it("rejects output without an SVG root", () => {
		expect(() => sanitizeSvg("<div>no diagram</div>")).toThrow("no SVG root");
	});
});

describe("MermaidBlock", () => {
	let container: HTMLElement;
	let root: Root;

	afterEach(async () => {
		await act(async () => root?.unmount());
		container?.remove();
	});

	it("shows hostile renderer output only as a blob <img> of the sanitized SVG", async () => {
		const hostile =
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>' +
			'<a><set attributeName="href" to="javascript:alert(3)"/><text>Start</text></a></svg>';
		const renderer: MermaidRenderer = {
			initialize: vi.fn(),
			render: vi.fn(async () => ({ svg: hostile, diagramType: "flowchart" })),
		};

		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<MermaidBlock code={"graph TD\nhostile-block-test-->B"} loadRenderer={async () => renderer} />
				</I18nProvider>,
			);
		});

		expect(renderer.render).toHaveBeenCalledTimes(1);
		expect(container.querySelector("svg")).toBeNull();
		expect(container.innerHTML).not.toContain("alert(");
		const images = container.querySelectorAll("img");
		expect(images.length).toBe(1);
		const src = images[0].getAttribute("src") ?? "";
		expect(src).toMatch(/^blob:/);

		const blob = resolveObjectURL(src);
		expect(blob?.type).toBe("image/svg+xml");
		const shown = (await blob?.text()) ?? "";
		expect(shown).toContain("<text>Start</text>");
		expect(activeContentIn(shown)).toEqual([]);
	});
});
