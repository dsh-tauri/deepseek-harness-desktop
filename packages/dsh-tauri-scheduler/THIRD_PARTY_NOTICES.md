# Third-party notices

## MichengAI/dsh-automation

- Repository: <https://github.com/MichengAI/dsh-automation>
- Version: `0.1.42`
- Revision: `e75499e55d0b8bfe85e04ba5a579080b54edff56`
- Baseline adopted: `f1bc91a3437f0b952631a46a8363089587b9ae6a` (`v0.1.32`)
- Baseline follow-up: `c426c3d` (`v0.1.35`, DSH `0.1.5-rc.1` host compatibility)
- Source: `source/dsh-automation`
- License: Apache-2.0 — Copyright 2026 MichengAI contributors
- Adapted: the scheduled-task panel; the submodule pointer is independent of the adopted baseline.

Adapted files:

- `src/host/service/executor.ts` — upstream `src/executor.ts`, `executeAutomationRun`
- `src/host/service/permission-presets.ts`
- `src/host/service/options.ts`
- `src/host/types/index.ts`
- `src/client/components/menu.tsx`, `src/client/components/menu.cssr.ts`
- `src/client/components/model-picker.tsx`, `src/client/components/model-picker.cssr.ts`
- [`src/client/components/task-form.tsx`](./src/client/components/task-form.tsx) — migrated from `task-create-dialog.tsx` into the right-sidebar task tab
- `src/client/components/prefill-bridge.tsx`, `src/client/prefill.ts`, `src/client/register/prefill.ts`
- `src/client/types/scheduler.ts`, `src/client/types/protocol.ts`

Notes:

- This notice retains attribution for the adapted panel, form and unattended executor.
- Earlier adoption scope and verification history: [`docs/sync-log.md`](./docs/sync-log.md).

## Retained upstream NOTICE

