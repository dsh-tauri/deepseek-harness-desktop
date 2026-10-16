import { defineConfig } from 'bumpp'

export default defineConfig({
  release: 'prompt',
  files: [
    'package.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'app.json',
  ],
})
