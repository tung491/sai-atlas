/**
 * Tauri packaging contract: the identity, sandbox, sidecar placement, update
 * feeds and installer hooks every Tauri bundle must keep.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { OLLAMA_REMEDY_COMMANDS } from "../src/shared/ollama-types";
import { APP_ID, PRODUCT_NAME } from "../src/shared/product";
import { BUNDLED_GSTREAMER_PLUGINS } from "../src-tauri/linux/finalize-appimage";
import {
	COMPAT_SYMLINKS,
	DEB_DEPENDS,
	DEB_RECOMMENDS,
	DESKTOP_ENTRY_ID,
	TRAY_ALTERNATION,
	TRAY_DEPENDENCY,
	WEBKIT_DEPENDENCY,
	WEBKIT_REQUIREMENT,
} from "../src-tauri/linux/finalize-deb";
import { assetNames } from "./release-feeds";
import { SIDECAR_SOURCES, stagedSidecarPath } from "./stage-tauri-sidecar";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = path.join(ROOT, "src-tauri");

type Json = Record<string, unknown>;

interface TauriConfig {
	productName?: string;
	identifier?: string;
	mainBinaryName?: string;
	version?: string;
	build?: { features?: string[] };
	app?: {
		enableGTKAppId?: boolean;
		withGlobalTauri?: boolean;
		security?: { csp?: string; dangerousDisableAssetCspModification?: boolean | string[] };
	};
	plugins?: { "deep-link"?: { desktop?: { schemes?: string[] }; mobile?: unknown[] } };
	bundle?: {
		active?: boolean;
		category?: string;
		targets?: string[];
		externalBin?: string[];
		resources?: Record<string, string> | string[];
		linux?: {
			appimage?: { bundleMediaFramework?: boolean };
			deb?: {
				depends?: string[];
				recommends?: string[];
				desktopTemplate?: string;
				files?: Record<string, string>;
			};
		};
	};
}

function readJson<T = Json>(relative: string): T {
	return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8")) as T;
}

const base = (): TauriConfig => readJson("src-tauri/tauri.conf.json");
const platform = (): TauriConfig => readJson("src-tauri/tauri.linux.conf.json");
const overlay = (): TauriConfig => readJson("src-tauri/linux/sidecar.conf.json");

/** RFC 7396 merge, as tauri-cli applies the platform file and then each `--config` overlay. */
function merge(target: Json, patch: Json): Json {
	const out: Json = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else if (
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof out[key] === "object" &&
			!Array.isArray(out[key])
		) {
			out[key] = merge(out[key] as Json, value as Json);
		} else out[key] = value;
	}
	return out;
}

/** The configuration the `package:tauri:linux` build bundles with. */
function bundled(): TauriConfig {
	return merge(merge(base() as Json, platform() as Json), overlay() as Json) as TauriConfig;
}

const scripts = (): Record<string, string> => readJson<{ scripts: Record<string, string> }>("package.json").scripts;
const packageScripts = () => Object.entries(scripts()).filter(([name]) => name.startsWith("package:tauri:"));

function filesUnder(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}

/** Every packaging input: both configs and every file under linux/, the overlay included. */
function packagingFiles(): string[] {
	return [
		...["tauri.conf.json", "tauri.linux.conf.json"].map(name => path.join(TAURI, name)),
		...filesUnder(path.join(TAURI, "linux")),
	];
}

/** The deb's (and, through the shared data tree, the AppImage's) desktop entry template. */
function desktopTemplate(): string {
	const template = platform().bundle?.linux?.deb?.desktopTemplate;
	if (!template) throw new Error("tauri.linux.conf.json sets no bundle.linux.deb.desktopTemplate");
	return fs.readFileSync(path.join(TAURI, template), "utf8");
}

