/// <reference types="vite/client" />

/**
 * `<webview>` 标签（Electron `webviewTag`）。
 *
 * dev 形态下壳层页用它在页面里承载 DSH，从而保留 Vite dev 的 HMR：壳层本身是普通
 * 组件树、由 Vite 直接提供模块热更新；DSH 在独立 webview 里单独加载，不受壳层 HMR 影响。
 * React 19 的内置类型不含该元素，这里补最小声明。
 */
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string
      partition?: string
      allowpopups?: string
      webpreferences?: string
      useragent?: string
    }
  }
}
