import type { Locator } from 'playwright'
import type { GetApiTauriSchedulerHistoryResponse, GetApiTauriSchedulerTasksResponse, PostApiTauriSchedulerTasksBody, PostApiTauriSchedulerTasksResponse, PutApiTauriSchedulerTasksBody } from '../../../packages/dsh-tauri-scheduler/src/client/apis/index.type'
import type { DshPage } from '../support/browser'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, inject, it } from 'vitest'
import { describePageState, dismissAppModals, expectNoSyntheticFallbacks, launchDshBrowser, newDshPage, SIDEBAR_PANELLIST } from '../support/browser'

const TASKS_PATH = '/api/tauri/scheduler/tasks'
const HISTORY_PATH = '/api/tauri/scheduler/history'
const MAIN_SLOT = '[data-slot="main"]'
const BODY_SLOT = '[data-slot="sidebar.right.pane.tab"]'
const TITLE_SLOT = '[data-slot="sidebar.right.pane.tab.title"]'

interface TaskTabNodes {
  id: string
  body: Locator
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${inject('dshBaseUrl')}${path}`, {
    method,
    headers: { 'cookie': inject('dshCookie'), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(response.status, `${method} ${path} 必须返回 200`).toBe(200)
  return await response.json() as T
}

async function readTasks(): Promise<GetApiTauriSchedulerTasksResponse['tasks']> {
  const payload = await api<GetApiTauriSchedulerTasksResponse>(TASKS_PATH)
  expect(Array.isArray(payload.tasks), '真实任务清单必须带 tasks 数组').toBe(true)
  return payload.tasks
}

async function expectNoExecution(id: string): Promise<void> {
  const history = await api<GetApiTauriSchedulerHistoryResponse>(`${HISTORY_PATH}?taskId=${encodeURIComponent(id)}&limit=100`)
  expect(history.ok, '暂停任务的历史查询必须成功').toBe(true)
  if (!history.ok)
    throw new Error(history.error)
  expect(history.records, '浏览器编辑不得触发模型或产生投递记录').toEqual([])
  expect(history.runs, '暂停的新会话任务不得产生执行记录').toEqual([])
}

async function withScratchPage(run: (app: DshPage, prefix: string) => Promise<void>): Promise<void> {
  const prefix = `scheduler-client-${randomUUID()}`
  const browser = await launchDshBrowser()
  let app: DshPage | undefined
  const warnings: string[] = []
  try {
    app = await newDshPage(browser, { ready: SIDEBAR_PANELLIST })
    app.page.on('console', (message) => {
      if (message.type() === 'warning')
        warnings.push(JSON.stringify({ text: message.text(), location: message.location() }))
    })
    expectNoSyntheticFallbacks(app)
    await run(app, prefix)
    expectNoSyntheticFallbacks(app)
    expect(app.errors, '右栏注册、真实点击与刷新不得产生浏览器错误').toEqual([])
  }
  catch (error) {
    try {
      const directory = resolve(process.env.DSH_SCHEDULER_DIAGNOSTICS_DIR ?? '.temp/scheduler-diagnostics', prefix)
      const lines = [`case=${prefix}`, error instanceof Error ? error.stack ?? error.message : String(error)]
      const capture = async (label: string, collect: () => Promise<string>): Promise<void> => {
        try {
          const value = await collect()
          lines.push(`${label}\n${value}`)
          process.stderr.write(`[scheduler diagnostics] ${label}\n${value}\n`)
        }
        catch (diagnosticError) {
          const value = `${label}: ${diagnosticError instanceof Error ? diagnosticError.stack ?? diagnosticError.message : String(diagnosticError)}`
          lines.push(`DIAGNOSTIC_FAILED ${value}`)
          process.stderr.write(`[scheduler diagnostics] DIAGNOSTIC_FAILED ${value}\n`)
        }
      }
      await capture('console warnings (after page initialization)', async () => warnings.join('\n') || '(none)')
      await capture('diagnostics directory', async () => {
        await mkdir(directory, { recursive: true })
        return directory
      })
      const page = app?.page ?? browser.contexts().flatMap(context => context.pages())[0]
      const frame = app?.frame ?? page?.frames().find(candidate => candidate !== page.mainFrame()) ?? page?.mainFrame()
      if (page && frame) {
        await capture('page state', () => describePageState(page, frame))
        const nodes: readonly [string, Locator][] = [
          ['tabs', frame.getByRole('tab', { includeHidden: true })],
          ['titles', frame.locator(TITLE_SLOT)],
          ['bodies', frame.locator(BODY_SLOT)],
          ['alerts', frame.getByRole('alert', { includeHidden: true })],
          ['slot errors', frame.locator('[data-slot-error]')],
        ]
        for (const [label, locator] of nodes) {
          await capture(label, async () => {
            const count = await locator.count()
            const values: { index: number, text: string | null, slot: string | null, slotError: string | null, dockkitTab: string | null, sidebarRightTab: string | null, selected: string | null }[] = []
            for (let index = 0; index < count; index++) {
              const node = locator.nth(index)
              values.push({
                index,
                text: await node.textContent({ timeout: 2_000 }),
                slot: await node.getAttribute('data-slot', { timeout: 2_000 }),
                slotError: await node.getAttribute('data-slot-error', { timeout: 2_000 }),
                dockkitTab: await node.getAttribute('data-dockkit-tab', { timeout: 2_000 }),
                sidebarRightTab: await node.getAttribute('data-sidebar-right-tab', { timeout: 2_000 }),
                selected: await node.getAttribute('aria-selected', { timeout: 2_000 }),
              })
            }
            return JSON.stringify({ count, nodes: values }, null, 2)
          })
        }
        await capture('screenshot', async () => {
          const path = join(directory, 'page.png')
          await page.screenshot({ path, fullPage: true, timeout: 5_000 })
          return path
        })
      }
      else {
        await capture('page state', async () => 'No public browser page/frame remained at failure')
      }
      await capture('scratch host log', async () => {
        const path = join(inject('dshHome'), 'dsh-web.log')
        const log = await readFile(path, 'utf8')
        await writeFile(join(directory, 'dsh-web.log'), log, 'utf8')
        return `source=${path}\n${log}`
      })
      await capture('report', async () => {
        const path = join(directory, 'report.txt')
        await writeFile(path, lines.join('\n\n'), 'utf8')
        return path
      })
    }
    catch (diagnosticError) {
      try {
        process.stderr.write(`[scheduler diagnostics] ${diagnosticError instanceof Error ? diagnosticError.stack ?? diagnosticError.message : String(diagnosticError)}\n`)
      }
      catch {
        throw error
      }
    }
    throw error
  }
  finally {
    try {
      for (const task of await readTasks()) {
        if (task.name.startsWith(prefix)) {
          const removed = await api<{ ok?: boolean }>(TASKS_PATH, 'DELETE', { id: task.id })
          expect(removed, '清理必须成功删除本用例创建的 scratch 任务').toEqual({ ok: true })
        }
      }
      expect((await readTasks()).filter(task => task.name.startsWith(prefix)), '用例不得留下自己的 scratch 任务').toEqual([])
    }
    finally {
      try {
        await app?.close()
      }
      finally {
        await browser.close()
      }
    }
  }
}

async function openCatalog(app: DshPage): Promise<Locator> {
  await dismissAppModals(app.page, app.frame, app.syntheticFallbacks)
  await app.frame.getByRole('button', { name: '定时任务', exact: true }).click()
  const main = app.frame.locator(MAIN_SLOT)
  await expect.poll(() => main.getByRole('heading', { name: '定时任务', level: 1, exact: true }).isVisible(), {
    timeout: 15_000,
    message: '侧栏的真实指针点击必须打开任务主面板',
  }).toBe(true)
  return main
}

async function taskTab(app: DshPage, label: string): Promise<TaskTabNodes> {
  const chip = app.frame.getByRole('tab').filter({ has: app.frame.locator(TITLE_SLOT).getByText(label, { exact: true }) })
  await expect.poll(() => chip.count(), { timeout: 15_000, message: `右栏必须恰有一个「${label}」Tab 节点` }).toBe(1)
  expect(await chip.getAttribute('aria-selected'), '任务 Tab 必须处于选中态').toBe('true')
  expect(await chip.locator(TITLE_SLOT).textContent(), '公共 title 节点必须渲染任务标题').toBe(label)
  const id = await chip.getAttribute('data-dockkit-tab')
  if (!id)
    throw new Error('当前 core 的 Tab 节点缺少公共 data-dockkit-tab 标识')
  expect(await chip.locator('[data-sidebar-right-tab]').getAttribute('data-sidebar-right-tab'), 'title 节点必须属于同一 Tab').toBe(id)
  const body = app.frame.locator(`[data-sidebar-right-tab=${JSON.stringify(id)}] ${BODY_SLOT}`)
  await expect.poll(() => body.getByRole('heading', { name: label, level: 2, exact: true }).isVisible(), {
    timeout: 15_000,
    message: '同一 Tab 的公共 body 节点必须渲染任务表单',
  }).toBe(true)
  expect(await body.count(), 'Tab body 不得重复挂载').toBe(1)
  expect(await app.frame.getByRole('dialog', { includeHidden: true }).count(), '新建与编辑必须直开右栏，不能回退到 Modal').toBe(0)
  return { id, body }
}

function taskResponse(app: DshPage, method: string) {
  return app.page.waitForResponse(response => new URL(response.url()).pathname === TASKS_PATH && response.request().method() === method, { timeout: 15_000 })
}

describe('C 当前 core 的定时任务右栏', () => {
  it('手动暂停草稿保存后仍使用同一 Tab，更新提交完整 expected，刷新恢复任务绑定', async () => {
    await withScratchPage(async (app, prefix) => {
      const main = await openCatalog(app)
      await main.getByRole('button', { name: '手动创建', exact: true }).click()
      const draft = await taskTab(app, '新建定时任务')
      const name = `${prefix}-manual`
      const prompt = '仅验证暂停任务的浏览器保存，不执行任何模型请求。'
      const nameInput = draft.body.getByLabel('名称', { exact: true })
      await expect.poll(() => nameInput.isVisible(), { timeout: 15_000, message: '真实 options 加载后必须出现草稿表单' }).toBe(true)
      expect(await nameInput.inputValue(), '手动入口必须打开空白草稿').toBe('')
      expect(await draft.body.getByRole('button', { name: '投递方式', exact: true }).textContent(), '新建任务必须明确显示新会话投递').toContain('新会话执行')
      const enabled = draft.body.getByRole('checkbox', { name: '启用', exact: true })
      expect(await enabled.isChecked(), '新建草稿默认启用，测试保存前必须真实点击暂停').toBe(true)
      await enabled.click()
      expect(await enabled.isChecked(), '保存前必须关闭启用，禁止任务实际执行').toBe(false)
      await nameInput.fill(name)
      await draft.body.getByPlaceholder('描述我们应该做什么', { exact: true }).fill(prompt)
      await draft.body.getByLabel('时间段', { exact: true }).fill('13:17')
      await draft.body.getByLabel('时区', { exact: true }).fill('UTC')
      const creation = taskResponse(app, 'POST')
      await draft.body.getByRole('button', { name: '保存', exact: true }).click()
      const createdResponse = await creation
      expect(createdResponse.status(), '手动保存必须调用真实创建路由并成功').toBe(200)
      expect(createdResponse.request().postDataJSON() as PostApiTauriSchedulerTasksBody, '真实创建请求必须保存暂停的新会话任务').toMatchObject({
        name,
        prompt,
        delivery: 'new-session',
        enabled: false,
        schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' },
      })
      const createdPayload = await createdResponse.json() as PostApiTauriSchedulerTasksResponse
      expect(createdPayload.ok, '手动创建必须返回 ok:true').toBe(true)
      if (!createdPayload.task)
        throw new Error('手动创建未返回完整 task 快照')
      const created = createdPayload.task
      expect(created.id, '创建必须返回真实持久化任务 id').toMatch(/^task-[0-9a-f-]{36}$/)
      const saved = await taskTab(app, name)
      expect(saved.id, 'draft→task 导航必须复用原右栏 Tab').toBe(draft.id)
      const before = (await readTasks()).find(task => task.id === created.id)
      expect(before, '独立 HTTP 清单必须保存草稿输入').toMatchObject({ id: created.id, name, prompt, enabled: false, delivery: 'new-session', status: 'active', schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' } })
      const updatedName = `${prefix}-updated`
      const updatedPrompt = '暂停任务已更新，仍不执行任何模型请求。'
      await saved.body.getByLabel('名称', { exact: true }).fill(updatedName)
      await saved.body.getByPlaceholder('描述我们应该做什么', { exact: true }).fill(updatedPrompt)
      const update = taskResponse(app, 'PUT')
      await saved.body.getByRole('button', { name: '保存', exact: true }).click()
      const updatedResponse = await update
      expect(updatedResponse.status(), '编辑保存必须调用真实 PUT 路由并成功').toBe(200)
      const sent = updatedResponse.request().postDataJSON() as PutApiTauriSchedulerTasksBody
      expect(sent.expected, 'PUT 必须携带独立 HTTP 清单中的完整编辑前快照').toEqual(before)
      expect(sent, 'PUT 必须保留暂停状态与任务 id').toMatchObject({ id: created.id, name: updatedName, prompt: updatedPrompt, enabled: false, delivery: 'new-session' })
      expect(await updatedResponse.json(), '真实更新响应必须包含更新后的同一任务').toMatchObject({ ok: true, task: { id: created.id, name: updatedName, prompt: updatedPrompt, enabled: false } })
      expect((await taskTab(app, updatedName)).id, '编辑保存不得另开右栏 Tab').toBe(draft.id)
      await app.frame.goto(`${inject('dshBaseUrl')}/`, { waitUntil: 'domcontentloaded' })
      await dismissAppModals(app.page, app.frame, app.syntheticFallbacks, 20_000, 3_000)
      expectNoSyntheticFallbacks(app)
      const restored = await taskTab(app, updatedName)
      expect(restored.id, 'iframe 真刷新必须恢复同一持久化 Tab').toBe(draft.id)
      await expect.poll(() => restored.body.getByLabel('名称', { exact: true }).inputValue(), { timeout: 15_000, message: '刷新不能丢失已保存的 task binding' }).toBe(updatedName)
      expect(await restored.body.getByPlaceholder('描述我们应该做什么', { exact: true }).inputValue(), '刷新后的表单必须读取已更新的任务').toBe(updatedPrompt)
      expect(await restored.body.getByRole('checkbox', { name: '启用', exact: true }).isChecked(), '刷新不得重新启用任务').toBe(false)
      await expectNoExecution(created.id)
    })
  })

  it('主面板保留顶部创建入口且无执行记录页，编辑直开右栏，全局确认删除后的 banner 不依赖原 Tab', async () => {
    await withScratchPage(async (app, prefix) => {
      const name = `${prefix}-seed`
      const seeded = await api<PostApiTauriSchedulerTasksResponse>(TASKS_PATH, 'POST', {
        name,
        prompt: '仅种植暂停的新会话任务供真实浏览器编辑。',
        delivery: 'new-session',
        enabled: false,
        schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' },
      } satisfies PostApiTauriSchedulerTasksBody)
      expect(seeded.ok, '独立 API 种植暂停任务必须成功').toBe(true)
      if (!seeded.task)
        throw new Error('独立 API 未返回种植任务')
      expect(seeded.task, '种植任务必须暂停且只在新会话执行').toMatchObject({ name, delivery: 'new-session', status: 'active', enabled: false })
      const main = await openCatalog(app)
      const heading = main.getByRole('heading', { name: '定时任务', level: 1, exact: true })
      const viaChat = main.getByRole('button', { name: '通过 Chat 创建', exact: true })
      const manual = main.getByRole('button', { name: '手动创建', exact: true })
      const headingBox = await heading.boundingBox()
      const viaChatBox = await viaChat.boundingBox()
      const manualBox = await manual.boundingBox()
      if (!headingBox || !viaChatBox || !manualBox)
        throw new Error('主面板标题与顶部创建入口必须具备可见几何')
      expect(viaChatBox.x, '通过 Chat 创建必须保留在标题右侧').toBeGreaterThan(headingBox.x)
      expect(manualBox.x, '手动创建必须保留在通过 Chat 创建右侧').toBeGreaterThan(viaChatBox.x + viaChatBox.width)
      expect(Math.abs(viaChatBox.y - manualBox.y), '两个创建入口必须保留在同一顶部行').toBeLessThanOrEqual(1)
      expect(Math.abs(manualBox.y - headingBox.y), '创建入口必须与主面板标题顶部对齐').toBeLessThanOrEqual(2)
      expect(await main.getByRole('tablist', { name: '定时任务', exact: true }).getByRole('tab').allTextContents(), '主面板只保留任务页，不能重现 runsTab').toEqual(['定时任务'])
      expect(await main.getByRole('button', { name: '全部标记为已读', exact: true }).count(), '主面板不能重现 markAll 控件').toBe(0)
      const menu = main.getByRole('button', { name, exact: true })
      await expect.poll(() => menu.isVisible(), { timeout: 15_000, message: '共享真实 catalog 必须读到 API 种植的暂停任务' }).toBe(true)
      await menu.click()
      await app.frame.getByRole('menuitem', { name: '编辑', exact: true }).click()
      const opened = await taskTab(app, name)
      expect(await main.getByRole('heading', { name: '定时任务', level: 1, exact: true }).count(), '编辑任务必须离开主面板并打开真正的右栏').toBe(0)
      await expect.poll(() => opened.body.getByLabel('名称', { exact: true }).inputValue(), { timeout: 15_000, message: '编辑必须读取正确的 API 种植任务' }).toBe(name)
      await expectNoExecution(seeded.task.id)
      await opened.body.getByRole('button', { name: '删除', exact: true }).click()
      const confirm = app.frame.getByRole('dialog', { name: '删除', exact: true })
      await expect.poll(() => confirm.isVisible(), { timeout: 15_000, message: '右栏删除必须打开统一的全局确认' }).toBe(true)
      expect(await confirm.getByText('这将永久删除已安排的任务，并停止今后的运行', { exact: true }).count(), '全局确认必须显示删除后果').toBe(1)
      expect(await confirm.getByText(name, { exact: true }).count(), '全局确认必须绑定正确任务').toBe(1)
      expect(await opened.body.getByRole('dialog', { includeHidden: true }).count(), '确认弹窗不得归属于任务 Tab 的 DOM').toBe(0)
      const removal = taskResponse(app, 'DELETE')
      await confirm.getByRole('button', { name: '删除已安排的任务', exact: true }).click()
      const deletedResponse = await removal
      expect(deletedResponse.status(), '确认后必须调用真实删除路由').toBe(200)
      expect(await deletedResponse.json(), '真实删除响应必须成功').toEqual({ ok: true })
      await expect.poll(() => opened.body.count(), { timeout: 15_000, message: '删除成功必须关闭源任务 Tab' }).toBe(0)
      const banner = app.frame.getByRole('alert').filter({ hasText: `已删除定时任务 ${name}` })
      await expect.poll(() => banner.textContent(), { timeout: 15_000, message: '原 Tab 已关闭后全局 banner 仍必须显示成功反馈' }).toBe(`已删除定时任务 ${name}`)
      expect(await app.frame.getByRole('dialog', { includeHidden: true }).count(), '删除成功必须关闭全局确认').toBe(0)
      expect((await readTasks()).filter(task => task.id === seeded.task?.id), '真实 HTTP 清单不得再含已删除任务').toEqual([])
    })
  })
})
