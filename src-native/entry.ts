// 移动端应用入口。
//
// 为什么不直接把 package.json 的 `main` 写成 `expo-router/entry`：
// 本仓库用 pnpm 安装依赖，`node_modules/expo-router` 是指向 `node_modules/.pnpm/...` 的符号链接。
// Expo 会把 `main` 解析成绝对路径后再转成「相对工程根」的路径交给 Metro，而 Metro 的相对路径解析
// 只认 file map 里登记过的路径（pnpm 真实路径），于是报
// `Unable to resolve module ./node_modules/expo-router/entry`。
// 改用工程内的真实文件作为入口，再由它按包名引入 expo-router 官方入口，交给 Metro 的
// node_modules 解析（该路径对符号链接的处理是正常的）。
import 'expo-router/entry'