describe("product identity", () => {
	it("names the product and app id the core uses", () => {
		expect(base().identifier).toBe(APP_ID);
		expect(base().identifier).toBe("vn.io.vif.saiatlas");
		expect(base().productName).toBe(PRODUCT_NAME);
		expect(base().productName).toBe("Sai ATLAS");
		// The version comes from package.json, which the release bumps.
		expect(base().version).toBe("../package.json");
	});

	it("keeps the crate version equal to package.json's", () => {
		// Runtime-log lines written before the Tauri context exists (helper modes,
		// the install child) report the crate version, so the release bumps both.
		const cargo = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
		const crateVersion = cargo.match(/^\[package\]\n(?:[^[\n].*\n|\n)*?version = "([^"]+)"$/m)?.[1];
		expect(crateVersion).toBe(readJson<{ version: string }>("package.json").version);
	});

	it("leaves the profile path to package.json name", () => {
		// src-tauri/src/paths.rs (PROFILE_DIR_SEGMENTS) keeps the directory every 0.9.x
		// release derived from this name; a productName or a rename would move it.
		const pkg = readJson<{ name?: string; productName?: string }>("package.json");
		expect(pkg.name).toBe("@oh-my-pi/omp-gui");
		expect(pkg.productName).toBeUndefined();
	});

	it("registers the omp deep-link scheme", () => {
		expect(base().plugins?.["deep-link"]?.desktop?.schemes).toEqual(["omp"]);
		expect(base().plugins?.["deep-link"]?.mobile).toEqual([]);
		expect(desktopTemplate()).toMatch(/^MimeType=x-scheme-handler\/omp;$/m);
	});

	it("names the Linux binary and package sai-atlas", () => {
		expect(base().mainBinaryName).toBe("sai-atlas");
		// tauri-bundler writes `Package:` as the kebab-cased product name.
		expect(PRODUCT_NAME.toLowerCase().replace(/\s+/g, "-")).toBe("sai-atlas");
		expect(desktopTemplate()).toMatch(/^Exec=sai-atlas %U$/m);
	});

	it("enableGTKAppId is true", () => {
		expect(base().app?.enableGTKAppId).toBe(true);
	});

	it("the desktop template sets StartupWMClass to the identifier", () => {
		const template = desktopTemplate();
		expect(platform().bundle?.linux?.deb?.desktopTemplate).toBe("linux/vn.io.vif.saiatlas.desktop");
		expect(template).toMatch(new RegExp(`^StartupWMClass=${APP_ID.replaceAll(".", "\\.")}$`, "m"));
		expect(template).toMatch(/^Name=Sai ATLAS$/m);
		expect(template.match(/^\[Desktop Entry\]$/gm)).toHaveLength(1);
	});

	it("bundles the AppImage and deb and names the asset files the updaters look for", () => {
		expect(base().bundle?.active).toBe(true);
		expect(platform().bundle?.targets).toEqual(["appimage", "deb"]);
		expect(assetNames("1.0.0")).toEqual({
			appImage: "Sai-ATLAS-1.0.0-x86_64.AppImage",
			deb: "sai-atlas_1.0.0_amd64.deb",
		});
	});
});

describe("sidecar placement", () => {
	it("the Linux config ships the sidecar as the omp resource and sets no externalBin", () => {
		// Installs as /usr/lib/Sai ATLAS/omp (deb) and $APPDIR/usr/lib/Sai ATLAS/omp
		// (AppImage), where paths::resolve_bundled_omp looks, never on PATH. The
		// assistant pack sits beside it, where the manager looks for it; the
		// trailing slashes copy the directory tree (a glob key flattens the skill folders).
		expect(bundled().bundle?.resources).toEqual({
			"binaries/omp-x86_64-unknown-linux-gnu": "omp",
			"../resources/assistant-pack/": "assistant-pack/",
		});
		expect(bundled().bundle?.externalBin).toBeUndefined();
		expect(stagedSidecarPath("x86_64-unknown-linux-gnu")).toBe("src-tauri/binaries/omp-x86_64-unknown-linux-gnu");
	});

	it("tauri.conf.json and the platform configs declare no externalBin or resources, so cargo builds never need a staged sidecar", () => {
		// tauri-build copies both at compile time and fails when the file is missing.
		for (const config of [base(), platform()]) {
			expect(config.bundle?.externalBin).toBeUndefined();
			expect(config.bundle?.resources).toBeUndefined();
		}
	});

	it("every package:tauri script stages the matching triple and passes the matching overlay", () => {
		const expected: Record<string, [string, string]> = {
			"package:tauri:linux": ["x86_64-unknown-linux-gnu", "src-tauri/linux/sidecar.conf.json"],
		};
		expect(
			packageScripts()
				.map(([name]) => name)
				.sort(),
		).toEqual(Object.keys(expected).sort());
		for (const [name, [triple, overlayPath]] of Object.entries(expected)) {
			const script = scripts()[name] ?? "";
			expect(script, name).toContain(`bun scripts/stage-tauri-sidecar.ts ${triple} &&`);
			expect(script, name).toContain(`cargo tauri build --target ${triple} --config ${overlayPath}`);
			expect(script, name).toContain("source scripts/rust-pins.env");
			expect(SIDECAR_SOURCES[triple], name).toBeDefined();
		}
	});
});

