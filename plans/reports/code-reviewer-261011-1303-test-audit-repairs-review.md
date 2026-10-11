# Code Review: production changes in the test-audit repairs

Date: 2026-10-11 (Asia/Seoul). Scope: the uncommitted working tree of `tung491/sai-atlas` against `HEAD` (45fc40d), production hunks only. Excluded as the user's own edits: AGENTS.md, README*.md, scripts/build-bundled-omp.ts, site/index.html, desktop/menu.rs, the feed URL rename in updater/feed.rs, tauri.linux.conf.json. No suites were re-run; the gates were reported green.

## Verdict

No Critical or High defects. The held-request rework in `tabs/pool.rs` has no leak, double delivery, deadlock or lock held across an await, and requests from before a restart do not survive it. The security hunks are equivalent to the old code or stricter. There is one commit-hygiene blocker (untracked files that tracked code depends on) and two Low gaps in the new held-request code.

## Findings (most severe first)

### 1. Medium: tracked code depends on untracked files, so `git add -u` breaks CI
- `src-tauri/src/services/ipc.rs` (tests): `include_str!("../../../src/shared/bridge/ipc-payload-fixtures.json")`. `src/shared/bridge/create-omp-api.test.ts:6` imports the same file. The file is untracked (`??`).
- `package.json` `check:types` now runs `tsc --noEmit -p tsconfig.scripts.json`. `tsconfig.scripts.json` is untracked.
- The deleted `plans/261005-0812-everyday-work-rebrand/tools/**` now live only in the untracked `e2e-tauri/audit/**`. New test files are untracked too: CodeBlock, MermaidBlock, GrepRenderer, markdown-links, extension-ui, session-runtime-context, session and subagent-graph.
- Failure: a commit made with `git commit -a` or `git add -u` leaves `cargo test` unable to compile (the `include_str!` target is missing), and `check:types` and vitest fail in CI. The audit scripts also disappear from history.
- Fix: `git add` these paths explicitly in the same commit, then confirm with `git status --short | grep '^??'`, which should list only the planning and report files you mean to leave out.

### 2. Low: a background `cancel` for a request that was already forwarded is dropped, which leaves a stale dialog and route
- `src-tauri/src/tabs/pool.rs:352-356` (`raise_request`). When the tab is not `full_wired`, a `cancel` only filters `entry.held` and returns. If the target was forwarded while the tab was visible, nothing reaches the renderer and `request_owners[targetId]` is never removed.
- Scenario: tab A shows a `confirm` that has a timeout, and the user switches to tab B. The sidecar times out and emits `{method:"cancel", targetId}`. The core drops it. Back on A, the dialog is still shown (the renderer keeps it in A's per-tab store). Answering it sends a response for an id the agent stopped waiting on, and the route entry lives until the tab closes.
- This was already true before the diff, but this branch was rewritten to handle background cancels and still misses this case. The renderer can take the cancel for a hidden tab: `pushTabExtensionUiRequest` leads to `applyExtensionUiRequest`, which filters out `targetId` (`src/renderer/stores/extension-ui.ts`).
- Fix: when no held request matched the target, forward the cancel (`out.send(win_id, CHANNEL_EXTENSION_UI, {tabId, request})`). In both paths, `request_owners.remove(targetId)` when the owner is this entry's key.

### 3. Low: `mark_unhealthy` clears held requests without answering them while the process is still alive
- `src-tauri/src/tabs/pool.rs:502-506` clears `entry.held` on any status other than Ready. `SidecarStatus::Error` also comes from `mark_unhealthy` (`omp/manager.rs:1028`, called by the ready health check, `pool.rs:1218/1221`), which does not kill the child.
- Scenario: a background, non-deferred tab raises a blocking UI request within the 8 s health-check window, then `get_state` fails or times out. The held request is discarded and the live agent blocks on it with no answer. Requests raised after the Error status are still held and forwarded, which is inconsistent. This is a narrow window, so the severity is Low.
- Fix: replace `entry.held.clear()` with `entry.cancel_held()`. `send_side_channel` does nothing when there is no child, and an unknown id is harmless to a new process. Alternatively, clear only on `Restarting`/`Exited`.

## Verified clean (evidence)
- **pool.rs**
  - Held requests move out with `mem::take` before they are forwarded, so nothing is delivered twice.
  - `release_entry` and `dispose_all` call `cancel_held` before `dispose`.
  - Host tool calls run after the state lock is released (`with_state`, lines 663-665). `call_host_tool` re-reads the entry and returns early if it is gone.
  - No await happens under the lock.
  - `send_side_channel` takes only the manager's lock, and the manager emits events after releasing it (`set_status`), so there is no lock-order inversion.
  - Every path that changes `visible_by_window` or `active_by_window` reaches `sync_full_wiring`. The one exception is a closing window, which releases everything.
- **plan-approval removal:** at HEAD, nothing in production called `showProposal`, `settleTabPlanApproval` or `clearPendingPlanProposal` (`git grep HEAD`), so the feature was dead. No references remain. `MessagesSnapshot`, `snapshot()`, `restoreSnapshot` and `bundles` have no production callers left.
- **markHtmlMatches** (`src/renderer/lib/format.ts`)
  - Entities are decoded in a single pass, so `&amp;lt;` becomes `&lt;` and is not decoded twice.
  - Every text run is re-escaped, and tags pass through unchanged from trusted hljs or escapeHtml output.
  - The five decoded entities match hljs v11 `escapeHTML` plus the local `escapeHtml`.
  - `highlightedHtml` has no production producer.
- **MermaidBlock:** matching is case-insensitive on `localName`, which covers `animateMotion` and `animateTransform`. The output still renders only through a blob `<img>` (line 187).
- **webview.rs:** `permission_allowed` is equivalent to the old match: audio without video is allowed and everything else is denied.
- **system.rs and lib.rs:** `host_open_url_target` is the same check, now shared with `FakeHost`.
- **Updater:** `release_file_name` has one caller (`select_asset`). `is_plain_file_name` rejects separators, NUL, `..` and empty names. A rejected name does not hide a valid one.
- **release-feeds.ts:** the expected name `${PRODUCT_NAME}_${version}_amd64${ext}` matches tauri-bundler 2.10.1 (`debian.rs:60`, `appimage/linuxdeploy.rs:88`: product name, version, and `amd64` for x86_64, for both formats).
- **finalize-appimage.ts:** the sha256 is still checked on both the cached path and the download path when `fetch` is injected.
- **preview_watch:** with `SystemClock`, `run_worker` behaves exactly as before.
- **Settings and input history:** the `pasteMenuThreshold` guard and the `--token=` redaction are correct.
- **assistant-pack:** with Linux the only target, removing the darwin branch changes nothing.
- **wdio and CI:** `SIDECAR_SPECS` is excluded only when `OMP_E2E_NO_SIDECAR=1`. The audit specs under `e2e-tauri/audit/` are outside the `./e2e-tauri/*.e2e.ts` glob, and their relative paths resolve from the new location.

## Unresolved questions
- Neither `host_tool_cancel` nor `host_uri_cancel` is routed (both arrive as `SidecarEvent::Frame`), so a held host tool call or URI request that the agent withdraws would still run when the tab is shown. In this tree it appears dormant: `setHostTools` has no production caller and the renderer never subscribes `onHostUriRequest`. I could not confirm whether the sidecar advertises the `gui_*` tools by itself, because there is no monorepo or sidecar binary on this host.
- A blocking request held in a background tab sends no signal to the sidebar or `tab:status`, so a background agent can wait unseen. Before the change it hung the same way. Should a later change add a status flag that a request is waiting?
