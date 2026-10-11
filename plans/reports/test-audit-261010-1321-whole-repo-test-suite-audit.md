# Test Suite Audit — 2026-10-10 — whole repo (HEAD a46bfdf + working tree)

Report-only audit of the Vitest, Rust, Tauri e2e and CI suites, run as a best-of-5
verifier pass (`--ultra`) under advisory review (`--advice`). No repo file was
changed. The suite passes on a fresh install, but two release gates would let a
broken release through. The most urgent one affects the uncommitted update-feed
rename in the working tree.

## Test Results Overview

- **Vitest** (`SKIP_COMPILED=1 bunx vitest run`, as CI): 186 files passed, 2 skipped; 2096 tests passed, 11 skipped. The first run failed 16 files: 15 were "Cannot find package" errors from a stale local `node_modules`, which `bun install --frozen-lockfile` fixed, and the 16th was the AgentsDockCard flake (V15).
- **Rust** (`build:pack`, `build:renderer:tauri`, `cargo test --all-features`, as CI): 842 lib tests passed and 1 failed. `services::preview_watch::tests::preview_watch_fires_once_after_changes_settle` failed in 3 of 7 runs (V16). Integration targets: appimage_handover 3, channels 2, electron_relauncher 3, all passed, but only under `--no-fail-fast`. No `#[ignore]`, no doc-tests.
- **Not run in this audit:** wdio e2e, packaged/deb smoke, WM geometry check and API snapshots. They need builds, containers or a display, and none of them runs in CI either (V17).
- **Coverage:** no coverage tool is configured, so there is no line or branch percentage. The gaps below come from reading the code.

## Severity summary

Of the 76 findings the five candidates proposed (plus one from the controller), 29 survived evidence validation and deduplication. They break down as **2 Critical, 17 Important and 10 Minor**. The verifier graded V3 Critical. The advisor recommended Important, because removing the lock means deleting a line from a fixed seven-entry list and the decision functions behind the locks are unit-tested. I adopted the downgrade.

## Critical

### V1 — The release smoke's update check passes when the update check fails, and nothing pins the feed base the working tree just renamed
- **Evidence:** `e2e-tauri/packaged-smoke.e2e.ts:356` matches `/latest-linux\.yml|"state":"(not-available|available)"/`. Every feed fetch, parse and timeout error contains `FEED_FILE` = `latest-linux.yml` (`src-tauri/src/updater/feed.rs:21,78,95,98`; `updater/mod.rs:272`), and a manual check puts that message into the status (`mod.rs:252`). `feed.rs:14` `GITHUB_RELEASE_BASE` was changed from `oh-my-pi-gui` to `sai-atlas` in an **uncommitted** edit, and its only test is `feed.rs:211` `starts_with("http")`. `scripts/tauri-packaging-config.test.ts:306-318` scans for a stray `SAI_ATLAS_UPDATE_BASE` but not in `scripts/tauri-linux-build.sh`, which forwards that variable into the container.
- **Slipped regression:** a wrong repo name, an `http://` base or a leaked override yields "latest-linux.yml could not be fetched (404)". The smoke stays green, and every installed copy of that release never sees another update.
- **Repair:** in Rust, assert `release_base() == "https://github.com/tung491/sai-atlas/releases"` when no override is set, and require `https://`. Make the smoke accept only `"state":"(not-available|available)"`, with an explicit, logged skip when offline. Add `tauri-linux-build.sh` to the override scan. **Repair risk:** the smoke needs network access, and the "no Linux metadata" case has to move to a fixture feed.

### V2 — CI builds, lints and tests only `--all-features`, so the default-feature crate that ships is never tested
- **Evidence:** `.github/workflows/ci.yml:104-105`. `src-tauri/Cargo.toml:12-14` has `default = []` and the comment "e2e-hooks: Never enabled by a bundle". `src-tauri/src/test_hooks.rs:233-244` `no_test_hook_is_registered_without_e2e_hooks` is compiled out of every CI run. The "absent" branch of `bridge.rs:1383-1392` never executes. The release-only `OMP_BUNDLED_OMP` gating (`paths.rs:217-222`) is never compiled by CI. `scripts/check-module.sh:193-195` runs both feature sets, but CI only calls its `snapshots` gate. `tauri-packaging-config.test.ts:294-304` never reads `Cargo.toml`.
- **Slipped regression:** `default = ["e2e-hooks"]`, or a `test:fault` registration moved out of its `cfg`, passes every gate. The release would then expose `test:*` channels and let an environment variable swap the sidecar.
- **Repair:** add default-feature `cargo test` and `cargo clippy --all-targets -D warnings` steps, then update the CI pin in `tauri-packaging-config.test.ts` and in AGENTS.md. Add a default-build test that `resolve_bundled_omp` ignores `OMP_BUNDLED_OMP`, and a packaged-smoke case that expects `test:emit` to be refused. **Repair risk:** one more Rust test build per CI run, mostly absorbed by the cache.

