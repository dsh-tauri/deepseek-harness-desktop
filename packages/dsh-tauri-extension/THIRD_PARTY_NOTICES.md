# Third-party notices

## qinyre/dsh-plugin-capabilities

- Repository: <https://github.com/qinyre/dsh-plugin-capabilities>
- Version: `0.3.11`
- Revision: `52e3f664dbe1c9f1166ea3cf4e7416d5352f3ee9`
- Baseline adopted: `3412f8ddf0a92bdc89a3bab104b480f8745ebfc1`
- Source: `source/dsh-plugin-capabilities`
- License: MIT — Copyright (c) 2026 qinyre
- Adapted: the Skills and MCP manager; the submodule retains the full upstream source and license.

## anthropics/skills

- Repository: <https://github.com/anthropics/skills>
- License: Apache-2.0 — `LICENSE.txt` retained
- Packaged: `skills/skill-creator`

## vercel-labs/skills

- Repository: <https://github.com/vercel-labs/skills>
- License: MIT — `LICENSE` retained
- Packaged: `skills/find-skills`

## deepseek-ai/deepseek-harness

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `dsh-v0.2.0-rc.2`
- Revision: `639ed015397290b3745d163aafe02ffee4aa3f84`
- Source: `source/deepseek-harness`
- Catalog pin: `dsh:` → `0.2.0-rc.2` (`pnpm-workspace.yaml`)
- License: MIT — Copyright (c) 2026 DeepSeek
- Not copied: the manager drives the official Host plugins instead of re-implementing them.

Official contracts used:

- Skills provider: `src/host/service/provider.utils.ts` imports the official `@deepseek-ai/dsh-skill-filesystem` through the platform loader; `src/host/service/provider.ts` re-mounts it with `customSkillDirs` = packaged `skills/` + managed skill roots + agent roots.
- Skill policy: `src/host/server/routes/skill/policy/post.ts` calls the official `setPolicy(path, enabled)`.
- Skill format and roots: `SKILL.md` directory bundle or flat `<name>.md` with YAML frontmatter, in the official project/custom/user priority order, including the official `user-dsh` root `<DSH_HOME>/skills`.
- MCP: every `cordis.patch.yml` row is an official `@deepseek-ai/dsh-mcp-client` instance (`MCP_PLUGIN` in `src/host/config/constants.ts`) using the official `serverName` / `transport` / `command` / `args` / `env` / `cwd` or `url` / `headers` shape.
- MCP config subset: the official `toolCallTimeoutMs`, `failOnStartupError`, `maxInstructionBytes` and `reconnect` keys are not surfaced yet.
- MCP resources: left to the official `@deepseek-ai/dsh-mcp-resources`; this package adds no resource tooling.

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
