<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  Ejecutá <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> en tu escritorio —<br />
  sin configurar Node.js, pnpm ni Docker manualmente; las instalaciones normales pueden necesitar red al iniciar.
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/dsh-0.2.0--rc.2-4D6BFE?style=flat-square" alt="dsh 0.2.0-rc.2" />
</p>

<p align="center">
  <samp><a href="./README.en.md">English</a> · <strong>Español</strong> · <a href="https://dshtauri.mintlify.site">Documentación</a> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="docs/PREVIEW.md">
    <img src="./docs/images/hero-en.png" width="100%" alt="Banner promocional de DSH Desktop" />
  </a>
</p>

## Características

- 🪶 **Escritorio nativo** — Tauri 2 + React 19, con la interfaz web local de Harness integrada.
- 🔄 **Gestión del runtime** — Instalá dependencias, elegí versiones del núcleo y accedé a actualizaciones del escritorio y del núcleo.
- 🧩 **Gestión de plugins** — 11 plugins integrados, más instalación, actualización, desinstalación y detalles de errores de plugins comunitarios.
- 🗂️ **Configuración por perfiles** — Separá plugins y ajustes; los perfiles no son un sandbox de seguridad del sistema operativo.
- 💽 **Directorio de datos** — En Windows, elegí dónde se guardan los datos al instalar, y migralo o revertilo después en Ajustes.
- ⌨️ **Integración con la terminal** — Shims administrados de `dsh` / `pnpm`, no una instalación global del núcleo por npm.
- 🐾 **Mascotas de escritorio** — Recursos Pets / Codex, importación de paquetes y actividad de conversaciones; los recursos predefinidos son remotos.
- 🎨 **Personalización** — 8 paletas, modo terminal y transparencia nativa, con restauración de valores predeterminados en un clic.

## Plugins integrados

Los 11 plugins propios distribuidos con los recursos del escritorio:

| Plugin | Paquete | Función |
| --- | --- | --- |
| [DSH Tauri](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri) | `dsh-tauri` | Comunicación entre el escritorio y Harness |
| [DSH Tauri UI](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-ui) | `dsh-tauri-ui` | Interfaz de ajustes del escritorio |
| [DSH Tauri Worktree](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-worktree) | `dsh-tauri-worktree` | Worktrees Git por sesión y checkout |
| [DSH Tauri Extension](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-extension) | `dsh-tauri-extension` | Skills, fuentes de skills y gestión de MCP |
| [DSH Tauri Scheduler](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-scheduler) | `dsh-tauri-scheduler` | Tareas programadas e historial |
| [DSH Tauri Archive](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-archive) | `dsh-tauri-archive` | Archivo y restauración de chats |
| [DSH Tauri Pet](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-pet) | `dsh-tauri-pet` | Mascotas y estados de actividad |
| [DSH Tauri Rightclick Menu](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-rightclick) | `dsh-tauri-rightclick` | Menús contextuales de sesiones, workspaces y texto |
| [DSH Tauri Model](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-model) | `dsh-tauri-model` | Selección de modelos y parámetros |
| [DSH Tauri SSH](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-ssh) | `dsh-tauri-ssh` | Conexiones Harness remotas y sincronización por SSH |
| [DSH Tauri Notification](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-notification) | `dsh-tauri-notification` | Notificaciones de conversaciones y acciones |

`dsh-tauri-experimental` es opcional, está desactivado por defecto y no cuenta entre los 11 integrados.

## Preajustes opcionales

El asistente ofrece estos 6 plugins comunitarios para instalar a demanda. Los primeros 5 son recomendados; Billion Context requiere selección explícita.

