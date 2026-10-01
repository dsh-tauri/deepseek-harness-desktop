import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import globalStyle from '../../../packages/dsh-tauri-ui/src/client/styles/global.cssr'

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
})

afterAll(async () => {
  await browser?.close()
})

async function render(count = 3, anchor = false, inset = 0): Promise<void> {
  await page.mouse.move(0, 0)
  await page.setContent(`<style>
    body { margin:0; --dsh-composer-card-max-width:600px; --dsh-composer-side-clearance:24px }
    .seat { position:absolute; bottom:50px; left:0; width:1000px }
    [data-slot="conversation.input.dock"] { display:flex; flex-direction:column; align-items:center }
    [data-card] { width:calc(100% - var(--dsh-composer-side-clearance) * 2 - ${inset * 2}px); box-sizing:border-box; background:#eee; border:1px solid #aaa }
    [data-card] button { height:62px; display:block }
    .composer { width:600px; height:100px; margin:8px auto 0 }
    ${globalStyle.render()}
  </style><div class="seat"><div data-slot="conversation.input.dock" style="display:contents">${Array.from({ length: count }, (_, index) => `${anchor && index === 1 ? '<div data-dsh-tauri-worktree-mode-anchor></div>' : ''}<div data-card="${index}"><button>card</button></div>`).join('')}</div><div class="composer"></div></div>`)
}

async function heights(): Promise<number[]> {
  return page.locator('[data-card]').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().height * 100) / 100))
}