## Important

| ID | Finding | Key evidence | Repair |
|---|---|---|---|
| V3 | The webview security-plan test compares `security_calls()` with itself; the navigation lock, new-window lock and download handler have no test at any level | `src-tauri/src/webview.rs:834-838`; locks only at `:118-124`, `:278-313`; `desktop.e2e.ts:636-644` calls the pure probe | Assert a literal seven-entry vector; e2e that sets `location.href`/`window.open` and asserts the URL is unchanged plus a "blocked navigation" log entry |
| V4 | The release sidecar's privacy contract (local-only models, MCP off, `--no-context-files`) is never checked against the binary that ships | `assistant-pack/test/compiled.test.ts:13,56`; `ci.yml:26-28,48-50`; `sync-upstream.sh:53-66` checks the host `resources/omp`; neither README release step 5 nor 6 runs `check-assistant-pack.ts` | Make `bun scripts/check-assistant-pack.ts resources/omp.linux-x64` a release step, or have `build-bundled-omp.ts` run it on its output |
| V5 | AppImage apply and install-on-quit re-verify SHA-512, but no test proves it (only the deb has tamper tests) | `updater/mod.rs:486,497`; tamper tests only at `install.rs:436-443`, `mod.rs:1146-1158` | Mirror the deb tamper test for the AppImage on `updater:apply` and `shutdown()` |
| V6 | The `system:open-path` launcher refusal has no Linux-launcher, mixed-case or dispatch test; the deleted `launchable-path.test.ts` table was not ported | `services/open_path_target.rs:9-43`, tests `:139-162`; `services/system.rs:185-188`, `:323-333` | Rust table over every deny entry in mixed case; dispatch test with `x.desktop` that expects `reveal_in_folder` |
| V7 | `refuses_images_above_the_cap` never exceeds the cap; the three `fs:read-image` refusals and the `fs:read`/`fs:list`/`fs:read-plan` refusals are never dispatched | `services/fs.rs:369-381`; `services/ipc.rs:368-369,409-412,466-468,491-525` | `dispatch_for_test` cases: over-cap file, PEM/text file, `../` path, plan outside both roots; negative sniff cases |
| V8 | No negative-vector tests for the markdown sanitizer (`<script>`, `<iframe>`, `style=`, `javascript:` links) and no test for link-click routing | `src/renderer/lib/markdown.tsx:58-192`; `tauri.conf.json:16` allows `style-src 'unsafe-inline'` | Table-driven hostile-markdown test; linkedom click test for `ExternalLink` |
| V9 | `escapeHtml`, the only guard on two `dangerouslySetInnerHTML` sinks, is untested, and so are the sinks | `lib/format.ts:175-177`; `tools/GrepRenderer.tsx:136-147`; `chat/CodeBlock.tsx:101-116` | Unit-test `escapeHtml`; render both components with hostile content and assert that only `<mark>` elements are added |
| V10 | Production guards are tested only through fakes that copy them: the `open_url` guard, `prefs:set` main-owned keys at dispatch level (the real rule is unit-tested), and `gui_open_url` | `lib.rs:184-190` vs `testing.rs:123-131`; `testing.rs:627-629`; `services/ipc.rs:835-845`; `host_tools.rs:55-63` | Have the fake delegate to `shortcut_core`; dispatch `prefs:set` for `ollamaContextFit.models`; one shared URL guard; assert the `open_url(` call |
| V11 | Updater asset names are percent-decoded from the feed and joined onto the download directory with no containment and no negative test | `updater/state.rs:79-89`; `feed.rs:130-143`; `mod.rs:313-316,386` | Reject `/`, `\`, NUL, `..` and absolute names; add `%2F`/`..%2F`/`%00` cases |
| V12 | `resolve_within` is never tested with a sibling that shares the root's prefix, an absolute path or an empty path; no main-window → `quick-entry:submit` scope test | `services/fs.rs:146-164`, tests `:332-337`; `bridge.rs:947-949,1275-1284` | Add `../two-secrets/x`, `/etc/passwd`, `""` cases and a `wrong_scope` case |
| V13 | The updater store's "dismiss per version" test cannot fail; the banner's `available`/`downloading` states are never rendered | `src/renderer/stores/updater.test.ts:51-58`; `UpdateBanner.tsx:30-31` | Banner render tests across versions; delete the tautology |
| V14 | The WebKit permission policy (audio only) has no test at any level | `webview.rs:686-692`; `fake-mic.probe.ts:119-121` checks only the allow path and is not in CI | Extract the decision into a pure function with a matrix test; smoke check that `getUserMedia({video:true})` is rejected |
| V15 | Two renderer tests race a 25 ms real-timer window (one failure observed in a full-suite run) | `chat/dock/AgentsDockCard.test.tsx:242-263`; `layout/TabBar.test.tsx:684-699` | Assert "not yet" over a long window and test the cadence separately |
| V16 | `preview_watch_fires_once_after_changes_settle` depends on timing; in CI a failure also hides the integration targets (no `--no-fail-fast`) | `services/preview_watch.rs:452-464`; `ci.yml:105` | Inject a clock into `run_worker`; add `--no-fail-fast` |
| V17 | No wdio e2e lane runs in CI, so the only runtime checks of the CSP, navigation, sandbox, single-instance and deep links never run automatically. Keeping e2e local is a documented trade-off | `ci.yml` (no wdio step); `vite.tauri.config.ts:11-17` strips the meta CSP; egress/offline tools live under `plans/261005-0812-everyday-work-rebrand/tools/` | A non-blocking xvfb job running `csp` + `desktop`; move the audit tools into `e2e-tauri/` |
| V18 | `check:protocol` is not run anywhere: not in CI, not in `sync-upstream.sh`, not in the release checklist | `package.json:22`; `scripts/check-protocol.ts`; `sync-upstream.sh:60-66` | Add it to sync step 6 and to the release checklist |
| V19 | The pack's spawn flags exist as three hand-copied lists, and the privacy check validates the TS copy rather than the one the app spawns with | `omp/assistant_pack.rs:66-91,309-329`; `manager.rs:1099-1117`; `scripts/assistant-pack.test.ts:55-72` | A Rust test that parses the TS flag list, as `ts_removed_env` already does for `REMOVED_ENV` |

## Minor

- **V20:** the CSP test pins three directives (`tauri-packaging-config.test.ts:243-251`), and `csp.e2e.ts:20-28` counts an offline fetch failure as a pass. Assert the full parsed policy instead.
- **V21:** the `release-feeds` refusal paths and the appimagetool sha256 pin have no failing-case tests, and a substring version match accepts `-rc` bundles (`scripts/release-feeds.ts:58-69,97,120`; `src-tauri/linux/finalize-appimage.ts:200-222`).
- **V22:** the legacy-core case in `e2e-tauri/runtime.e2e.ts:100-128` is permanently gated and targets removed surfaces (`/share`, "Refresh preview").
- **V23:** `scripts/*.ts` and `src-tauri/linux/*.ts` are never type-checked (`tsconfig.json:21`), and biome and `lint-surfaces` are not run in CI.
- **V24:** renderer→Rust IPC payload shapes are asserted as separate hand-written literals (`create-omp-api.test.ts:259-273` vs `services/ipc.rs:220-228`).
- **V25:** `MermaidBlock`'s `sanitizeSvg` is untested and misses `<set>`/`<animate>` href retargeting (`MermaidBlock.tsx:50-79`). The SVG renders through a blob `<img>`, so the impact is low.
- **V26:** the cross-module-calls contract test matches `fn <name>(` anywhere in `ports.rs` (`ports.rs:838-847`).
- **V27:** the Rust shell strings lost their en/vi mirror and placeholder checks in `1e13b8c` (`i18n.rs:197-221`).
- **V28:** macOS-era leftovers: a Finder/DMG assertion in `UpdateBanner.test.tsx:50-58`, `paths.rs:408-413` `/Users/me/work`, `assistant-pack/test/output.test.ts:67-71`, and the `out/main` fixture in `scripts/assistant-pack.test.ts:98-99`.
- **V29:** redundant work: the assistant-pack unit tests run twice in CI (`ci.yml:26` and `:48`), and the deb round-trip is built in two test files.

## Checked and cleared

- The `|| true` calls in `scripts/check-module.sh:123,125,165` are followed by an explicit `fail`, so they mask nothing.
- `performance.e2e.ts:14` is a documented opt-in audit.
- Skipping the compiled-sidecar tests in CI is a documented trade-off; it is reported only as a CI blind spot inside V4.
- The TS2504 error that two candidates reported at `check-assistant-pack.ts:218` did not reproduce with Bun types.
- The ollama context-fit write path is well covered (`context_fit_store.rs`, `context_fit_scheduler.rs`, `manager.rs:1513-1556`). Its one gap is the dispatch case in V10.

## Suite trustworthiness

Unit-level contracts are broadly well tested and assertion-rich. No test is skipped without a reason, none is empty, and no module is mocked against the project rules. The weaknesses are concentrated at the edges: two release gates that cannot fail (V1, V2), security controls whose wiring has no test even though the decision logic does (V3, V5–V9, V11, V12, V14), and two timing flakes that teach people to ignore red CI (V15, V16).

## Recommended repair order (if fixes are authorized)

1. **Release gates (V1, V2, V4).** Pin the feed base before the uncommitted rename is committed; that is the top risk. For each gate, prove it turns red by reverting the rename, setting `default = ["e2e-hooks"]`, or skipping patch 0003.
2. **CI stability (V15, V16).** Fix these before adding tests, so new tests land on a green baseline.
3. **Security contracts (V3, V5–V9, V11, V12, V14).** Write each test to fail first, then mutate the guard locally to confirm it turns red.
4. **Ineffective tests (V10, V13, V19, V24, V26).**
5. **Hygiene (V17, V18, V20–V23, V25, V27–V29).**

## Method

Five independent read-only candidates (Opus) audited the whole repo from one evidence packet. A verifier then re-opened every cited line and returned the evidence-validated, deduplicated union. The controller re-verified V1–V3 against the source, and the kongming advisor gave a go decision, adjusted V3 and V10, and spot-checked the context-fit path. Verifier scores (1–20 for evidence, impact, severity and repair) are not reproduced here.

ultra: union=29/76 single_candidate_only=5

## Follow-up — 2026-10-10 13:31–14:05: `tabs/pool.rs` and the renderer stores

This section closes the first unresolved question. Two focused auditors read every test and production line in `src-tauri/src/tabs/pool.rs` and in `src/renderer/stores/` (17 test files, 23 modules). Each claim was then checked by mutation: one-line production edits made in disposable worktrees at HEAD, after which the tests were rerun. A mutation **survives** when the tests stay green with the edit in place. The main tree was never edited.

The results are 33 more findings: 19 Important and 14 Minor. One of them, S7, is a confirmed production defect rather than only a test gap. The headline across both passes is now **2 Critical, 36 Important and 24 Minor**.

### Mutation results

| Area | Suite run per mutation | Survived | Killed |
|---|---|---|---|
| `tabs/pool.rs` | `cargo test --all-features --lib tabs::` (84 tests, green before mutation) | 34 of 35 | P15 only, and only because the worktree, like CI, has no `resources/omp`; locally the assertion compares a value with itself |
| Renderer stores | `SKIP_COMPILED=1 bunx vitest run src` (1792 tests) | 28 of 29 (the MRU-clock one only sometimes) | the kind-mismatch toast removal, and only in the current test order (S11) |

### Confirmed defect

- **S7 — input history keeps `--token=` secrets.** The scrub at `src/renderer/stores/input-history.ts:83` matches only `/--token\s/`. The composer records the typed text whether or not the command succeeds (`use-composer-submit.ts:261,312,325,373`). So `/mcp add … --token=<secret>` is written in plain JSON to the `inputHistory` prefs file, even though the agent rejects that form as an unknown option. Upstream's TUI guard (`input-controller.ts:118`) has the same regex. The fix is one character, `/--token(\s|=)/`, plus test cases for `--token=` and a tab. This is graded Important rather than Critical because a successful `mcp add` already stores the bearer token in `mcp.json` in the same profile.

### Important

| ID | Finding | Evidence | Repair |
|---|---|---|---|
| P1 | Nothing tests the sidecar cap reservation. Deleting the reserve, the release-on-drop or the `+ reserved` term each survives | `pool.rs:598,617,1110`; the only cap test, `:1719-1733`, runs sequentially | FakeOmp `on_new_sidecar` hook: a re-entrant acquire must be refused, and a panicking spawn must give its slot back |
| P2 | The health check cannot fail. The comment at `:2239` claims a check the harness never runs; `if true` at `:1124` and `ready = true` at `:701` survive | `pool.rs:2212-2245` | With `install` called: a Ready event gives exactly one `get_state` and no `mark_unhealthy`; other events send nothing |
| P3 | Closing the focused pane of a split hands focus to the first tab, not the visible one; the mutation survives | `pool.rs:319-321`; test `:1490-1493` | With tabs a, b, c split b\|c, close c and expect b to be active and wired |
| P4 | Closing a window could spawn its sleeping tabs; removing the guard survives | `pool.rs:316-318` | Restore three sleeping tabs, close the window, assert no `start()` |
| P5 | The compacting flag is never cleared after a crash. Both mutations survive, which would block rename/delete for good and make the quit guard always report work | `pool.rs:396-399,800-801` | Start a compaction, then Restarting, then Ready: assert `compacting` is `None` |
| P6 | Repeating the same sessionId drops the session's owner; the mutation survives | `pool.rs:452` | Send a title frame that repeats the id and assert the owner is kept |
| P7 | Extension UI, host URI and host tool requests are not shown to be held back from background tabs; all three gates survive | `pool.rs:467-469,478-480,720` | Raise each request from a background tab and assert nothing is forwarded |
| P8 | Seven of the eight pass-through channels and the session-info forward are never shown to arrive; channel swaps survive | `pool.rs:462-464,486-493` | Table test over (event, channel) for the active and a background tab |
| P9 | Only the final layout snapshot is asserted, so a missing publish after a tab switch, session change or acquire survives | `pool.rs:676,855,915`; test `:1637-1661` | Assert one publish per step |
| P10 | The idle-session command's not-Ready refusal and delivery-failure mapping are untested; with `success:true`, `sessions:delete` would remove a file a live sidecar holds | `pool.rs:778,807-810` | Three cases: still Starting, a Timeout error, an unowned path |
| S1 | Split-pane store tests pass through the error path, because the mock bridge has no `tabs.setView` (controller-verified) | `tabs.test.tsx:96-102`; `tabs.ts:110-117,322-329` | Add `setView` to `MockOmp` and assert the split survives, no error toast. Do this first: it may change other test outcomes |
| S2 | Restoring a split from main, clamping the ratio, debouncing ratio changes and the owner-tab branch of `openTab` are untested; four mutations survive | `tabs.ts:126,314,400,565` | Reconcile, fake-timer and `ownerTabId` tests |
| S3 | A stale model-catalog generation is never shown to be dropped | `model.ts:105` | Generation 5 push, then a generation 3 reply: expect the generation 5 list |
| S4 | The live tool-streaming path (argument deltas, partial results) has no test | `tools.ts:205,273` | Event-sequence test |
| S5 | Thinking accumulation, `lastAppended` on `agent_end` (used by voice auto-speak) and the broken-prefix merge guard are unpinned | `messages.ts:151,175,222` | Three focused cases |
| S6 | Settings sync covers 7 of 12 mapped keys; approval-mode validation, the stale-reply guard and the `reset()` version bumps are unpinned; `pasteMenuThreshold` accepts NaN | `settings.ts:97,99,128,162,200-201` | Table derived from the maps, an invalid-value case, an overlapping-reply case |
| S9 | The closed-runtime guard is masked by the origin check, and `:147` asserts a value the test set itself | `tab-runtime.test.ts:128-151`; `tab-runtime.ts:67` | Close a tab that has no sessionId; assert `rpc_delivery_unknown` |
| S15 | The extension-ui `cancel` branch is untested, so a timed-out extension dialog would stay open | `extension-ui.ts:36-38` | Reducer test: push, then cancel, expect the request removed |

### Minor

- **P11:** the fake disposes the sidecar as soon as `dispose()` is called, so nothing checks that the shutdown future it returns is ever run, and dropping it survives (`pool.rs:572,1064`; `testing.rs:302-307`).
- **P12:** pushes that change nothing are not tested (`:429,913`).
- **P13:** two `set_tab_view` refusals are untested: a focused tab that is not visible, and a split naming the same tab twice (`:826,833`).
- **P14:** only `confirm` is tested of the six blocking UI methods (`:57`).
- **P15:** the binary-path test computes its expected value with the same expression as the code under test (`:2207-2208`).
- **P16:** the route-cleanup test is masked by a stale-key fallback (`:293`).
- **P17:** nothing checks that `dispose_all` keeps tab keys unique (`:1060`).
- **P18:** Electron/TS-port wording and dead file citations.
- **Also untested in the pool:** closing the first pane of a split, the window fallback, restore suppression, and the restore-active fallback. All four mutations survive.
- **S8:** the caps on input history (200), recent sessions (500) and the toast stack (8) are never exercised.
- **S10:** the sidebar MRU test uses the wall clock, so the result is nondeterministic (11 of 15 runs killed the mutation). Some tabs tests count microtasks before asserting. The pool tests' `settle()` yields exactly 8 times, which caps how much work an "event did not arrive" assertion can wait for.
- **S11:** `resetAll` never clears toasts, so the error-toast assertion at `tabs.test.tsx:430` depends on test order.
- **S12:** some assertions can never fail: the deprecated `bundles` field (`tabs.test.tsx:724`), the keymap hydrate check that asserts the value the test itself set (`ui-keymap.test.ts:53-55`), and the redundant `ui-panel-tab.test.ts`.
- **S13:** some tests cover code with no production caller: plan approval (`showProposal`, `settleTabPlanApproval`, removed in f19d74c) and `messages.snapshot/restoreSnapshot`. Some tests still use macOS paths.
- **S14:** subagent progress frames, toast dismiss, updater re-arm after `available`/`downloaded`, and `model.reset` clearing `lastLocal` are unpinned. Also untested: `subagent-graph.ts` owner registration (nested subagents lose their parent link) and the empty-name normalisation in `session.ts:111`.

### Where these go in the repair order

- **Batch 2 (CI stability):** S10, S11 and the `settle()` cap.
- **Batch 3 (security and integrity):** S7, P6, P7, P10, S15, and the approval-mode half of S6.
- **Batch 4 (ineffective tests):** S1 first. Then P1–P5, P9, P15, P16, S2–S5, S9, S12 and the sync-table half of S6. Build the FakeOmp hook once, for P1, and reuse it for P2.
- **Batch 5 (hygiene):** P11–P14, P17, P18, S8, S13 and S14.

## Decisions — 2026-10-10 14:32

The user answered the open questions:

- **P7 is a product defect, not intended behaviour.** When a background tab's blocking request is dropped, the sidecar waits indefinitely. The repair now changes behaviour as well as adding a test. Either hold the request until the tab becomes visible, or answer it with a cancel so the sidecar can move on. Then test both the background-tab gating and the request's resolution. P7 moves to batch 3.
- **S7 gets a local fix only.** The `--token=` scrub is fixed in this repo; nothing is raised upstream.
- **V17 is accepted: the wdio e2e specs get a CI job.** It is feasible on a clean clone. The specs drive the `e2e-hooks` debug build (`cargo tauri build --debug --features e2e-hooks --no-bundle`) against the scripted sidecar `e2e/sidecar-fixture.ts` (`e2e-tauri/session.ts:28-30,137`), so no compiled `omp` is needed. The job needs:
  - WebKitWebDriver from Ubuntu's `webkit2gtk-driver`, at `/usr/bin/WebKitWebDriver`;
  - `tauri-driver` installed via `cargo install` under the pinned `CARGO_HOME_BIN`;
  - a virtual X display.

  Two specs stay out of the job. `real-core.e2e.ts` needs the real `resources/omp`, and `packaged-smoke.e2e.ts` is already excluded by `wdio.conf.ts:202`. Once the job is green, the CI pin in `tauri-packaging-config.test.ts:562-570` and AGENTS.md have to name it. The job lands as non-blocking first and becomes blocking once it is stable.

## Unresolved Questions

None.
