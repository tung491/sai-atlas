import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assetNames, buildRelease } from "./release-feeds";

const VERSION = "1.2.3";

interface Feed {
	version: string;
	files: Array<{ url: string; sha512: string; size: number }>;
	path: string;
	sha512: string;
	releaseDate: string;
	minimumSystemVersion?: string;
}

let dir: string;

function write(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

/** A Tauri bundle tree with the bundler's own names and distinct contents per file. */
function bundles(): { linux: string } {
	const linux = path.join(dir, "linux/bundle");
	write(path.join(linux, `appimage/Sai ATLAS_${VERSION}_amd64.AppImage`), "appimage bytes");
	write(path.join(linux, `deb/Sai ATLAS_${VERSION}_amd64.deb`), "deb bytes");
	return { linux };
}

function feed(out: string, name: string): Feed {
	return parse(readFileSync(path.join(out, name), "utf8")) as Feed;
}

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "release-feeds-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("release feeds", () => {
	it("renames to the invariant asset names", async () => {
		const out = path.join(dir, "out");
		const written = await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		const names = assetNames(VERSION);
		expect(written.sort()).toEqual(
			["Sai-ATLAS-1.2.3-x86_64.AppImage", "sai-atlas_1.2.3_amd64.deb", "latest-linux.yml"].sort(),
		);
		expect(readFileSync(path.join(out, names.deb), "utf8")).toBe("deb bytes");
		expect(feed(out, "latest-linux.yml").files.map(file => file.url)).toEqual([names.appImage, names.deb]);
		expect(feed(out, "latest-linux.yml").version).toBe(VERSION);
	});

	it("writes sha512 that matches the file", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		for (const name of ["latest-linux.yml"]) {
			const document = feed(out, name);
			for (const file of document.files) {
				const bytes = readFileSync(path.join(out, file.url));
				expect(file.sha512, file.url).toBe(createHash("sha512").update(bytes).digest("base64"));
				expect(file.size, file.url).toBe(bytes.length);
			}
			expect(document.sha512).toBe(document.files[0]?.sha512);
			expect(document.path).toBe(document.files[0]?.url);
		}
		// Quoted so js-yaml keeps it a string.
		expect(readFileSync(path.join(out, "latest-linux.yml"), "utf8")).toMatch(/^releaseDate: '.+'$/m);
	});

	it("writes no minimumSystemVersion into latest-linux.yml", async () => {
		const out = path.join(dir, "out");
		await buildRelease({ version: VERSION, outDir: out, ...bundles() });
		expect(feed(out, "latest-linux.yml").minimumSystemVersion).toBeUndefined();
	});
});

describe("release feeds refuse", () => {
	const out = () => path.join(dir, "out");

	/** Give the tree's `kind` bundle the file name `name`. */
	function rename(linux: string, kind: "appimage" | "deb", name: string): void {
		const extension = kind === "deb" ? ".deb" : ".AppImage";
		renameSync(path.join(linux, kind, `Sai ATLAS_${VERSION}_amd64${extension}`), path.join(linux, kind, name));
	}

	it("a second deb beside the one being released", async () => {
		const { linux } = bundles();
		write(path.join(linux, "deb/Sai ATLAS_1.2.2_amd64.deb"), "old deb bytes");
		await expect(buildRelease({ version: VERSION, outDir: out(), linux })).rejects.toThrow(
			/expected exactly one \.deb in .*, found 2/,
		);
	});

	it("a bundle directory that does not exist", async () => {
		const { linux } = bundles();
		rmSync(path.join(linux, "appimage"), { recursive: true });
		await expect(buildRelease({ version: VERSION, outDir: out(), linux })).rejects.toThrow(/appimage does not exist/);
	});

	it("a stale bundle from another version", async () => {
		const { linux } = bundles();
		rename(linux, "deb", "Sai ATLAS_1.2.2_amd64.deb");
		await expect(buildRelease({ version: VERSION, outDir: out(), linux })).rejects.toThrow(
			/Sai ATLAS_1\.2\.2_amd64\.deb is not the 1\.2\.3 bundle/,
		);
	});

	it("a prerelease bundle whose version starts with the released one", async () => {
		for (const name of ["Sai-ATLAS-1.2.3-rc.1-x86_64.AppImage", "Sai ATLAS_1.2.3-rc.1_amd64.AppImage"]) {
			const { linux } = bundles();
			rename(linux, "appimage", name);
			await expect(buildRelease({ version: VERSION, outDir: out(), linux }), name).rejects.toThrow(
				"is not the 1.2.3 bundle",
			);
			rmSync(linux, { recursive: true });
		}
	});

	it("a v-prefixed version or bundle name", async () => {
		await expect(buildRelease({ version: `v${VERSION}`, outDir: out(), ...bundles() })).rejects.toThrow(
			"invalid version v1.2.3",
		);
		const { linux } = bundles();
		rename(linux, "deb", `Sai ATLAS_v${VERSION}_amd64.deb`);
		await expect(buildRelease({ version: VERSION, outDir: out(), linux })).rejects.toThrow("is not the 1.2.3 bundle");
	});

	it("a run given no bundles", async () => {
		await expect(buildRelease({ version: VERSION, outDir: out() })).rejects.toThrow("no bundles or feeds given");
	});
});
