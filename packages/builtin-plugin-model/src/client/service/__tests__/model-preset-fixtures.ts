import type { PresetTable } from '../../../shared/model-presets'

export const PRESET_FIXTURE: PresetTable = {
  'claude-3-5-sonnet': [1, 0, 200000, 8192],
  'deepseek-reasoner': [0, 1, 131072, 65536],
  'gemini-2.5-flash': [1, 1, 1048576, 65535],
  'gpt-4o': [1, 0, 128000, 16384],
  'kimi-k2-thinking': [0, 1, 262144, 262144],
  'mimo-v2-flash': [0, 1, 131072, 32768],
  'o3': [1, 1, 200000, 100000],
  'qwen3-32b': [0, 1, 40960, 40960],
}
