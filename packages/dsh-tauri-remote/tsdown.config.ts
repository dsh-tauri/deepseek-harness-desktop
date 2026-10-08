import { defineDshConfig } from '../dsh-tauri-tsdown/src/index.ts'

// Host half (src/index.ts) + browser client bundle (src/client/index.ts)
// wrapped in the dsh-client-modules closure factory.
// qrcode 只在宿主侧生成二维码：构建期内联，部署树不带 pngjs（其 browserify 产物会让
// 部署闭包校验误判相对引用缺失）；因此它声明为 devDependency 而不是 dependencies。
export default defineDshConfig({ server: { noExternal: ['qrcode'] } })
