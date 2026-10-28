<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop">
    <img src="public/deepseek-harness-desktop-tauri.svg" width="96" alt="DeepSeek Harness Tauri Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Tauri Desktop</h1>

<p align="center">
  Запустите <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> на своём десктопе —<br />
  без ручной настройки Node.js, pnpm или Docker; стандартной установке при первом запуске может потребоваться инициализация сети.
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB0PSIxNzI2MzA1OTcxMDA2IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE1NDgiIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48cGF0aCBkPSJNNTI3LjI3NTU1MTYxIDk2Ljk3MTAzMDEzdjM3My45OTIxMDY2N2g0OTQuNTEzNjE5NzVWMTUuMDI2NzU3NTN6TTUyNy4yNzU1NTE2MSA5MjguMzIzNTA4MTVsNDk0LjUxMzYxOTc1IDgwLjUyMDI4MDQ5di00NTUuNjc3NDcxNjFoLTQ5NC41MTM2MTk3NXpNNC42NzA0NTEzNiA0NzAuODMzNjgyOTdINDIyLjY3Njg1OTI1VjExMC41NjM2ODE5N2wtNDE4LjAwNjQwNzg5IDY5LjI1Nzc5NzUzek00LjY3MDQ1MTM2IDg0Ni43Njc1OTcwM0w0MjIuNjc2ODU5MjUgOTE0Ljg2MDMxMDEzVjU1My4xNjYzMTcwM0g0LjY3MDQ1MTM2eiIgcC1pZD0iMTU0OSIgZmlsbD0iI2ZmZmZmZiI+PC9wYXRoPjwvc3ZnPg==" />
  <img alt="MacOS" src="https://img.shields.io/badge/-MacOS-black?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri/deepseek-harness-desktop?&label=Release&color=4D6BFE" alt="Релиз" />
  </a>
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.4-4d6bfe" alt="Рекомендуемый DSH 0.2.1-rc.4" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop" alt="Лицензия MIT" />
  <br>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?&label=downloads&color=4D6BFE" alt="Загрузки" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?&label=stars&color=4D6BFE" alt="Звёзды" />
  <img src="https://img.shields.io/github/contributors/dsh-tauri/deepseek-harness-desktop?&label=contributors&color=4D6BFE" alt="Участники" />
  <img src="https://img.shields.io/github/commit-activity/m/dsh-tauri/deepseek-harness-desktop?&label=commits&color=4D6BFE" alt="Активность коммитов" />
</p>

<p align="center">
  <samp><a href="https://dshtauri.mintlify.site/en/installation">Скачать</a> · <a href="./README.en.md">English</a> · <strong><a href="./README.ru.md">Русский</a></strong> · <a href="./README.es.md">Español</a> · <a href="./README.ko.md">한국어</a> · <a href="https://dshtauri.mintlify.site">Документация</a> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <a href="https://trendshift.io/developers/13307?utm_source=developer-badge&amp;utm_medium=badge&amp;utm_campaign=badge-developer-13307" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/developers/13307" alt="hairyf | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <img src="./docs/images/hero-en.png" width="100%" alt="Баннер DSH Desktop" />
</p>

## Возможности

- 🪶 **Нативный десктоп** — Tauri 2 + React 19 + HeroUI 3, встраивание локального интерфейса Harness.
- 📱 **Дистанционное подключение** — отсканируйте QR-код в приложении Android / iOS, чтобы подключиться к DSH на вашем компьютере через LAN или публичный туннель Cloudflare.
- 🔄 **Управление средой выполнения** — установка зависимостей, выбор версий ядра и доступ к обновлениям десктопа/ядра.
- 🧩 **Управление плагинами** — 12 встроенных плагинов, а также установка из локального каталога, отключение встроенных, установка плагинов сообщества, обновления, удаление и детали ошибок.
- 🗂️ **Конфигурация профилей** — отдельные конфигурации плагинов/настроек с переносом, резервным копированием и клонированием данных профиля в один клик.
- 💽 **Каталог данных** — выбор места хранения данных при установке (Windows); позже в «Настройках» на Windows, macOS и Linux каталог можно перенести или откатить.
- ⌨️ **Интеграция с CLI** — управляемые команды `dsh` / `pnpm` через shim-обёртки, а не глобальная установка ядра npm.
- 🐾 **Десктопные питомцы** — ресурсы Pets / Codex, импорт пакетов и активность в диалоге; предустановленные медиа берутся с удалённых хостов.
- 🎨 **Персонализация** — 8 палитр, локальное масштабирование интерфейса, режим терминала, регулируемая прозрачность и необязательное матовое размытие.

## Встроенные плагины

