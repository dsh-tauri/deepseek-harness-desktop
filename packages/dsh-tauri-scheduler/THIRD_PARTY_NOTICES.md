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
- `src/client/components/task-create-dialog.tsx`
- `src/client/components/prefill-bridge.tsx`, `src/client/prefill.ts`, `src/client/register/prefill.ts`
- `src/client/types/scheduler.ts`, `src/client/types/protocol.ts`

Notes:

- Adapted files carry an inline attribution comment at the top.
- Scope, deliberately retained differences and verification history: [`docs/sync-log.md`](./docs/sync-log.md).

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
- Revision: `5badb15009ae1756c3afe0ae0cef1faafc290ccc`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.1-alpha.1` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not derived: the desktop counterpart of the official Schedule plugin, running on the official Host contracts.

Official packages used:

- `@deepseek-ai/dsh-agent` → `installModelSelection`
- `@deepseek-ai/dsh-llm` → `createUserMessage`
- `@deepseek-ai/dsh-user-approval` → `setApprovalPolicy`
- `@deepseek-ai/dsh-session` → session creation and append for an unattended run
- `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-workspace` → tool registration, workspace resolution
- The first three are imported dynamically in `src/host/utils/agent-runtime.ts`; the rest are declared dependencies.

Official counterpart (official `@deepseek-ai/dsh-schedule` + `@deepseek-ai/dsh-client-ui-schedule` → this package):

- Tools: official `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` → `scheduler_create` / `scheduler_list` / `scheduler_update` / `scheduler_delete` (`src/host/tools/`), four to four. `scheduler_update` additionally absorbs pausing/resuming (`enabled`, the official set has no toggle) and offers a `run_now` switch that also triggers an immediate manual run.
- Delivery: official durable Host-wide reminders in the **original** Session → unattended runs, each starting a **fresh** Session (`workspaceId`, `permission`, `provider`, `model`, `reasoningEffort`).
- Recurrence: official one-shot / fixed-rate / daily / weekly / cron (`createCronScheduleRecord`, `resolveCronOccurrence`, `canonicalizeCronExpression`) → `once` / `hourly` / `daily` / `interval` / `workdays` / `weekly` / `monthly` / `custom` (`SCHEDULE_KINDS` in `src/shared/constants.ts`), evaluated with the `cron-schedule` package or anchored arithmetic; no cron kind.
- Missed occurrences: official keeps only the latest missed occurrence and restores a cold Session → anchored interval/custom arithmetic plus `runs/recover` reconciliation for interrupted runs.
- UI: official task list, task detail, delivery history, clock/date pickers and recent time zones → task list, create dialog and run history (`history/{get,delete}`); no delivery history or time-zone data source.
- Official Schedule is enabled by default in the target Web bundle (`cordis.patch.yml`: id `schedule`, id `ui-schedule`); its `schedule` service and `schedule_*` tools use a different task store from this plugin's `scheduler` service and `scheduler_*` tools.

## Compatibility `0.2.0-rc.2` → `0.2.1-alpha.1`

- The target enables the official `schedule` and `ui-schedule` rows by default in the Web bundle and scopes reminder tools to Standard, Creator, and PTC presets.
- This plugin keeps its separate `scheduler` service, `scheduler_*` tools, unattended fresh-session runs, and task store. It neither disables the official rows nor imports official tasks into its own store.
- Agent model selection, approval policy, session append, and user-message construction remain compatible; no removed invariant export is consumed.

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