```text
dsh-automation
Copyright 2026 MichengAI contributors

本项目的 TypeScript 源码、构建脚本与项目文档采用 Apache License 2.0。

产品模型参考了 DeepSeek Harness 社区中的独立自动化实践：
- 独立 Session 调度与审计历史 (titanwings/dsh-automation，MIT)

上述参考实现的许可证与版权仍归其原作者所有；本仓库实现为独立编写，不复制其专有代码。
```

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.1-alpha.1`
- Refork revision: `ec48669f48ac81bac353fc646e7cf9c57241242f`
- Reference: the release-matched source at this revision; the repository submodule pointer is not advanced by this refork.
- Catalog pin: `dsh:` → `0.2.1-alpha.1` ([`pnpm-workspace.yaml`](../../pnpm-workspace.yaml))
- License: MIT — Copyright (c) 2026 DeepSeek

Reforked contracts and local destinations:

- [`packages/schedule/schedule/src/runtime.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/schedule/schedule/src/runtime.ts): cold-session resolution, queued user notices, context guard, persistence acknowledgment before receipt/advancement and native `workspace/session-activity` / session-stop integration → [`src/host/service/delivery.ts`](./src/host/service/delivery.ts), [`src/host/service/scheduler.ts`](./src/host/service/scheduler.ts).
- [`packages/schedule/schedule/src/delivery-history.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/schedule/schedule/src/delivery-history.ts): immutable delivery receipts, exclusive cursor pagination and retention/migration flags → [`src/host/service/history.ts`](./src/host/service/history.ts), extended with fresh-session runs under one per-task 30-day / 200-record budget.
- [`packages/client/ui-schedule/src/client/definition.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/definition.ts), [`task-tab-bindings.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/task-tab-bindings.ts), [`ScheduleTaskTab.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/ScheduleTaskTab.tsx) and [`session-link.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/session-link.ts): `scheduleTask` body/title seats, durable task identity, post-navigation read barrier, expected-record mutation and four-state session validation → [`src/client/register/task-tab.tsx`](./src/client/register/task-tab.tsx), [`src/client/service/task-tab-bindings.ts`](./src/client/service/task-tab-bindings.ts), [`src/client/components/task-tab.tsx`](./src/client/components/task-tab.tsx), [`src/client/components/task-tab-content.tsx`](./src/client/components/task-tab-content.tsx), [`src/client/components/task-tab-title.tsx`](./src/client/components/task-tab-title.tsx), [`src/client/components/session-link.ts`](./src/client/components/session-link.ts).
- [`packages/client/ui-schedule/src/client/DeliveryHistory.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/DeliveryHistory.tsx): lazy task-specific pagination, stale request isolation, cursor recovery and clipping feedback → [`src/client/components/delivery-history.tsx`](./src/client/components/delivery-history.tsx), extended to both delivery modes.
- [`packages/client/ui-schedule/src/client/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/index.ts), `ScheduleCatalogAction`, `SessionSchedule` and `ScheduleTurnCard`: creation-card replay, `schedule-created` turn tail (order `20`), `schedule-mark` / `schedule-tasks` session-row seats, `schedule-catalog` header utility (order `-5`) and `schedule.delete-toast` shell overlay → [`src/client/register/ambient.tsx`](./src/client/register/ambient.tsx), [`src/client/components/schedule-catalog-action.tsx`](./src/client/components/schedule-catalog-action.tsx), [`src/client/components/session-schedule-mark.tsx`](./src/client/components/session-schedule-mark.tsx), [`src/client/components/session-schedule-hover.tsx`](./src/client/components/session-schedule-hover.tsx), [`src/client/components/schedule-created-card.tsx`](./src/client/components/schedule-created-card.tsx), [`src/client/components/schedule-current-cards.tsx`](./src/client/components/schedule-current-cards.tsx), [`src/client/components/schedule-turn-card.tsx`](./src/client/components/schedule-turn-card.tsx).
- [`packages/client/ui-schedule/src/client/TaskDetail.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/client/ui-schedule/src/client/TaskDetail.tsx), `TaskManagerPage.module.css`, `DatePicker.tsx`, `ClockPicker.tsx`, `schedule-format.ts` and `recent-time-zones.ts`: rule/history strip, linked-session/menu/close actions, responsive detail gutters, borderless name, compact instruction, row-based run-time card, staged save footer, calendar/clock popovers, searchable localized IANA zones and compact history timeline → [`src/client/components/task-detail.tsx`](./src/client/components/task-detail.tsx), [`src/client/components/task-form.tsx`](./src/client/components/task-form.tsx), [`src/client/components/delivery-history.tsx`](./src/client/components/delivery-history.tsx), and shared `dsh-tauri-ui` date/time pickers. Runtime metadata remains separate from the retained editing snapshot; local one-shot tasks keep their existing zone/absolute-instant contract and millisecond precision.
- [`packages/session/session-projection/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/ec48669f48ac81bac353fc646e7cf9c57241242f/packages/session/session-projection/src/index.ts): public durable projection registration and catalog wire values → [`src/host/events/session-origin.ts`](./src/host/events/session-origin.ts), restoring scheduled fresh-session source marks without history scans or a custom session-header origin.
- Official delete store / `DeleteToast` / Banner confirmation and feedback → [`src/client/store/modules/deletion.ts`](./src/client/store/modules/deletion.ts), [`src/client/service/deletion.ts`](./src/client/service/deletion.ts), [`src/client/components/schedule-deletion-overlay.tsx`](./src/client/components/schedule-deletion-overlay.tsx). The local shared `Toast` reexports the same official Banner control.

Retained local behavior and assembly:

- [`cordis.patch.yml`](./cordis.patch.yml) disables official `schedule` and `ui-schedule`. This package alone owns the task store, `scheduler_*` tools, HTTP routes and task UI; it does not runtime-import either disabled feature package.
- `delivery: 'this-session'` binds a validated original session and inherits its workspace, permission and model. `delivery: 'new-session'` retains unattended execution and per-task workspace / permission / provider / model / reasoning-effort overrides. Legacy local tasks are normalized as fresh-session tasks; no implicit import from the disabled official store is performed.
- Reversible `enabled` pause/resume remains distinct from terminal `inactive`. Manual runs, recommendations and `runs/recover` remain supported. Both deliveries coalesce missed recurring occurrences to the latest due instant and preserve IANA calendar / DST semantics for the eight local schedule kinds.
- The main task list, search and chat/manual creation buttons retain their wording. The catalog opens details in place without navigating to any conversation; only its explicit linked-session action navigates. The same rule/history view renders in native session task tabs. Local `draft: true` creation, collapsed delivery/resource settings and pause/resume share the reforked detail layout; page-level tabs and global-task arrow markers are removed.
- [`src/host/utils/agent-runtime.ts`](./src/host/utils/agent-runtime.ts) uses the host loader for `createUserMessage`, scoped Agent/model selection and approval helpers so runtime module identity remains shared. Session and workspace contracts are capability-checked; unsupported public UI seats are disabled with a warning rather than patched through private React state.
- A durable prepared-message journal reconciles receipt failures using the same message identity, including messages already consumed into the session surface. Host session reads, resolution and persistence waits are bounded to 10 seconds; an unacknowledged flush remains pending and reuses its in-flight promise on a later drive. The timeout does not cancel the host operation or claim durability. This is not an exactly-once execution guarantee across a crash between conversation persistence and task-state persistence.

## License

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