Собственные плагины, распространяемые вместе с десктопными ресурсами:

- [DSH Tauri](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri) — основной плагин: связь десктопа с Harness, адаптеры версий и управление зависимостями плагинов
- [DSH Tauri UI](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-ui) — интерфейс настроек десктопа, нативные компоненты ядра, темы и палитры
- [DSH Tauri Mobile UI](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-mobile-ui) — сенсорные макеты и мобильные параметры
- [DSH Tauri Worktree](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-worktree) — Git worktrees и checkout на уровне сессии
- [DSH Tauri Extension](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-extension) — официальный менеджер плагинов, магазин плагинов, Skills и MCP
- [DSH Tauri Scheduler](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-scheduler) — плановые задачи и история запусков
- [DSH Tauri Archive](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-archive) — архивирование и восстановление чата
- [DSH Tauri Pet](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-pet) — настройки десктопного питомца и состояния активности
- [DSH Tauri Rightclick Menu](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-rightclick) — контекстные меню сессии, рабочей области и текста
- [DSH Tauri Model](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-model) — выбор модели, параметры и автоматическая конфигурация
- [DSH Tauri Remote](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-remote) — дистанционные подключения к Harness и синхронизация по SSH, а также шаринг локального Harness по LAN или публичному туннелю
- [DSH Tauri Notification](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-notification) — уведомления и действия диалога

## Необязательные пресеты

При установке предлагаются следующие плагины сообщества для установки по требованию.

- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — боковая панель редактора для каждой сессии
- [Billion Context](https://github.com/ranxianglei/billion-context) — сжатие контекста и восстановление истории
- [DSH Office Kit](https://github.com/hairyf/dsh-office-kit) — офисные документы, PDF, презентации и таблицы
- [DSH Market](https://github.com/dsh-market/dsh-market) — магазин плагинов сообщества
- [DSH Rewind](https://github.com/SiriLee/dsh-rewind) — откат диалога и резервные копии рабочей области
- [DSH IM](https://github.com/xmanrui/dsh-im) — IM-каналы и управление ботами
- [DSH OPS](https://github.com/T-Auto/dsh-ops) — инструменты низкоуровневых операций для сокращения расхода токенов и времени выполнения задач

Запросите новые или обновлённые пресеты через [Issues](https://github.com/dsh-tauri/deepseek-harness-desktop/issues). Доступные версии подчиняются правилам совместимости с ядром из манифеста.

## Быстрый старт

Скачайте установщик для вашей платформы и архитектуры на странице [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases):

| Платформа | Требования | Установщик |
| --- | --- | --- |
| Windows | Windows 10+, WebView2 | x64 `.exe` / `.msi` |
| macOS | macOS 12+; веб-интерфейсу требуются возможности Safari 17.4+ | Intel / Apple Silicon `.dmg` |
| Linux | библиотеки WebKit2GTK 4.1 (runtime) | x64 `.AppImage` / `.deb` |

macOS также поддерживает установку через Homebrew:

```bash
brew install dsh-tauri/desktop/deepseek-harness
```

- Стандартным установщикам при первом запуске нужен доступ в сеть для загрузки отсутствующих компонентов среды/ядра. Для Git-функций требуется доступный Git.
- Имена с суффиксом `Bundle` — офлайн-установщики (`_Bundle_*.exe`, `_Bundle_*.deb` и два `_Bundle_*.dmg`).
- Локальное выполнение не полностью офлайн: сервисы моделей, установка плагинов, обновления и предустановленные медиа питомцев по-прежнему могут использовать сеть.
- Особенности отображения на Linux, Wayland, AppImage и разрешения смотрите в [документации по установке и устранению неполадок](https://dshtauri.mintlify.site/en/help/troubleshooting).

### Прокси десктопа

- Задайте прокси HTTP, HTTPS, SOCKS5 или SOCKS5H в **Конфигурация → Приложение → Proxy URL**.
- Действует только для загрузок среды/ядра десктопа, проверок обновлений и метаданных плагинов — не для запросов моделей и сети подпроцессов плагинов.
- Если поле пусто, используются системные/окружающие настройки. Сохранённые изменения применяются к новым запросам; после этого повторите неудачные загрузки.
- SOCKS5H разрешает имена целевых хостов через прокси; loopback-соединения остаются прямыми.

## Поддержка мобильных устройств

**DSH Mobile** обращается к Harness на вашем компьютере через LAN или публичный туннель; ядро на телефоне не работает.

- **Android**: скачайте APK на [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases).
- **iOS**: установите бета-версию по [приглашению TestFlight](https://testflight.apple.com/join/kYXkpnp1), в зависимости от одобрения и свободных мест. Неподписанные IPA в Releases требуют вашей собственной подписи.

Включите шаринг в **Share** на верхней панели десктопа, затем отсканируйте QR-код для сопряжения. Держите компьютер, Harness и любой туннель в сети. Доступ не является доступом только для чтения; не разглашайте QR-код и коды доступа. См. [руководство по мобильному удалённому доступу](https://dshtauri.mintlify.site/en/guides/mobile-remote-access).

Приложение поддерживается только до запуска официального мобильного сервиса. Подробности разработки — в [мобильной спецификации](docs/specs/native.md).

## Среда выполнения

Ошибки запуска Windows показываются в нативном диалоге с исходной ошибкой. Для `STARTUP_LOW_INTEGRITY`:

- Процесс работает ниже целостности Medium и не может записывать обычные пользовательские данные; обновления могут наследовать метку Low каталога.
- Осмотрите каталог и исполняемый файл через `icacls`. Верните доверенную установку на Medium или переустановите в обычный каталог.
- Запуск от имени администратора не снимает ограничение метки Low. Не меняйте сессии и `DSH_HOME`.

| Текущая база | Версия |
| --- | --- |
| Рекомендуемое ядро Harness | `0.2.1-rc.4` |
| Минимальная поддерживаемая версия ядра | `0.2.1-rc.4`; это не гарантия совместимости с каждым плагином |

Более старые ядра больше не поддерживаются. Ранее записанные сведения о совместимости описывают историю, а не текущий диапазон поддержки.

- Выбор ядра и пресетов следует [манифесту ресурсов](<./src-tauri/resources/manifest.jsonc>) и объявленным диапазонам версий плагинов, а не обещанию совместимости с произвольными последними релизами upstream.
- Интеграция с CLI включена по умолчанию в релизе: Windows / macOS / Linux автоматически обновляют PATH. Переоткройте терминал; другим shell-оболочкам всё ещё может потребоваться ручная настройка.

## Сообщество

<table>
  <tr>
    <td align="center"><img src="./docs/images/community/qq.png" width="180" height="180" alt="QR-код группы QQ" /><br /><strong>Группа QQ</strong></td>
    <td align="center"><img src="./docs/images/community/wechat.png" width="180" height="180" alt="QR-код группы WeChat" /><br /><strong>Группа WeChat (полная, сначала добавьте меня в WeChat) →</strong></td>
    <td align="center"><img src="./docs/images/community/wechat-hairy.png" width="180" height="180" alt="QR-код WeChat" /><br /><strong>WeChat</strong></td>
  </tr>
</table>

## Разработка

См. [английский гайд по разработке](<./docs/DEVELOPMENT.md>) или [китайский гайд по разработке](<./docs/DEVELOPMENT.zh.md>). Детали по функциям — в [онлайн-документации](https://dshtauri.mintlify.site).

## Примечания

> [!WARNING]
> **Превью для разработчиков** — upstream-`dsh` быстро развивается и может вносить несовместимые изменения; проверяйте совместимость перед обновлением.

> [!NOTE]
> **Безопасность** — `dsh` может выполнять код локально. Только для обучения / исследований / тестов; запускайте в доверенной изолированной среде.

## Выбор сообщества

- [dsh-tauri-notify-webhook](https://github.com/iuuuuuuuu/dsh-tauri-notify-webhook) — пересылка уведомлений в webhook, почту (SMTP) или pushplus при аварийной остановке или завершении задачи — @iuuuuuuuu
- [dsh-pdf-reader](https://github.com/SkanderBog/dsh-pdf-reader) — постраничное чтение PDF, локальный OCR, цитаты, поиск и визуальное кроппирование — @SkanderBog
- [dsh-context-manager](https://github.com/SkanderBog/dsh-context-manager) — просмотр контекста перед применением и выбор по каждой группе полной истории: оставить, резюмировать или пропустить ранний контент — @SkanderBog
- [@ryuu-64/dsh-find-all](https://github.com/Ryuu-64/dsh-find-all) — Ctrl+F в текущем диалоге для поиска сохранённой истории — @Ryuu-64

## Связанное

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — upstream-платформа агента `dsh`
- [deepseek-harness-pkg](https://github.com/dsh-tauri/deepseek-harness-pkg) — предварительно собранные дистрибутивы Harness и источник загрузок
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/dsh-tauri/dsh-pet-component) — ассеты питомцев и рендерер
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — референсные проекты питомцев

## Вкладчики

![Участники](https://contrib.rocks/image?repo=dsh-tauri/deepseek-harness-desktop)

## Лицензия

[MIT](<./LICENSE>) с [условием некоммерческого использования](<./LICENSE.details>) © участники проекта deepseek-harness-desktop