| Plugin | Paquete | Función |
| --- | --- | --- |
| [DSH Market](https://github.com/dsh-market/dsh-market) | `dshmarket` | Mercado de plugins comunitarios |
| [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | `dsh-better-sidebar` | Barra lateral del editor por sesión |
| [DSH Rewind](https://github.com/SiriLee/dsh-rewind) | `dsh-rewind-plugin` | Retroceso de conversación y backups del workspace |
| [DSH Bridge](https://github.com/wenbin-wb/dsh-bridge) | `@wenbin_wb/dsh-bridge` | Acceso remoto, túneles y conexión de bots |
| [DSH IM](https://github.com/xmanrui/dsh-im) | `@xmanrui/dsh-im` | Canales IM y gestión de bots |
| [Billion Context](https://github.com/ranxianglei/billion-context) | `billion-context` | Compresión de contexto y restauración del historial |

Pedí preajustes nuevos o actualizados mediante [Issues](https://github.com/dsh-tauri/deepseek-harness-desktop/issues). Las versiones disponibles siguen las reglas de compatibilidad del manifiesto.

## Inicio rápido

Descargá el instalador de tu plataforma y arquitectura desde [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases):

| Plataforma | Requisitos | Instalador |
| --- | --- | --- |
| Windows | Windows 10+, WebView2 | x64 `.exe` / `.msi` |
| macOS | macOS 12+; la interfaz web necesita capacidades de Safari 17.4+ | Intel / Apple Silicon `.dmg` |
| Linux | Bibliotecas de runtime WebKit2GTK 4.1 | x64 `.AppImage` / `.deb` |

En macOS también podés instalar por Homebrew:

```bash
brew install dsh-tauri/desktop/deepseek-harness
```

- Los instaladores normales necesitan red en el primer arranque para descargar los componentes faltantes del runtime y del núcleo. Las funciones Git necesitan un Git disponible.
- Usá un `Bundle` solo si ese release realmente incluye los recursos del runtime y del núcleo. **v0.20.0-beta.1 no tiene assets Bundle**.
- Ejecutar localmente no significa estar totalmente sin conexión: modelos, instalación de plugins, actualizaciones y recursos de mascotas predefinidas pueden usar red.
- Para problemas de pantalla, Wayland, AppImage y permisos en Linux, consultá la [documentación de instalación y solución de problemas](https://dshtauri.mintlify.site).

## Runtime

| Base actual | Versión |
| --- | --- |
| Escritorio | `0.20.0-beta.1` |
| Núcleo Harness recomendado | `0.2.0-rc.2` |
| Núcleo mínimo declarado | `0.1.5-rc.1`; no garantiza compatibilidad con todos los plugins |
| Runtime Node.js | `22.22.0` |
| pnpm | `11.7.0` |

- El backend Rust gestiona dependencias y el proceso Harness; el WebView React integra su interfaz. La versión release usa `http://127.0.0.1:3080` por defecto y puede cambiar el puerto si está ocupado.
- La selección del núcleo y los preajustes sigue el [manifiesto de recursos](<./src-tauri/resources/manifest.jsonc>) y los rangos declarados por los plugins; no garantiza compatibilidad con cualquier nueva versión oficial.
- La integración CLI está habilitada por defecto en release: Windows actualiza el PATH del usuario; macOS / Linux pueden agregar un bloque PATH administrado a Bash / Zsh. Reabrí la terminal; otros shells pueden requerir configuración manual.

## Comunidad

- [Unite a la comunidad de Discord](https://discord.gg/RT9As6Cj8B)

<table>
  <tr>
    <td align="center"><strong>Grupo QQ</strong><br /><img src="./docs/images/community/qq-qrcode.jpg" width="360" alt="QR del grupo QQ" /></td>
    <td align="center"><strong>Grupo WeChat</strong><br /><img src="./docs/images/community/wx-qrcode.png" width="360" alt="QR del grupo WeChat" /></td>
  </tr>
</table>

## Desarrollo

Consultá la [guía en inglés](<./docs/DEVELOPMENT.md>) o la [guía en chino](<./docs/DEVELOPMENT.zh.md>). Los detalles de funciones están en la [documentación online](https://dshtauri.mintlify.site).

## Notas

> [!WARNING]
> **Vista previa** — el `dsh` oficial evoluciona rápido y puede introducir cambios incompatibles; verificá la compatibilidad antes de actualizar.

> [!NOTE]
> **Seguridad** — `dsh` puede ejecutar código en tu máquina. Solo para aprender / investigar / probar; usalo en un entorno confiable y aislado.

## Relacionados

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — plataforma agent `dsh` oficial
- [deepseek-harness-pkg](https://github.com/dsh-tauri/deepseek-harness-pkg) — distribuciones Harness prearmadas y fuente de descarga
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/hairyf/dsh-pet-component) — recursos y render de mascotas
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — proyectos de referencia de mascotas

## Licencia

[MIT](<./LICENSE>) con [condición no comercial](<./LICENSE.details>) © deepseek-harness-desktop contributors
