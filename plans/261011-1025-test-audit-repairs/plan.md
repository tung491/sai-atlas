# Test audit repairs

Status: done, uncommitted (2026-10-11)
Source: `plans/reports/test-audit-261010-1321-whole-repo-test-suite-audit.md` (findings V1–V29, P1–P18, S1–S15, and the decisions recorded on 2026-10-10)

## Outcome

Every finding is repaired. Each repaired or added test fails when its target bug is reintroduced. The decisions are carried out:
- P7 gets a behavioural fix.
- S7 is fixed locally only.
- A wdio e2e job runs in CI, non-blocking at first.

Vitest, `cargo test` (both feature sets), clippy, `check:types` and the API snapshots stay green.

## Constraints

- Report-driven repairs only; add nothing beyond the findings.
- No `mock.module()`. Follow AGENTS.md conventions: i18n keys go in both `en.ts` and `vi.ts`.
- The user's uncommitted edits stay intact.
- No commits or pushes until the user asks.

## Execution

There are eleven parallel lanes. Each runs in its own git worktree, based on HEAD plus the user's uncommitted diff, with its own `CARGO_TARGET_DIR`. File ownership is disjoint, except `src-tauri/src/testing.rs`, where R3 owns the fake host (prefs, `open_url`) and R4 owns FakeOmp/FakeSidecar. The controller merges each lane's diff into the main tree and runs the full gates.

| Lane | Findings | Owned files |
|---|---|---|
| R1 updater | V1 (Rust pin), V5, V11 | `src-tauri/src/updater/*` |
| R2 webview | V3, V14 | `src-tauri/src/webview.rs` |
| R3 services and bridge | V6, V7, V10, V12, V24 | `services/{fs,system,open_path_target,ipc}.rs`, `lib.rs`, `host_tools.rs`, `bridge.rs`, `desktop/mod.rs` (guard only), `testing.rs` (fake host), `src/shared/bridge/create-omp-api.test.ts`, a new shared IPC fixture |
| R4 tabs pool | P1–P18, P7 behaviour fix | `tabs/pool.rs`, `tabs/mod.rs`, `testing.rs` (FakeOmp/FakeSidecar), `omp/test_support.rs` |
| R5 misc Rust | V2 (default-build tests), V16, V19, V26, V27, V28 (`paths.rs`) | `paths.rs`, `services/preview_watch.rs`, `omp/assistant_pack.rs`, `omp/manager.rs` (flag list test), `ports.rs`, `i18n.rs`, `test_hooks.rs` |
| C1 CI and docs | V1 (override scan), V2 (CI and pins), V4, V16 (`--no-fail-fast`), V17 (pins and docs), V18, V20 (CSP unit test), V23, V29 | `.github/workflows/ci.yml` (existing jobs), `scripts/tauri-packaging-config.test.ts`, `AGENTS.md`, `README*.md`, `scripts/sync-upstream.sh`, `tsconfig*.json`, `package.json`, `biome.json`, `scripts/build-bundled-omp.ts` |
| C2 e2e lane | V17 (the `e2e-tauri` job), V1 (smoke), V2 (smoke refusal), V3 (e2e), V14 (smoke), V20 (`csp.e2e`), V22, plan-local audit tools | `e2e-tauri/*`, `e2e/*`, `wdio*.ts`, `tsconfig.wdio.json`, the new `e2e-tauri` job in `ci.yml`, `plans/261005-0812-everyday-work-rebrand/tools/*` |
| C3 scripts | V21, V28 (pack and scripts) | `scripts/release-feeds{,.test}.ts`, `src-tauri/linux/finalize-appimage.ts`, `scripts/finalize-appimage.test.ts`, `scripts/assistant-pack{,.test}.ts`, `assistant-pack/src/*`, `assistant-pack/test/output.test.ts` |
| T1 renderer security and flakes | V8, V9, V15, V25 | `src/renderer/lib/markdown*`, `lib/format*`, `components/tools/GrepRenderer*`, `components/chat/{CodeBlock,MermaidBlock}*`, `components/chat/dock/AgentsDockCard*`, `components/layout/TabBar*` |
| T2 tabs store | S1, S2, S10 (tabs), S11, S12 (tabs), S13 (plan approval, tabs) | `stores/tabs{,.test}.ts*`, `stores/plan-approval.ts` and its callers |
| T3 other stores | S3–S9, S10 (sidebar), S12 (ui), S13 (messages), S14, S15, untested modules, V13, V28 (UpdateBanner) | `stores/*` except the T2 files, `components/common/UpdateBanner*` |

## Acceptance

- Each lane reports, per finding, the test it added or changed and the mutation it ran to prove that test turns red.
- After the merge, the main tree is green on: `bunx vitest run`, `bun run check:types`, biome on touched files, `cargo clippy --all-targets` (all features and default features), `cargo test` (both feature sets), `check-module.sh snapshots`, and the local `e2e-tauri` job command.

## Result (2026-10-11)

All eleven lanes are merged into the main working tree, and every lane reported a mutation that turns each of its tests red. The merged tree passes every acceptance gate:
- Vitest: 2232 passed, 11 skipped.
- `check:types` and `biome check .`: clean.
- clippy: clean with all features and with the default features.
- `cargo test`: 894 passed with all features, 882 with the default features.
- `check-module.sh snapshots`: PASS.
- `OMP_E2E_NO_SIDECAR=1 scripts/virtual-display.sh run -- bun run test:e2e` against the e2e-hooks debug build: 8 of 8 spec files passed.

Changes made during integration:
- `preview_unwatch_stops_further_events` failed twice while the machine was under load: its 300 ms debounce window was wall-clock time. It now runs on the virtual clock the debounce test uses, and the two share one harness. A no-op `unwatch` mutation turns it red.
- The CI pin test now covers the `e2e-tauri` job.
- AGENTS.md lists four CI jobs.
- Both READMEs list the egress and offline audits in the release build-and-inspect step.
- Review fixes (`plans/reports/code-reviewer-261011-1303-test-audit-repairs-review.md`) in `tabs/pool.rs`:
  - A background tab's `cancel` for a request its window already shows now reaches the window, and the request's route is dropped.
  - A failed health check (status Error, process still running) no longer discards held requests; only Restarting or Exited does.
  - Each fix has a test that a mutation turns red.
- Commit note: the untracked files the tracked changes need must be added explicitly: `src/shared/bridge/ipc-payload-fixtures.json`, `tsconfig.scripts.json`, `e2e-tauri/audit/**` and the new test files.

Open items:
- `packaged-smoke.e2e.ts` changes need a built `.deb` (`tauri-deb-smoke.sh`) and were not run.
- The `e2e-tauri` job's AppArmor step has not yet run on a GitHub runner.
- `SheetPreview` "reports a workbook SheetJS cannot read through onError, after render" failed once under full-suite load and passed alone 3 of 3 times. It is outside the audit.
- Other `preview_watch` tests still poll real directory watches with sleeps.
