import type { Locator } from 'playwright'
import type { GetApiTauriSchedulerHistoryResponse, GetApiTauriSchedulerTasksResponse, PostApiTauriSchedulerTasksBody, PostApiTauriSchedulerTasksResponse, PutApiTauriSchedulerTasksBody } from '../../../packages/dsh-tauri-scheduler/src/client/apis/index.type'
import type { DshPage } from '../support/browser'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, inject, it } from 'vitest'
import { describePageState, dismissAppModals, expectNoSyntheticFallbacks, launchDshBrowser, newDshPage, SIDEBAR_PANELLIST } from '../support/browser'
import { resolveDshCommand } from '../support/dsh'

const TASKS_PATH = '/api/tauri/scheduler/tasks'
const HISTORY_PATH = '/api/tauri/scheduler/history'
const MAIN_SLOT = '[data-slot="main"]'
const BODY_SLOT = '[data-slot="sidebar.right.pane.tab"]'
const TITLE_SLOT = '[data-slot="sidebar.right.pane.tab.title"]'

function scratchHome(): string {
  const home = resolve(inject('dshHome'))
  expect(dirname(home), '夹具只能写入系统临时目录的直接子目录').toBe(resolve(tmpdir()))
  expect(basename(home), '夹具只能写入本轮编排创建的 dsh-e2e 隔离目录').toMatch(/^dsh-e2e-.+-[a-z0-9]+$/)
  expect(inject('dshMounted'), '隔离宿主必须实际挂载被测 scheduler').toContain('dsh-tauri-scheduler')
  return home
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

async function createScratchSession(): Promise<string> {
  const sessionId = `session-${randomUUID()}`
  const rpcId = randomUUID()
  const created = await api<{ type: string, rpcId: string, result: { ok: boolean, value?: { sessionId: string } } }>('/api/session/create', 'POST', {
    type: 'client-request',
    rpcId,
    method: 'session/create',
    payload: { args: { request: { sessionId, cwd: inject('dshHome') } } },
  })
  expect(created, '原生 RPC 只能在 scratch 内创建关联会话且必须回传相同身份').toMatchObject({ type: 'server-response', rpcId, result: { ok: true, value: { sessionId } } })
  return sessionId
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

async function withScratchPage(run: (app: DshPage, prefix: string) => Promise<void>, expectedErrors: readonly string[] = [], viewport?: { width: number, height: number }): Promise<void> {
  const prefix = `scheduler-client-${randomUUID()}`
  const browser = await launchDshBrowser()
  let app: DshPage | undefined
  const warnings: string[] = []
  try {
    app = await newDshPage(browser, { ready: SIDEBAR_PANELLIST, viewport })
    app.page.on('console', (message) => {
      if (message.type() === 'warning')
        warnings.push(JSON.stringify({ text: message.text(), location: message.location() }))
    })
    expectNoSyntheticFallbacks(app)
    await run(app, prefix)
    expectNoSyntheticFallbacks(app)
    expect(app.errors, '真实交互不得产生未明确断言的浏览器错误').toEqual(expectedErrors)
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
        if (!app) {
          await capture('initial boot diagnostics replay', async () => {
            page.on('console', (message) => {
              if (message.type() === 'warning' || message.type() === 'error')
                warnings.push(JSON.stringify({ text: message.text(), location: message.location() }))
            })
            await frame.goto(`${inject('dshBaseUrl')}/`, { waitUntil: 'domcontentloaded' })
            await frame.waitForFunction(() => document.querySelector('[data-slot]') !== null || document.querySelector('[data-dsh-boot]')?.textContent?.includes('Failed to load plugins'), undefined, { timeout: 15_000 })
            return warnings.join('\n')
          })
        }
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

async function inlineDetail(app: DshPage, label: string): Promise<Locator> {
  const main = app.frame.locator(MAIN_SLOT)
  const body = main.getByRole('complementary', { name: label, exact: true })
  await expect.poll(() => body.getByLabel('名称', { exact: true }).isVisible(), { timeout: 15_000, message: `主面板内必须出现「${label}」详情表单` }).toBe(true)
  expect(await body.count(), '同一任务不得重复挂载详情').toBe(1)
  expect(await main.getByRole('heading', { name: '定时任务', level: 1, exact: true }).isVisible(), '打开详情不得离开任务主面板').toBe(true)
  expect(await app.frame.locator(TITLE_SLOT).count(), '主面板编辑不得创建原生会话 Tab 标题').toBe(0)
  expect(await app.frame.locator(BODY_SLOT).count(), '主面板编辑不得挂载原生会话 Tab 内容').toBe(0)
  expect(await app.frame.locator('[data-slot="conversation.session"]').count(), '主面板编辑不得跳转至会话').toBe(0)
  expect(await app.frame.getByRole('dialog', { includeHidden: true }).count(), '详情必须内联，不能回退到 Modal').toBe(0)
  return body
}

async function openTaskDetail(app: DshPage, name: string): Promise<Locator> {
  const main = app.frame.locator(MAIN_SLOT)
  await expect.poll(() => main.getByText(name, { exact: true }).isVisible(), { timeout: 15_000, message: '共享真实 catalog 必须读到保存的任务' }).toBe(true)
  await main.getByText(name, { exact: true }).click()
  return inlineDetail(app, name)
}

async function captureLayout(app: DshPage, prefix: string, label: string): Promise<void> {
  const directory = resolve(process.env.DSH_SCHEDULER_DIAGNOSTICS_DIR ?? '.temp/scheduler-diagnostics', prefix)
  await mkdir(directory, { recursive: true })
  await app.page.screenshot({ path: join(directory, `${label}.png`), fullPage: true })
}

function taskResponse(app: DshPage, method: string) {
  return app.page.waitForResponse(response => new URL(response.url()).pathname === TASKS_PATH && response.request().method() === method, { timeout: 15_000 })
}

describe('C 当前 core 的定时任务主面板内联详情', () => {
  it('手动暂停草稿内联保存与更新提交完整 expected，刷新后重开同一持久任务', async () => {
    await withScratchPage(async (app, prefix) => {
      const main = await openCatalog(app)
      await main.getByRole('button', { name: '手动创建', exact: true }).click()
      const draft = await inlineDetail(app, '新建定时任务')
      const name = `${prefix}-manual`
      const prompt = '仅验证暂停任务的浏览器保存，不执行任何模型请求。'
      const nameInput = draft.getByLabel('名称', { exact: true })
      await expect.poll(() => nameInput.isVisible(), { timeout: 15_000, message: '真实 options 加载后必须出现草稿表单' }).toBe(true)
      expect(await nameInput.inputValue(), '手动入口必须打开空白草稿').toBe('')
      expect(await draft.getByRole('button', { name: '投递方式', exact: true }).textContent(), '新建任务必须明确显示新会话投递').toContain('新会话执行')
      const enabled = draft.getByRole('checkbox', { name: '启用', exact: true })
      expect(await enabled.isChecked(), '新建草稿默认启用，测试保存前必须真实点击暂停').toBe(true)
      await enabled.click()
      expect(await enabled.isChecked(), '保存前必须关闭启用，禁止任务实际执行').toBe(false)
      await nameInput.fill(name)
      await draft.getByPlaceholder('描述我们应该做什么', { exact: true }).fill(prompt)
      await draft.getByRole('button', { name: '时间', exact: true }).click()
      const clock = app.frame.getByRole('dialog', { name: '时间', exact: true })
      await clock.getByRole('listbox', { name: '时', exact: true }).getByRole('option', { name: '13', exact: true }).click()
      await clock.getByRole('listbox', { name: '分', exact: true }).getByRole('option', { name: '17', exact: true }).click()
      await clock.press('Escape')
      expect(await draft.getByRole('button', { name: '时间', exact: true }).textContent(), '官方时钟列选择必须显示完整 HH:mm').toContain('13:17')
      await draft.getByRole('button', { name: '时区', exact: true }).click()
      await app.frame.getByRole('searchbox', { name: '搜索时区', exact: true }).fill('UTC')
      await app.frame.getByRole('menuitem').and(app.frame.getByTitle('UTC', { exact: true })).click()
      expect(await draft.getByRole('button', { name: '时区', exact: true }).getAttribute('title'), '时区菜单必须保存搜索命中的精确 IANA 标识').toBe('UTC')
      const creation = taskResponse(app, 'POST')
      await draft.getByRole('button', { name: '保存', exact: true }).click()
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
      const saved = await inlineDetail(app, name)
      expect(await main.getByRole('complementary').count(), 'draft→task 必须仅有一个主面板详情').toBe(1)
      expect(await saved.locator('details').getAttribute('open'), '已保存任务的投递与执行设置默认折叠').toBeNull()
      const before = (await readTasks()).find(task => task.id === created.id)
      expect(before, '独立 HTTP 清单必须保存草稿输入').toMatchObject({ id: created.id, name, prompt, enabled: false, delivery: 'new-session', status: 'active', schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' } })
      const updatedName = `${prefix}-updated`
      const updatedPrompt = '暂停任务已更新，仍不执行任何模型请求。'
      await saved.getByLabel('名称', { exact: true }).fill(updatedName)
      await saved.getByPlaceholder('描述我们应该做什么', { exact: true }).fill(updatedPrompt)
      const update = taskResponse(app, 'PUT')
      await saved.getByRole('button', { name: '保存', exact: true }).click()
      const updatedResponse = await update
      expect(updatedResponse.status(), '编辑保存必须调用真实 PUT 路由并成功').toBe(200)
      const sent = updatedResponse.request().postDataJSON() as PutApiTauriSchedulerTasksBody
      expect(sent.expected, 'PUT 必须携带独立 HTTP 清单中的完整编辑前快照').toEqual(before)
      expect(sent, 'PUT 必须保留暂停状态与任务 id').toMatchObject({ id: created.id, name: updatedName, prompt: updatedPrompt, enabled: false, delivery: 'new-session' })
      expect(await updatedResponse.json(), '真实更新响应必须包含更新后的同一任务').toMatchObject({ ok: true, task: { id: created.id, name: updatedName, prompt: updatedPrompt, enabled: false } })
      const updated = await inlineDetail(app, updatedName)
      const firstSaved = (await readTasks()).find(task => task.id === created.id)
      expect(firstSaved, '第二次编辑必须读取第一次 PUT 已持久化的任务').toMatchObject({ id: created.id, name: updatedName, prompt: updatedPrompt, enabled: false })
      const finalPrompt = '第二次保存必须基于第一次保存后的完整快照。'
      await updated.getByPlaceholder('描述我们应该做什么', { exact: true }).fill(finalPrompt)
      const secondUpdate = taskResponse(app, 'PUT')
      await updated.getByRole('button', { name: '保存', exact: true }).click()
      const secondResponse = await secondUpdate
      expect(secondResponse.status(), '同面板第二次保存必须成功，不能错误复用最初快照').toBe(200)
      expect((secondResponse.request().postDataJSON() as PutApiTauriSchedulerTasksBody).expected, '第二次 PUT 必须使用第一次 PUT 后的完整快照').toEqual(firstSaved)
      expect(await secondResponse.json(), '第二次更新必须保存同一任务的新指令').toMatchObject({ ok: true, task: { id: created.id, prompt: finalPrompt, enabled: false } })
      await app.frame.goto(`${inject('dshBaseUrl')}/`, { waitUntil: 'domcontentloaded' })
      await dismissAppModals(app.page, app.frame, app.syntheticFallbacks, 20_000, 3_000)
      expectNoSyntheticFallbacks(app)
      await openCatalog(app)
      const restored = await openTaskDetail(app, updatedName)
      await expect.poll(() => restored.getByLabel('名称', { exact: true }).inputValue(), { timeout: 15_000, message: '刷新后从任务行重开必须读取同一持久化任务' }).toBe(updatedName)
      expect(await restored.getByPlaceholder('描述我们应该做什么', { exact: true }).inputValue(), '重开后的表单必须读取最后一次保存的指令').toBe(finalPrompt)
      expect((await readTasks()).find(task => task.id === created.id), '刷新不得改写已保存任务身份和暂停状态').toMatchObject({ id: created.id, name: updatedName, prompt: finalPrompt, enabled: false })
      await restored.locator('summary').click()
      expect(await restored.getByRole('checkbox', { name: '启用', exact: true }).isChecked(), '刷新不得重新启用任务').toBe(false)
      await captureLayout(app, prefix, 'saved-inline-rule')
      await expectNoExecution(created.id)
    })
  })

  it('两种投递任务行都只开本地详情，规则与记录共享 24px 留白且保存栏不随内容滚动', async () => {
    await withScratchPage(async (app, prefix) => {
      const sessionId = await createScratchSession()
      const names = { 'new-session': `${prefix}-global`, 'this-session': `${prefix}-reminder` }
      const tasks = []
      for (const delivery of ['new-session', 'this-session'] as const) {
        const response = await api<PostApiTauriSchedulerTasksResponse>(TASKS_PATH, 'POST', {
          name: names[delivery],
          prompt: `暂停的 ${delivery} 任务不得执行模型。`,
          delivery,
          ...(delivery === 'this-session' ? { sessionId } : {}),
          enabled: false,
          schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' },
        } satisfies PostApiTauriSchedulerTasksBody)
        expect(response, '两类暂停任务必须通过真实 API 保存').toMatchObject({ ok: true, task: { name: names[delivery], delivery, enabled: false, status: 'active' } })
        if (!response.task)
          throw new Error('种植任务没有返回持久快照')
        tasks.push(response.task)
      }
      const main = await openCatalog(app)
      for (const task of tasks) {
        const rowTitle = main.getByText(task.name, { exact: true }).locator('..')
        const sessionTag = rowTitle.getByText('会话', { exact: true })
        expect(await sessionTag.count(), '只有会话任务在标题后显示固定小标签，全局任务不能有标签').toBe(task.delivery === 'this-session' ? 1 : 0)
        if (task.delivery === 'this-session') {
          const tagGeometry = await sessionTag.evaluate((element) => {
            const heading = element.parentElement!.querySelector('[title]')!
            const title = heading.getBoundingClientRect()
            const tag = element.getBoundingClientRect()
            return { height: tag.height, left: tag.x, after: title.right, svg: element.querySelectorAll('svg').length }
          })
          expect(tagGeometry, '会话标签必须恰好 18px 高且没有气泡或其他 SVG 图标').toMatchObject({ height: 18, svg: 0 })
          expect(tagGeometry.left, '会话标签必须在标题之后，而不是标题前').toBeGreaterThanOrEqual(tagGeometry.after)
        }
        const detail = await openTaskDetail(app, task.name)
        const tabs = detail.getByRole('tablist', { name: '任务详情', exact: true })
        const rule = detail.getByRole('tabpanel', { name: '规则', exact: true })
        expect(await tabs.getByRole('tab').allTextContents(), '本地详情必须且仅有规则与记录两项').toEqual(['规则', '任务运行记录'])
        const geometry = await rule.evaluate((element) => {
          const style = getComputedStyle(element)
          const aside = element.closest('aside')!
          const strip = aside.querySelector('[role="tablist"]')!.parentElement!
          return { left: style.paddingLeft, right: style.paddingRight, stripHeight: strip.getBoundingClientRect().height, width: aside.getBoundingClientRect().width }
        })
        expect(geometry, '1400px 宿主中详情内容必须有双侧 24px 留白及 44px 标签条').toMatchObject({ left: '24px', right: '24px', stripHeight: 44 })
        const mainBox = await main.locator('section').filter({ has: app.frame.getByRole('heading', { name: '定时任务', level: 1, exact: true }) }).boundingBox()
        if (!mainBox)
          throw new Error('任务主面板必须有可见几何')
        expect(Math.abs(geometry.width / mainBox.width - 0.47), '本地详情必须占主面板宽度的 47%').toBeLessThanOrEqual(0.005)
        const promptGeometry = await detail.getByLabel('任务指令', { exact: true }).evaluate((element) => {
          const style = getComputedStyle(element)
          return { width: element.getBoundingClientRect().width, parentWidth: element.parentElement!.getBoundingClientRect().width, height: element.getBoundingClientRect().height, minimum: style.minHeight, maximum: style.maxHeight, padding: style.padding, boxSizing: style.boxSizing }
        })
        expect(promptGeometry, '任务指令必须使用完整内容宽度与 112..160px 可增长边界').toMatchObject({ minimum: '112px', maximum: '160px', padding: '12px', boxSizing: 'border-box' })
        expect(Math.abs(promptGeometry.width - promptGeometry.parentWidth), '指令输入不得超出详情内容区或只占部分宽度').toBeLessThanOrEqual(1)
        expect(promptGeometry.height, '指令区域不能挤至低于基础高度').toBeGreaterThanOrEqual(112)
        expect(promptGeometry.height, '短指令区域不能高于规定上界').toBeLessThanOrEqual(160)
        const options = detail.locator('details')
        expect(await options.getAttribute('open'), '已保存任务的执行选项必须默认折叠').toBeNull()
        await options.locator('summary').click()
        expect(await options.getAttribute('open'), '本地点击必须真实展开执行选项').toBe('')
        expect(await detail.getByRole('button', { name: '投递方式', exact: true }).textContent(), '展开后必须显示本任务准确的投递方式').toContain(task.delivery === 'this-session' ? '当前会话提醒' : '新会话执行')
        expect(await detail.getByRole('button', { name: /^关联会话:/ }).count(), '只有当前会话任务的规则工具条才有明确跳转按钮').toBe(task.delivery === 'this-session' ? 1 : 0)
        const changedPrompt = `${task.prompt}\n本地未保存的草稿切换记录后仍须保留。`
        await detail.getByLabel('任务指令', { exact: true }).fill(changedPrompt)
        const footer = detail.locator('form > footer')
        const beforeScroll = await footer.boundingBox()
        const scroll = await rule.evaluate(element => ({ total: element.scrollHeight, view: element.clientHeight }))
        expect(scroll.total, '展开选项后的规则内容必须产生独立滚动区').toBeGreaterThan(scroll.view)
        await rule.hover()
        await app.page.mouse.wheel(0, 700)
        await expect.poll(() => rule.evaluate(element => element.scrollTop), { timeout: 5_000, message: '真实鼠标滚轮必须只滚动详情规则内容' }).toBeGreaterThan(0)
        const afterScroll = await footer.boundingBox()
        if (!beforeScroll || !afterScroll)
          throw new Error('未保存修改必须拥有可见固定保存栏')
        expect(Math.abs(afterScroll.y - beforeScroll.y), '保存栏不得随规则内容滚动').toBeLessThanOrEqual(1)
        await captureLayout(app, prefix, `${task.delivery}-inline-rule`)

        const response = app.page.waitForResponse(value => new URL(value.url()).pathname === HISTORY_PATH && new URL(value.url()).searchParams.get('taskId') === task.id && new URL(value.url()).searchParams.get('limit') === '20')
        await tabs.getByRole('tab', { name: '任务运行记录', exact: true }).click()
        const received = await response
        expect(received.status(), '记录视图必须请求当前任务的真实历史').toBe(200)
        expect(await received.json(), '暂停任务的分页历史必须为空且成功').toMatchObject({ ok: true, records: [], runs: [] })
        const records = detail.getByRole('tabpanel', { name: '任务运行记录', exact: true })
        await expect.poll(() => records.getByRole('region', { name: '运行记录', exact: true }).isVisible(), { timeout: 15_000, message: '切记录必须真正显示记录区' }).toBe(true)
        expect(await detail.getByLabel('名称', { exact: true }).isVisible(), '记录页不能继续显示规则名称输入').toBe(false)
        expect(await rule.isVisible(), '记录页必须完整隐藏规则面板').toBe(false)
        await expect.poll(() => records.getByRole('status').textContent(), { timeout: 15_000, message: '记录空态必须显示准确文案' }).toBe('还没有运行记录')
        expect(await footer.isVisible(), '记录页必须保留未保存修改的固定保存栏').toBe(true)
        expect(await records.getByRole('region', { name: '运行记录', exact: true }).evaluate(element => getComputedStyle(element.firstElementChild!).paddingLeft), '记录内容与规则共享 24px 留白').toBe('24px')
        await captureLayout(app, prefix, `${task.delivery}-inline-records`)
        await tabs.getByRole('tab', { name: '规则', exact: true }).click()
        expect(await detail.getByLabel('任务指令', { exact: true }).inputValue(), '切记录再回规则不得丢失草稿').toBe(changedPrompt)
        expect(await options.getAttribute('open'), '规则与记录切换必须保留本地展开状态').toBe('')
        await detail.getByRole('button', { name: '关闭', exact: true }).click()
        const reopened = await openTaskDetail(app, task.name)
        expect(await reopened.locator('details').getAttribute('open'), '关闭重开必须重置本地展开态而非全局记忆').toBeNull()
        expect(await reopened.getByLabel('任务指令', { exact: true }).inputValue(), '关闭未保存草稿不得覆盖持久任务').toBe(task.prompt)
        await reopened.getByRole('button', { name: '关闭', exact: true }).click()
        await expectNoExecution(task.id)
      }
    }, [], { width: 1400, height: 640 })
  })

  it('会话提醒入口保留原生右栏身份与 37px 标签条，隐藏同会话跳转和冗余关闭并在刷新后恢复绑定', async () => {
    await withScratchPage(async (app, prefix) => {
      const coreRequire = createRequire(resolveDshCommand()[0]!)
      const { Context } = coreRequire('@deepseek-ai/cordis')
      const { SessionStore, SessionId } = coreRequire('@deepseek-ai/dsh-session')
      const { createUserMessage } = coreRequire('@deepseek-ai/dsh-llm')
      const { default: JsonlSessionPersistence } = coreRequire('@deepseek-ai/dsh-session-persistence-jsonl')
      const home = scratchHome()
      const context = new Context()
      let sessionId: string
      try {
        const persistence = new JsonlSessionPersistence(context, { root: join(home, 'sessions') })
        const session = new SessionStore(context).create(SessionId(`session-${randomUUID()}`), { meta: { cwd: home } })
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '已结束的 UI 夹具消息，没有请求任何模型。' }], source: { kind: 'user', rpcId: randomUUID() } }), { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        const handle = await persistence.create(session.header)
        try {
          await handle.append(session.snapshotEvents())
          await handle.flush()
        }
        finally {
          await handle.close()
        }
        sessionId = session.id
      }
      finally {
        await context.fiber.dispose()
      }
      const rpcId = randomUUID()
      const adopted = await api<{ type: string, rpcId: string, result: { ok: boolean, value?: { sessionId: string } } }>('/api/session/create', 'POST', { type: 'client-request', rpcId, method: 'session/create', payload: { args: { request: { sessionId, cwd: home } } } })
      expect(adopted, `真实 RPC 必须接管公开持久化夹具而不是创建另一个空白会话：${JSON.stringify(adopted)}`).toMatchObject({ type: 'server-response', rpcId, result: { ok: true, value: { sessionId } } })
      const name = `${prefix}-native`
      const created = await api<PostApiTauriSchedulerTasksResponse>(TASKS_PATH, 'POST', {
        name,
        prompt: '只验证会话提醒右栏，未来触发不会在本用例内执行。',
        delivery: 'this-session',
        sessionId,
        enabled: true,
        schedule: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC' },
      } satisfies PostApiTauriSchedulerTasksBody)
      if (!created.ok || !created.task)
        throw new Error('未来会话提醒必须创建成功')
      await openCatalog(app)
      const detail = await openTaskDetail(app, name)
      const ownerLink = detail.getByRole('button', { name: /^关联会话:/ })
      await expect.poll(() => ownerLink.isEnabled(), { timeout: 15_000, message: '主面板只允许通过明确的关联会话按钮切换会话' }).toBe(true)
      await ownerLink.click()
      const bubble = app.frame.getByRole('button', { name: '查看定时任务', exact: true })
      await expect.poll(() => bubble.isVisible(), { timeout: 15_000, message: '显式跳转后原会话必须显示定时提醒入口' }).toBe(true)
      await bubble.click()
      const chip = app.frame.getByRole('tab').filter({ has: app.frame.locator(TITLE_SLOT).getByText(name, { exact: true }) })
      await expect.poll(() => chip.count(), { timeout: 15_000, message: '提醒入口必须创建且仅创建一个原生任务 Tab' }).toBe(1)
      expect(await chip.getAttribute('aria-selected'), '原生任务 Tab 必须选中').toBe('true')
      expect(await chip.locator(TITLE_SLOT).textContent(), '原生公共标题槽必须渲染准确任务名称').toBe(name)
      const tabId = await chip.getAttribute('data-dockkit-tab')
      if (!tabId)
        throw new Error('原生任务 Tab 缺少公共 data-dockkit-tab 标识')
      const body = app.frame.locator(`[data-sidebar-right-tab=${JSON.stringify(tabId)}] ${BODY_SLOT}`)
      await expect.poll(() => body.getByLabel('名称', { exact: true }).inputValue(), { timeout: 15_000, message: '同一公共 Tab 内容槽必须读取正确提醒任务' }).toBe(name)
      expect(await body.count(), '原生任务 Tab 内容不得重复挂载').toBe(1)
      expect(await chip.locator('[data-sidebar-right-tab]').getAttribute('data-sidebar-right-tab'), '公共标题必须属于同一原生 Tab').toBe(tabId)
      const tabs = body.getByRole('tablist', { name: '任务详情', exact: true })
      expect(await tabs.evaluate(element => element.parentElement!.getBoundingClientRect().height), '会话已有标题栏时本地标签条必须恰好 37px').toBe(37)
      expect(await body.getByRole('button', { name: /^关联会话:/ }).count(), '会话内详情不得重复链接到自身会话').toBe(0)
      expect(await body.getByRole('button', { name: '关闭', exact: true }).count(), '会话内详情不得渲染第二个关闭按钮').toBe(0)
      const historyResponse = app.page.waitForResponse(value => new URL(value.url()).pathname === HISTORY_PATH && new URL(value.url()).searchParams.get('taskId') === created.task!.id && new URL(value.url()).searchParams.get('limit') === '20')
      await tabs.getByRole('tab', { name: '任务运行记录', exact: true }).click()
      expect((await historyResponse).status(), '会话右栏记录必须调用真实的按任务分页').toBe(200)
      await expect.poll(() => body.getByRole('region', { name: '运行记录', exact: true }).getByRole('status').textContent(), { timeout: 15_000, message: '会话右栏记录区必须真正显示正确空态' }).toBe('还没有运行记录')
      expect(await body.getByLabel('名称', { exact: true }).isVisible(), '会话记录页也必须隐藏规则名称输入').toBe(false)
      await captureLayout(app, prefix, 'native-session-records')
      await app.frame.goto(`${inject('dshBaseUrl')}/`, { waitUntil: 'domcontentloaded' })
      await dismissAppModals(app.page, app.frame, app.syntheticFallbacks, 20_000, 3_000)
      await expect.poll(() => chip.count(), { timeout: 15_000, message: '真实刷新后原生 Tab 必须恢复绑定与标题' }).toBe(1)
      expect(await chip.getAttribute('data-dockkit-tab'), '原生 Tab 刷新必须保持稳定身份').toBe(tabId)
      await expect.poll(() => body.getByLabel('名称', { exact: true }).inputValue(), { timeout: 15_000, message: '公共 body 刷新必须读取同一持久任务' }).toBe(name)
      expect(await body.getByRole('tablist', { name: '任务详情', exact: true }).evaluate(element => element.parentElement!.getBoundingClientRect().height), '原生 Tab 刷新后仍必须保持 37px 标签条').toBe(37)
      await expectNoExecution(created.task.id)
    })
  })

  it('scratch 真实历史夹具只渲染分钟日期与已发送指令，正常记录无重复状态或刷新控件', async () => {
    await withScratchPage(async (app, prefix) => {
      const sessionId = await createScratchSession()
      const name = `${prefix}-history`
      const created = await api<PostApiTauriSchedulerTasksResponse>(TASKS_PATH, 'POST', { name, prompt: '当前任务已编辑后的指令，不应替换历史。', delivery: 'new-session', enabled: false, schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' } } satisfies PostApiTauriSchedulerTasksBody)
      if (!created.ok || !created.task)
        throw new Error('历史夹具的暂停任务必须创建成功')
      const home = scratchHome()
      const path = join(home, 'crons', 'history')
      const previous = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          throw error
        return JSON.stringify({ version: 2, records: [], flags: {}, pending: [], journal: [] })
      })
      const state = JSON.parse(previous) as { version: number, records: unknown[], flags: object, pending: unknown[], journal?: unknown[] }
      expect(state, '视觉夹具不能覆盖未知历史格式').toMatchObject({ version: 2, records: [], pending: [] })
      const now = new Date()
      const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 34, 56)).toISOString()
      const retainedAt = now.toISOString()
      const receiptId = `message-${randomUUID()}`
      const runId = `run-${randomUUID()}`
      const prompts = ['已经发送的提醒指令。', '已经执行的新会话指令。']
      const fixtures = [
        { id: receiptId, messageId: receiptId, taskId: created.task.id, taskName: name, prompt: prompts[0], delivery: 'this-session', occurrence: at, scheduledAt: at, deliveredAt: retainedAt, sessionId, trigger: 'schedule' },
        { id: runId, taskId: created.task.id, taskName: name, prompt: prompts[1], delivery: 'new-session', occurrence: at, scheduledFor: at, startedAt: retainedAt, finishedAt: retainedAt, sessionId, trigger: 'manual', status: 'succeeded' },
      ]
      try {
        await writeFile(path, JSON.stringify({ ...state, records: fixtures }))
        const history = await api<GetApiTauriSchedulerHistoryResponse>(`${HISTORY_PATH}?taskId=${created.task.id}&limit=20`)
        expect(history, 'HTTP 历史必须实际回读两类持久记录夹具，不得 mock 后端').toMatchObject({ ok: true, records: expect.arrayContaining(fixtures), runs: [expect.objectContaining({ id: runId, status: 'succeeded' })] })
        await openCatalog(app)
        const detail = await openTaskDetail(app, name)
        const response = app.page.waitForResponse(value => new URL(value.url()).pathname === HISTORY_PATH && new URL(value.url()).searchParams.get('taskId') === created.task!.id && new URL(value.url()).searchParams.get('limit') === '20')
        await detail.getByRole('tab', { name: '任务运行记录', exact: true }).click()
        expect((await response).status(), '记录切换必须请求真实任务分页').toBe(200)
        const records = detail.getByRole('region', { name: '运行记录', exact: true })
        await expect.poll(() => records.getByRole('listitem').count(), { timeout: 15_000, message: '实际历史字节必须渲染为两个记录项' }).toBe(2)
        const expectedDate = `${now.getUTCMonth() + 1}月${now.getUTCDate()}日 12:34`
        for (const prompt of prompts) {
          const record = records.getByRole('listitem').filter({ hasText: prompt })
          expect(await record.textContent(), '正常记录必须且仅有日期与独立的已发送指令').toBe(`${expectedDate}${prompt}`)
          expect(await record.locator('time').getAttribute('datetime'), '简洁日期必须保留完整准确 UTC 语义').toBe(at)
          expect(await record.getByRole('button', { name: /^打开会话:/ }).isEnabled(), '日期自身必须提供明确且可用的关联会话入口').toBe(true)
        }
        expect(await detail.getByLabel('名称', { exact: true }).isVisible(), '历史记录必须独占视图，不能继续显示任务名称表单').toBe(false)
        expect(await records.getByRole('button', { name: '刷新', exact: true }).count(), '正常记录不得添加无关刷新操作').toBe(0)
        expect(await records.getByRole('button').count(), '正常记录仅允许两处日期跳转入口').toBe(2)
        await captureLayout(app, prefix, 'compact-history')
      }
      finally {
        await writeFile(path, previous)
      }
    })
  })

  it('外部修改后内联旧草稿返回真实 task_conflict 并保留输入不覆盖新数据', async () => {
    await withScratchPage(async (app, prefix) => {
      const name = `${prefix}-conflict`
      const created = await api<PostApiTauriSchedulerTasksResponse>(TASKS_PATH, 'POST', { name, prompt: '初始指令。', delivery: 'new-session', enabled: false, schedule: { kind: 'daily', time: '13:17', timeZone: 'UTC' } } satisfies PostApiTauriSchedulerTasksBody)
      if (!created.ok || !created.task)
        throw new Error('真实 API 必须成功创建冲突测试的暂停任务')
      await openCatalog(app)
      const detail = await openTaskDetail(app, name)
      const remoteName = `${prefix}-external`
      const external = await api<PostApiTauriSchedulerTasksResponse>(TASKS_PATH, 'PUT', { id: created.task.id, name: remoteName, prompt: '外部新指令。', expected: created.task })
      expect(external, '独立 API 修改必须成功且保留暂停状态').toMatchObject({ ok: true, task: { id: created.task.id, name: remoteName, prompt: '外部新指令。', enabled: false } })
      const localDraft = '这个旧草稿不能覆盖外部已保存的修改。'
      await detail.getByLabel('任务指令', { exact: true }).fill(localDraft)
      const submission = taskResponse(app, 'PUT')
      await detail.getByRole('button', { name: '保存', exact: true }).click()
      const rejected = await submission
      expect(rejected.status(), '过期表单快照必须真实拒绝而不是绕过 expected').toBe(400)
      expect((rejected.request().postDataJSON() as PutApiTauriSchedulerTasksBody).expected, '过期提交必须带编辑时原始完整快照').toEqual(created.task)
      expect(await rejected.json(), '真实路由必须返回 task_conflict').toEqual({ ok: false, error: '任务已发生变化，请刷新后重试', code: 'task_conflict' })
      await expect.poll(() => detail.getByRole('alert').textContent(), { timeout: 15_000, message: '冲突必须在当前表单显示原始原因和安全重开提示' }).toBe('请求失败 (400): 任务已发生变化，请刷新后重试如任务已被修改，请重新打开后编辑。当前草稿不会覆盖新数据。')
      expect(await detail.getByLabel('任务指令', { exact: true }).inputValue(), '冲突后必须保留本地输入').toBe(localDraft)
      expect((await readTasks()).find(task => task.id === created.task?.id), '旧草稿不得覆盖独立 API 保存的新数据').toEqual(external.task)
      await expectNoExecution(created.task.id)
    }, ['CONSOLE Failed to load resource: the server responded with a status of 400 ()'])
  })

  it('主面板保留顶部创建入口且无主 Tabs，内联编辑与全局确认删除后仍显示成功 banner', async () => {
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
      expect(await main.getByRole('tablist').count(), '主面板必须直接显示任务列表，不能残留任何页面 Tabs').toBe(0)
      expect(await main.getByLabel('新会话执行', { exact: true }).count(), '全局任务标题不能带箭头投递标识').toBe(0)
      expect(await main.getByRole('button', { name: '全部标记为已读', exact: true }).count(), '主面板不能重现 markAll 控件').toBe(0)
      const menu = main.getByRole('button', { name, exact: true })
      await expect.poll(() => menu.isVisible(), { timeout: 15_000, message: '共享真实 catalog 必须读到 API 种植的暂停任务' }).toBe(true)
      await menu.click()
      await app.frame.getByRole('menuitem', { name: '编辑', exact: true }).click()
      const opened = await inlineDetail(app, name)
      expect(await main.getByRole('heading', { name: '定时任务', level: 1, exact: true }).count(), '菜单编辑必须留在主面板且标题不重复').toBe(1)
      await expect.poll(() => opened.getByLabel('名称', { exact: true }).inputValue(), { timeout: 15_000, message: '编辑必须读取正确的 API 种植任务' }).toBe(name)
      await expectNoExecution(seeded.task.id)
      await opened.getByRole('button', { name: '更多操作', exact: true }).click()
      await app.frame.getByRole('menuitem', { name: '删除', exact: true }).click()
      const confirm = app.frame.getByRole('dialog', { name: '删除', exact: true })
      await expect.poll(() => confirm.isVisible(), { timeout: 15_000, message: '右栏删除必须打开统一的全局确认' }).toBe(true)
      expect(await confirm.getByText('这将永久删除已安排的任务，并停止今后的运行', { exact: true }).count(), '全局确认必须显示删除后果').toBe(1)
      expect(await confirm.getByText(name, { exact: true }).count(), '全局确认必须绑定正确任务').toBe(1)
      expect(await opened.getByRole('dialog', { includeHidden: true }).count(), '确认弹窗不得归属于内联详情的 DOM').toBe(0)
      const removal = taskResponse(app, 'DELETE')
      await confirm.getByRole('button', { name: '删除已安排的任务', exact: true }).click()
      const deletedResponse = await removal
      expect(deletedResponse.status(), '确认后必须调用真实删除路由').toBe(200)
      expect(await deletedResponse.json(), '真实删除响应必须成功').toEqual({ ok: true })
      await expect.poll(() => opened.count(), { timeout: 15_000, message: '删除成功必须关闭源内联任务详情' }).toBe(0)
      expect(await main.getByRole('heading', { name: '定时任务', level: 1, exact: true }).isVisible(), '删除内联详情后仍须保留主任务面板').toBe(true)
      const banner = app.frame.getByRole('alert').filter({ hasText: `已删除定时任务 ${name}` })
      await expect.poll(() => banner.textContent(), { timeout: 15_000, message: '内联详情已关闭后全局 banner 仍必须显示成功反馈' }).toBe(`已删除定时任务 ${name}`)
      expect(await app.frame.getByRole('dialog', { includeHidden: true }).count(), '删除成功必须关闭全局确认').toBe(0)
      expect((await readTasks()).filter(task => task.id === seeded.task?.id), '真实 HTTP 清单不得再含已删除任务').toEqual([])
    })
  })
})