describe('input dock hover geometry', () => {
  it('preserves card widths after boxing the display-contents outlet', async () => {
    await render()
    expect(await page.locator('[data-card="2"]').evaluate(element => element.getBoundingClientRect().width)).toBe(600)
  })

  it('keeps both side gutters collapsed', async () => {
    await render()
    const last = await page.locator('[data-card="2"]').boundingBox()
    expect(last, '末项必须存在').not.toBeNull()
    for (const x of [50, 950]) {
      await page.mouse.move(x, last!.y + 10)
      expect(await heights(), '两侧空白不得展开卡片').toEqual([11.52, 11.76, 64])
    }
  })

  it.each([8, 16])('keeps near-card inset gutters collapsed (%spx inset)', async (inset) => {
    await render(3, false, inset)
    const last = await page.locator('[data-card="2"]').boundingBox()
    for (const x of [last!.x - 4, last!.x + last!.width + 4]) {
      await page.mouse.move(x, last!.y + 10)
      expect(await heights(), '卡片边缘内缩空白不得触发展开').toEqual([11.52, 11.76, 64])
    }
    await page.locator('[data-card="2"]').hover()
    await expect.poll(() => heights()).toEqual([64, 64, 64])
    await page.locator('[data-card="0"] button').hover()
    expect(await heights()).toEqual([64, 64, 64])
  })

  it('animates real layout height and stays open on the uppermost card', async () => {
    await render()
    const dock = page.locator('[data-slot="conversation.input.dock"]')
    expect(await dock.evaluate(element => element.getBoundingClientRect().height), '收起时不得保留完整卡片占位').toBe(88)
    await page.locator('[data-card="2"]').hover()
    await expect.poll(() => dock.evaluate(element => element.getBoundingClientRect().height), { message: '展开高度必须完成过渡' }).toBe(204)
    await page.locator('[data-card="0"] button').hover()
    expect(await heights(), '移动到最上层不能回缩').toEqual([64, 64, 64])
    expect(await page.locator('[data-card="0"]').evaluate(element => getComputedStyle(element).transitionDuration), '必须有过渡动画').toBe('0.22s, 0.22s, 0.22s')
    await page.mouse.move(0, 0)
    await expect.poll(() => dock.evaluate(element => element.getBoundingClientRect().height), { message: '离开后布局必须重新收紧' }).toBe(88)
  })

  it('interpolates height during expansion and collapse', async () => {
    await render()
    const last = await page.locator('[data-card="2"]').boundingBox()
    async function sample(): Promise<number[]> {
      return page.locator('[data-slot="conversation.input.dock"]').evaluate(async (element) => {
        const values: number[] = []
        const start = performance.now()
        while (performance.now() - start < 300) {
          values.push(element.getBoundingClientRect().height)
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
        return values
      })
    }
    await page.mouse.move(last!.x + 100, last!.y + 10)
    expect((await sample()).some(value => value > 88 && value < 204), '展开必须经过中间高度').toBe(true)
    await page.mouse.move(0, 0)
    expect((await sample()).some(value => value > 88 && value < 204), '收起必须经过中间高度').toBe(true)
  })

  it.each([3, 4])('ignores an anchor when stacking %s cards', async (count) => {
    await render(count, true)
    const expected = count === 3 ? [11.52, 11.76, 64] : [11.28, 11.52, 11.76, 64]
    expect(await heights()).toEqual(expected)
    await page.locator(`[data-card="${count - 1}"]`).hover()
    await expect.poll(() => heights()).toEqual(Array.from({ length: count }).fill(64))
    await page.locator('[data-card="0"] button').hover()
    expect(await heights()).toEqual(Array.from({ length: count }).fill(64))
  })

  it.each([0, 16])('restores item spacing without collapsing over gaps (%spx inset)', async (inset) => {
    await render(3, true, inset)
    await page.locator('[data-card="2"]').hover()
    await expect.poll(() => heights()).toEqual([64, 64, 64])
    const cards = await page.locator('[data-card]').evaluateAll(elements => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom }
    }))
    for (let index = 0; index < cards.length - 1; index++) {
      const card = cards[index]
      expect(cards[index + 1].y - card.bottom, '展开项目之间应保留 6px 间距，anchor 不增加间距').toBe(6)
      await page.mouse.move(card.x + card.width / 2, card.bottom + 3)
      const frames = await page.locator('[data-card]').evaluateAll(async (elements) => {
        const samples: number[][] = []
        const start = performance.now()
        while (performance.now() - start < 300) {
          samples.push(elements.map(element => element.getBoundingClientRect().height))
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
        return samples
      })
      expect(frames.length, '必须采样间隙悬停期间的连续动画帧').toBeGreaterThan(1)
      for (const frame of frames)
        expect(frame, '鼠标停在项目间隙时，每一帧都应保持展开，不得抖动').toEqual([64, 64, 64])
      expect(await page.locator('[data-card="0"]').evaluate(element => getComputedStyle(element).transform), '间隙必须维持展开状态').toBe('matrix(1, 0, 0, 1, 0, 0)')
    }
    await page.mouse.move(cards[0].x - 4, cards[0].bottom + 3)
    await expect.poll(() => heights(), { message: '间隙两侧空白仍应收起' }).toEqual([11.52, 11.76, 64])
  })

  it('keeps the dock expanded while a card has keyboard focus', async () => {
    await render()
    await page.locator('[data-card="0"] button').focus()
    await expect.poll(() => heights(), { message: '键盘焦点所在卡片必须完整展开' }).toEqual([64, 64, 64])
  })

  it('does not stack two cards even when an anchor is present', async () => {
    await render(2, true)
    expect(await heights(), 'anchor 不计入堆叠门槛').toEqual([64, 64])
  })

  it('keeps a stacked dock hidden in the mobile composer stack', async () => {
    const mobilePage = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } })
    try {
      await mobilePage.setContent(`<style>${globalStyle.render()}</style><div class="fixture_composerStack"><div data-slot="conversation.input.dock" style="display:contents"><div>one</div><div>two</div><div>three</div></div></div>`)
      expect(await mobilePage.evaluate(() => matchMedia('(hover: none) and (any-pointer: coarse) and (any-hover: none)').matches), '触摸页面必须命中 Mobile 条件').toBe(true)
      expect(await mobilePage.locator('[data-slot="conversation.input.dock"]').evaluate(element => getComputedStyle(element).display), '堆叠布局不得盖过 Mobile 隐藏规则').toBe('none')
    }
    finally {
      await mobilePage.close()
    }
  })

  it('honors reduced motion without disabling expansion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    try {
      await render()
      expect(await page.locator('[data-card="0"]').evaluate(element => getComputedStyle(element).transitionDuration), '减少动态效果时必须关闭动画').toBe('0s')
      await page.locator('[data-card="2"]').hover()
      expect(await heights(), '关闭动效不能影响展开').toEqual([64, 64, 64])
    }
    finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
  })
})