describe("renderer security", () => {
	function metaCsp(page: string): string {
		const html = fs.readFileSync(path.join(ROOT, "src/renderer", page), "utf8");
		const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
		if (!content) throw new Error(`${page} declares no Content-Security-Policy`);
		return content;
	}

	/** The policy as directive → sources, refusing a directive declared twice (the browser ignores the second). */
	function parseCsp(policy: string): Record<string, string[]> {
		const parsed: Record<string, string[]> = {};
		for (const part of policy.split(";")) {
			const [directive, ...sources] = part.trim().split(/\s+/);
			if (!directive) continue;
			if (directive in parsed) throw new Error(`CSP declares ${directive} twice`);
			parsed[directive] = sources;
		}
		return parsed;
	}

	// Every directive is pinned: img-src is explicit, not inherited, because without it the policy
	// falls back to default-src and a later relaxation there would let markdown a model wrote fetch a
	// remote image; script-src and connect-src keep script execution and network calls inside the app.
	const EXPECTED_CSP = {
		"default-src": ["'self'"],
		"script-src": ["'self'"],
		"style-src": ["'self'", "'unsafe-inline'"],
		"font-src": ["'self'", "data:"],
		"img-src": ["'self'", "data:", "blob:"],
		"media-src": ["'self'", "blob:"],
		"connect-src": ["'self'"],
		"worker-src": ["'self'", "blob:"],
	};

	it("CSP policy equals the meta CSP in src/renderer/index.html", () => {
		expect(base().app?.security?.csp).toBe(metaCsp("index.html"));
	});

	it("the main page's policy is exactly the pinned one", () => {
		expect(parseCsp(metaCsp("index.html"))).toEqual(EXPECTED_CSP);
		expect(parseCsp(base().app?.security?.csp ?? "")).toEqual(EXPECTED_CSP);
	});

	it("the quick-entry page ships the same content security policy", () => {
		expect(parseCsp(metaCsp("quick-entry.html"))).toEqual(EXPECTED_CSP);
		expect(metaCsp("quick-entry.html")).toBe(metaCsp("index.html"));
	});

	it("only style-src skips asset CSP modification", () => {
		expect(base().app?.security?.dangerousDisableAssetCspModification).toEqual(["style-src"]);
	});

	it("withGlobalTauri is false", () => {
		expect(base().app?.withGlobalTauri).toBe(false);
	});

	it("capabilities grant only the omp bridge commands", () => {
		const capabilities = fs.readdirSync(path.join(TAURI, "capabilities")).sort();
		expect(capabilities).toEqual(["main.json", "quick-entry.json"]);
		const main = readJson<{ windows: string[]; permissions: string[] }>("src-tauri/capabilities/main.json");
		expect(main.windows).toEqual(["main-*"]);
		expect(main.permissions).toEqual(["allow-omp-invoke", "allow-omp-attach"]);
	});

	it("the quick-entry capability grants only its commands", () => {
		const quick = readJson<{ windows: string[]; permissions: string[] }>("src-tauri/capabilities/quick-entry.json");
		expect(quick.windows).toEqual(["quick-entry"]);
		expect(quick.permissions).toEqual(["allow-omp-quick-entry-invoke", "allow-omp-attach"]);
	});

	it("keeps the Linux renderer sandboxed: no --no-sandbox anywhere in packaging", () => {
		for (const file of packagingFiles()) {
			expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toContain("--no-sandbox");
		}
		for (const [name, script] of packageScripts()) expect(script, name).not.toContain("--no-sandbox");
	});

	it("no bundle or package script enables e2e-hooks", () => {
		expect(bundled().build?.features ?? []).not.toContain("e2e-hooks");
		for (const file of packagingFiles()) {
			expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toContain("e2e-hooks");
		}
		for (const [name, script] of Object.entries(scripts())) {
			if (/tauri build|cargo tauri|package/.test(script) || name.startsWith("package")) {
				expect(script, name).not.toContain("e2e-hooks");
			}
		}
	});

	it("the crate enables no feature by default, so a bundle never carries the test hooks", () => {
		const cargo = fs.readFileSync(path.join(TAURI, "Cargo.toml"), "utf8");
		const features = /^\[features\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo)?.[1];
		expect(features, "Cargo.toml has a [features] table").toBeDefined();
		const list = /^default\s*=\s*\[([^\]]*)\]/m.exec(features ?? "")?.[1];
		expect(list, "[features] declares default").toBeDefined();
		const entries = (list ?? "")
			.split("\n")
			.map(line => line.replace(/#.*/, ""))
			.join("")
			.split(",")
			.map(entry => entry.trim())
			.filter(Boolean);
		expect(entries).toEqual([]);
	});

	it("no package or release script sets SAI_ATLAS_UPDATE_BASE", () => {
		for (const [name, script] of Object.entries(scripts()))
			expect(script, name).not.toContain("SAI_ATLAS_UPDATE_BASE");
		for (const file of [
			...packagingFiles(),
			path.join(ROOT, "scripts/release-feeds.ts"),
			path.join(ROOT, "scripts/stage-tauri-sidecar.ts"),
			path.join(ROOT, "scripts/tauri-linux-build/Dockerfile"),
			path.join(ROOT, ".github/workflows/ci.yml"),
		]) {
			expect(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toContain("SAI_ATLAS_UPDATE_BASE");
		}
	});

	it("the Docker package build only forwards a SAI_ATLAS_UPDATE_BASE the caller exported, and the release steps keep it unset", () => {
		// `-e NAME` with no value copies the caller's variable into the container and sets nothing
		// when it is unset, so the release build reads this repository's feed unless someone exported
		// an override; the release instructions are what keep it unset.
		const code = fs
			.readFileSync(path.join(ROOT, "scripts/tauri-linux-build.sh"), "utf8")
			.split("\n")
			.filter(line => !line.trimStart().startsWith("#"));
		expect(code.filter(line => line.includes("SAI_ATLAS_UPDATE_BASE"))).toEqual([
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a bash parameter expansion, matched literally
			"[[ -n ${SAI_ATLAS_UPDATE_BASE-} ]] && env_args+=(-e SAI_ATLAS_UPDATE_BASE)",
		]);
		const docs: Record<string, string> = {
			"README.md": "run `bun run package:linux` with `SAI_ATLAS_UPDATE_BASE` unset",
			"README.vi.md": "chạy `bun run package:linux` khi chưa đặt `SAI_ATLAS_UPDATE_BASE`",
			"AGENTS.md": "build with `bun run package:linux` and `SAI_ATLAS_UPDATE_BASE` unset",
		};
		for (const [file, step] of Object.entries(docs)) {
			expect(fs.readFileSync(path.join(ROOT, file), "utf8"), file).toContain(step);
		}
	});
});

describe("Linux package", () => {
	const depends = () => platform().bundle?.linux?.deb?.depends ?? [];
	const recommends = () => platform().bundle?.linux?.deb?.recommends ?? [];

	it("deb control names the maintainer, homepage and description of the Electron package", () => {
		// The bundler writes Maintainer from bundle.publisher (Cargo.toml has no authors),
		// Homepage from bundle.homepage and Description from the descriptions.
		const bundle = platform().bundle as TauriConfig["bundle"] & {
			publisher?: string;
			homepage?: string;
			shortDescription?: string;
			longDescription?: string;
		};
		const description = readJson<{ description: string }>("package.json").description;
		expect(bundle?.publisher).toBe("Tung Son Do <dosontung007@gmail.com>");
		expect(bundle?.homepage).toBe("https://github.com/tung491/sai-atlas");
		expect(bundle?.shortDescription).toBe(description);
		expect(bundle?.longDescription).toBe(description);
	});

	it("describes the app as an everyday-work assistant filed under productivity", () => {
		expect(readJson<{ description: string }>("package.json").description).toBe(
			"Sai ATLAS, the private AI assistant for everyday work on SAI OS",
		);
		expect(base().bundle?.category).toBe("Productivity");
	});

	it("deb depends only on what the app cannot start without", () => {
		// The 0.9.x Electron updater installs this package with dpkg -i and then
		// apt-get install -f -y, which removes it when a dependency cannot be installed,
		// so every hard dependency is a way to lose the app. WebKit treats a missing bwrap
		// as fatal once its web-process sandbox is on, and needs xdg-dbus-proxy for it.
		// The bundler appends the tray's appindicator, libwebkit2gtk-4.1-0 and libgtk-3-0
		// itself, so listing them here would duplicate them; finalize-deb versions WebKitGTK.
		expect(depends()).toEqual(["bubblewrap", "xdg-dbus-proxy"]);
		expect([...depends(), TRAY_DEPENDENCY, "libwebkit2gtk-4.1-0", "libgtk-3-0"].join(", ")).toBe(
			DEB_DEPENDS.replace(TRAY_ALTERNATION, TRAY_DEPENDENCY).replace(WEBKIT_REQUIREMENT, WEBKIT_DEPENDENCY),
		);
	});

	it("deb only recommends what the app runs without", () => {
		// dpkg -i and apt-get install -f ignore Recommends, so a missing one never blocks
		// or undoes an update. Without desktop-file-utils and xdg-utils the deep-link plugin
		// logs a failed omp:// registration (upgraders keep the handler 0.9.x registered);
		// without gstreamer1.0-plugins-good dictation reports a failure (WebKit depends on it
		// on Ubuntu anyway); gstreamer1.0-pipewire is unused by WebKit's capture.
		// libglib2.0-bin ships gio: the assistant's open_item tool runs `gio launch` to open an app.
		expect(recommends()).toEqual([
			"desktop-file-utils",
			"xdg-utils",
			"gstreamer1.0-plugins-good",
			"gstreamer1.0-pipewire",
			"libglib2.0-bin",
		]);
		expect(recommends().join(", ")).toBe(DEB_RECOMMENDS);
	});

	it("deb names the tray library as an alternation of the two appindicator packages", () => {
		// The tray's loader opens libayatana-appindicator3 or libappindicator3, and panics
		// when neither loads, so it stays a hard dependency; Ubuntu's Ayatana package conflicts
		// with libappindicator3-1, which a 0.9.x install may carry, so a single package would
		// force a swap during the update.
		expect(TRAY_ALTERNATION).toBe("libayatana-appindicator3-1 | libappindicator3-1");
		expect(DEB_DEPENDS).toBe(
			"bubblewrap, xdg-dbus-proxy, libayatana-appindicator3-1 | libappindicator3-1, libwebkit2gtk-4.1-0 (>= 2.52), libgtk-3-0",
		);
	});

	it("deb requires WebKitGTK 2.52 for the pdf.js modern build", () => {
		// The bundled pdf.js calls Map.prototype.getOrInsertComputed (first in WebKitGTK 2.52),
		// Math.sumPrecise and Uint8Array.fromBase64 without polyfills. Ubuntu 24.04 noble-updates
		// ships 2.52, so an updated noble satisfies it.
		expect(WEBKIT_REQUIREMENT).toBe("libwebkit2gtk-4.1-0 (>= 2.52)");
		expect(DEB_DEPENDS.split(", ")).toContain(WEBKIT_REQUIREMENT);
		expect(DEB_DEPENDS.split(", ")).not.toContain(WEBKIT_DEPENDENCY);
	});

	it("deb does not depend on gstreamer1.0-plugins-bad", () => {
		// Dictation captures PCM through WebAudio; MediaRecorder stays unused.
		expect([...depends(), ...recommends()]).not.toContain("gstreamer1.0-plugins-bad");
	});

	it("marks the deb install so the updater picks the dpkg path", () => {
		const files = platform().bundle?.linux?.deb?.files ?? {};
		expect(files["/usr/lib/Sai ATLAS/package-type"]).toBe("linux/package-type");
		expect(fs.readFileSync(path.join(TAURI, "linux/package-type"), "utf8").trim()).toBe("deb");
	});

	it("deb turns off Ollama's online features with the same drop-in the welcome screen writes", () => {
		// A vendor drop-in applies to the ollama.service the official installer writes to /etc once systemd
		// reloads (a reboot; the package runs no script); one in /etc with the same name (the welcome
		// screen's) overrides it with the same content.
		const files = platform().bundle?.linux?.deb?.files ?? {};
		expect(files["/usr/lib/systemd/system/ollama.service.d/sai-atlas.conf"]).toBe("linux/ollama-no-cloud.conf");
		const dropIn = fs.readFileSync(path.join(TAURI, "linux/ollama-no-cloud.conf"), "utf8");
		expect(dropIn).toBe('[Service]\nEnvironment="OLLAMA_NO_CLOUD=1"\n');
		for (const command of Object.values(OLLAMA_REMEDY_COMMANDS)) {
			expect(command).toContain(`s=$(printf '${dropIn.trimEnd().replace("\n", "\\n")}')`);
			expect(command).toContain("/etc/systemd/system/ollama.service.d/sai-atlas.conf");
		}
	});

	it("deb ships the /opt compat symlink and one desktop entry named after the app id", () => {
		// The 0.9.x Electron deb updater relaunches /opt/Sai ATLAS/sai-atlas after dpkg -i.
		expect(COMPAT_SYMLINKS).toEqual({ "opt/Sai ATLAS/sai-atlas": "/usr/bin/sai-atlas" });
		expect(DESKTOP_ENTRY_ID).toBe("vn.io.vif.saiatlas.desktop");
		expect(scripts()["package:tauri:linux"]).toMatch(
			/ && bun src-tauri\/linux\/finalize-deb\.ts src-tauri\/target\/x86_64-unknown-linux-gnu\/release\/bundle\/deb( && |$)/,
		);
		// finalize-deb.test.ts round-trips a package laid out the way tauri-bundler writes one.
	});

	it("the AppImage is finished last so its bundled WebKit finds the host's bwrap and xdg-dbus-proxy", () => {
		// tauri-bundler relocates every /usr in the bundled libwebkit2gtk; without the finalize
		// step the always-on web-process sandbox fails to start from the AppImage.
		expect(scripts()["package:tauri:linux"]).toMatch(
			/ && bun src-tauri\/linux\/finalize-deb\.ts \S+ && bun src-tauri\/linux\/finalize-appimage\.ts src-tauri\/target\/x86_64-unknown-linux-gnu\/release\/bundle\/appimage$/,
		);
	});

	it("the AppImage bundles the GStreamer plugins the build image stages, and only those", () => {
		// Without bundleMediaFramework the AppImage carries the GStreamer core but no plugins, and
		// the host's plugins cannot load into it: no microphone capture and no audio playback.
		expect(bundled().bundle?.linux?.appimage?.bundleMediaFramework).toBe(true);
		const build = fs.readFileSync(path.join(ROOT, "scripts", "tauri-linux-build.sh"), "utf8");
		const staged = build.match(/-e GSTREAMER_PLUGINS_DIR=(\S+)\)/)?.[1];
		expect(staged).toBe("/opt/sai-atlas/gstreamer-1.0");
		const dockerfile = fs.readFileSync(path.join(ROOT, "scripts", "tauri-linux-build", "Dockerfile"), "utf8");
		expect(dockerfile).toContain(`mkdir -p ${staged}`);
		const loop = dockerfile.match(/for plugin in ([\s\S]*?); do/)?.[1] ?? "";
		const plugins = loop
			.split(/[\s\\]+/)
			.filter(Boolean)
			.map(name => `libgst${name}.so`);
		expect(plugins.sort()).toEqual([...BUNDLED_GSTREAMER_PLUGINS].sort());
	});

	it("no AppArmor profile is bundled", () => {
		// Ubuntu 26.04's bwrap-userns-restrict profile already allows bubblewrap.
		for (const file of packagingFiles()) {
			expect(path.basename(file).toLowerCase(), path.relative(ROOT, file)).not.toContain("apparmor");
			expect(fs.readFileSync(file, "utf8").toLowerCase(), path.relative(ROOT, file)).not.toContain("apparmor.d");
		}
	});
});

describe("no macOS or Windows build", () => {
	it("no macOS or Windows build config remains", () => {
		// Linux is the only target: no installer config, overlay or package script may bring another back.
		for (const file of [
			"src-tauri/tauri.windows.conf.json",
			"src-tauri/windows",
			"src-tauri/tauri.macos.conf.json",
			"src-tauri/macos",
			"src-tauri/Info.plist",
		]) {
			expect(fs.existsSync(path.join(ROOT, file)), file).toBe(false);
		}
		expect(Object.keys(scripts()).filter(name => /mac|win/.test(name))).toEqual([]);
	});

	it("the sidecar build and staging scripts name no windows target", () => {
		expect(Object.keys(SIDECAR_SOURCES).filter(triple => triple.includes("windows"))).toEqual([]);
		for (const triple of Object.keys(SIDECAR_SOURCES)) expect(stagedSidecarPath(triple)).not.toMatch(/\.exe$/);
		for (const file of ["scripts/stage-tauri-sidecar.ts", "scripts/build-bundled-omp.ts"]) {
			const source = fs.readFileSync(path.join(ROOT, file), "utf8");
			expect(source, file).not.toMatch(/windows|win32|\.exe\b/i);
		}
	});
});

describe("release sidecar checks", () => {
	it("the sidecar build checks the RPC protocol before it compiles", () => {
		// The sync's step 5 and the release's sidecar build both run build-bundled-omp.ts, so
		// this is where a GUI/agent protocol mismatch stops a sync or a release.
		const source = fs.readFileSync(path.join(ROOT, "scripts/build-bundled-omp.ts"), "utf8");
		const check = source.indexOf('await runPackageScript(guiRoot, "check:protocol");');
		expect(check).toBeGreaterThan(-1);
		expect(check).toBeLessThan(source.indexOf("await compileCodingAgent("));
		expect(scripts()["check:protocol"]).toBe("bun scripts/check-protocol.ts");
	});

	it("the release steps run the privacy check on the release sidecar before packaging it", () => {
		for (const readme of ["README.md", "README.vi.md"]) {
			const text = fs.readFileSync(path.join(ROOT, readme), "utf8");
			const build = text.indexOf("`bun run build:omp:linux` ");
			const check = text.indexOf("`bun scripts/check-assistant-pack.ts resources/omp.linux-x64`");
			const pack = text.indexOf("`bun run package:linux` ", build);
			expect(build, readme).toBeGreaterThan(-1);
			expect(check, readme).toBeGreaterThan(build);
			expect(pack, readme).toBeGreaterThan(check);
		}
	});
});

describe("Linux CI workflow", () => {
	const workflows = path.join(ROOT, ".github", "workflows");
	interface Workflow {
		jobs?: Record<
			string,
			{
				"runs-on"?: string;
				env?: Record<string, string>;
				steps?: { run?: string; uses?: string; with?: Record<string, string | boolean> }[];
			}
		>;
	}

	it("type-checks, lints, tests and builds a clean clone on ubuntu-latest", () => {
		const ci = parseYaml(fs.readFileSync(path.join(workflows, "ci.yml"), "utf8")) as Workflow;
		const job = ci.jobs?.linux;
		expect(job?.["runs-on"]).toBe("ubuntu-latest");
		expect(job?.steps?.flatMap(step => (step.run ? [step.run] : []))).toEqual([
			"bun install --frozen-lockfile",
			"bun run check:types",
			"bunx biome check .",
			"bunx vitest run",
			"bun run build",
		]);
		// check:types covers the build and release scripts too, with Bun's types.
		expect(scripts()["check:types"].split(" && ")).toContain("tsc --noEmit -p tsconfig.scripts.json");
		expect(readJson<{ include: string[] }>("tsconfig.scripts.json").include).toEqual([
			"scripts/*.ts",
			"src-tauri/linux/*.ts",
		]);
		// Actions are pinned to full commit SHAs, and the checkout token is not left on disk.
		const uses = job?.steps?.flatMap(step => (step.uses ? [step.uses] : [])) ?? [];
		expect(uses).toHaveLength(2);
		for (const action of uses) expect(action).toMatch(/^(actions\/checkout|oven-sh\/setup-bun)@[0-9a-f]{40}$/);
		const checkout = job?.steps?.find(step => step.uses?.startsWith("actions/checkout@"));
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		const setupBun = job?.steps?.find(step => step.uses?.startsWith("oven-sh/setup-bun@"));
		expect(setupBun?.with?.["bun-version"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("leaves Pages deployment to the Pages workflow alone", () => {
		const publishers = fs
			.readdirSync(workflows)
			.filter(name => fs.readFileSync(path.join(workflows, name), "utf8").includes("actions/deploy-pages"));
		expect(publishers).toEqual(["pages.yml"]);
	});
});

describe("e2e CI job", () => {
	interface Job {
		"runs-on"?: string;
		"continue-on-error"?: boolean;
		env?: Record<string, string>;
		steps?: { run?: string; uses?: string; env?: Record<string, string> }[];
	}

	it("runs the wdio specs against the e2e-hooks build on a virtual display, without the compiled sidecar", () => {
		const ci = parseYaml(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
			jobs?: Record<string, Job>;
		};
		const job = ci.jobs?.["e2e-tauri"];
		expect(job?.["runs-on"]).toBe("ubuntu-latest");
		// Non-blocking until the job proves stable on the runners.
		expect(job?.["continue-on-error"]).toBe(true);
		expect(job?.env?.CARGO_HOME_BIN).toBe("/home/runner/.cargo/bin");
		const runs = job?.steps?.flatMap(step => (step.run ? [step.run] : [])) ?? [];
		// The binary the specs launch (e2e-tauri/session.ts imports wdio, so read its source).
		const buildCommand = /export const BUILD_COMMAND = "([^"]+)"/.exec(
			fs.readFileSync(path.join(ROOT, "e2e-tauri/session.ts"), "utf8"),
		)?.[1];
		expect(buildCommand).toBeDefined();
		for (const command of [
			"bun install --frozen-lockfile",
			"bun run build:pack",
			"bun run build:renderer:tauri",
			buildCommand,
			"scripts/virtual-display.sh run -- bun run test:e2e",
			"scripts/virtual-display.sh stop",
		]) {
			expect(runs).toContain(command);
		}
		// A clean clone has no resources/omp: the specs that launch it stay out.
		const specs = job?.steps?.find(step => step.run === "scripts/virtual-display.sh run -- bun run test:e2e");
		expect(specs?.env?.OMP_E2E_NO_SIDECAR).toBe("1");
		expect(runs.join("\n")).toMatch(/webkit2gtk-driver/);
		expect(runs.join("\n")).toMatch(/cargo install tauri-driver --locked/);
		for (const action of job?.steps?.flatMap(step => (step.uses ? [step.uses] : [])) ?? [])
			expect(action).toMatch(/@[0-9a-f]{40}$/);
	});
});

describe("Tauri CI job", () => {
	interface Job {
		"runs-on"?: string;
		env?: Record<string, string>;
		steps?: { run?: string; uses?: string; with?: Record<string, string | boolean | number> }[];
	}

	it("builds, lints and tests the Rust core and checks the API snapshots with pinned actions", () => {
		const ci = parseYaml(fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
			jobs?: Record<string, Job>;
		};
		const job = ci.jobs?.["tauri-linux"];
		expect(job?.["runs-on"]).toBe("ubuntu-latest");
		expect(job?.env?.CARGO_HOME_BIN).toBe("/home/runner/.cargo/bin");
		const runs = job?.steps?.flatMap(step => (step.run ? [step.run] : [])) ?? [];
		for (const command of [
			"bun install --frozen-lockfile",
			"bun run build:renderer:tauri",
			// Both feature sets: all features compile the e2e hooks in, the default set is what ships.
			"cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings",
			"cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
			// --no-fail-fast, so a failing lib test still lets the integration targets run.
			"cargo test --manifest-path src-tauri/Cargo.toml --all-features --no-fail-fast",
			"cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast",
			"bash scripts/check-module.sh snapshots",
		]) {
			expect(runs).toContain(command);
		}
		for (const command of runs.filter(run => run.startsWith("cargo test")))
			expect(command).toContain("--no-fail-fast");
		expect(runs.join("\n")).not.toContain("check-test-parity");
		// Diff-based ownership gates need a merge base and fail by design once the
		// cross-module work lands on main, so CI runs only whole-tree checks.
		for (const command of runs) expect(command).not.toContain("merge-base");
		const setup = runs.join("\n");
		for (const needle of [
			"bubblewrap",
			"xdg-dbus-proxy",
			"source scripts/rust-pins.env",
			"$PUBLIC_API_TOOLCHAIN",
			"$CARGO_PUBLIC_API_VERSION",
			'tauri-cli --version "^2" --locked',
		]) {
			expect(setup).toContain(needle);
		}
		const uses = job?.steps?.flatMap(step => (step.uses ? [step.uses] : [])) ?? [];
		for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
		expect(job?.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(
			false,
		);
	});
});
