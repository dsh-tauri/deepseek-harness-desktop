<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop">
    <img src="public/deepseek-harness-desktop-tauri.svg" width="96" alt="DeepSeek Harness Tauri Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Tauri Desktop</h1>

<p align="center">
  데스크톱에서 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>를 실행하세요 —<br />
  Node.js, pnpm, Docker를 수동으로 설정할 필요가 없습니다. 일반 설치 시 첫 실행에서 네트워크를 통한 초기화가 필요할 수 있습니다.
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB0PSIxNzI2MzA1OTcxMDA2IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjE1NDgiIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48cGF0aCBkPSJNNTI3LjI3NTU1MTYxIDk2Ljk3MTAzMDEzdjM3My45OTIxMDY2N2g0OTQuNTEzNjE5NzVWMTUuMDI2NzU3NTN6TTUyNy4yNzU1NTE2MSA5MjguMzIzNTA4MTVsNDk0LjUxMzYxOTc1IDgwLjUyMDI4MDQ5di00NTUuNjc3NDcxNjFoLTQ5NC41MTM2MTk3NXpNNC42NzA0NTEzNiA0NzAuODMzNjgyOTdINDIyLjY3Njg1OTI1VjExMC41NjM2ODE5N2wtNDE4LjAwNjQwNzg5IDY5LjI1Nzc5NzUzek00LjY3MDQ1MTM2IDg0Ni43Njc1OTcwM0w0MjIuNjc2ODU5MjUgOTE0Ljg2MDMxMDEzVjU1My4xNjYzMTcwM0g0LjY3MDQ1MTM2eiIgcC1pZD0iMTU0OSIgZmlsbD0iI2ZmZmZmZiI+PC9wYXRoPjwvc3ZnPg==" />
  <img alt="MacOS" src="https://img.shields.io/badge/-MacOS-black?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri/deepseek-harness-desktop?&label=Release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.2-4d6bfe" alt="Recommended DSH 0.2.1-rc.2" />
  <img src="https://img.shields.io/github/license/dsh-tauri/deepseek-harness-desktop" alt="MIT License" />
  <br>
  <img src="https://img.shields.io/github/downloads/dsh-tauri/deepseek-harness-desktop/total?&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri/deepseek-harness-desktop?&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/dsh-tauri/deepseek-harness-desktop?&label=contributors&color=4D6BFE" alt="Contributors" />
  <img src="https://img.shields.io/github/commit-activity/m/dsh-tauri/deepseek-harness-desktop?&label=commits&color=4D6BFE" alt="Commit activity" />
</p>

<p align="center">
  <samp><a href="https://dshtauri.mintlify.site/en/installation">Download</a> · <a href="./README.en.md">English</a> · <a href="./README.es.md">Español</a> · <strong>한국어</strong> · <a href="https://dshtauri.mintlify.site">Docs</a> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
  <a href="https://trendshift.io/developers/13307?utm_source=developer-badge&amp;utm_medium=badge&amp;utm_campaign=badge-developer-13307" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/developers/13307" alt="hairyf | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <img src="./docs/images/hero-en.png" width="100%" alt="DSH Desktop banner" />
</p>

## 기능

- 🪶 **네이티브 데스크톱** — Tauri 2 + React 19 + HeroUI 3 기반으로 로컬 Harness UI를 내장합니다.
- 📱 **원격 연결** — Android / iOS 앱에서 QR 코드를 스캔하여 LAN 또는 Cloudflare 공개 터널을 통해 컴퓨터의 DSH에 연결합니다.
- 🔄 **런타임 관리** — 의존성을 설치하고 코어 버전을 선택하며, 데스크톱과 코어 업데이트 기능을 이용할 수 있습니다.
- 🧩 **플러그인 관리** — 12개의 내장 플러그인을 제공하며, 로컬 디렉터리에서 설치, 내장 플러그인 비활성화, 커뮤니티 플러그인 설치, 업그레이드, 제거, 오류 상세 정보 확인을 지원합니다.
- 🗂️ **프로필 구성** — 프로필별로 플러그인과 설정을 분리하고, 클릭 한 번으로 프로필 데이터를 이전, 백업, 복제할 수 있습니다.
- 💽 **데이터 디렉터리** — 설치 시 데이터 저장 위치를 선택하고(Windows), 나중에 Windows, macOS, Linux의 설정에서 이전하거나 되돌릴 수 있습니다.
- ⌨️ **CLI 통합** — npm을 통한 전역 코어 설치가 아니라, 관리형 shim을 통해 `dsh` / `pnpm` 명령어를 제공합니다.
- 🐾 **데스크톱 펫** — Pets / Codex 리소스, 팩 가져오기, 대화 활동 표시를 지원합니다. 사전 설정된 미디어는 원격 호스트에서 가져옵니다.
- 🎨 **개인화** — 8가지 색상 팔레트, 로컬 UI 배율 조정, 터미널 모드, 불투명도 조절, 선택적 반투명 블러 효과를 제공합니다.

## 내장 플러그인

데스크톱 리소스와 함께 배포되는 자체 개발 플러그인입니다:

- [DSH Tauri](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri) — 핵심 플러그인: 데스크톱과 Harness 간 통신, 버전 어댑터, 플러그인 의존성 관리
- [DSH Tauri UI](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-ui) — 데스크톱 설정 UI, 네이티브 코어 구성 요소, 테마, 색상 팔레트
- [DSH Tauri Mobile UI](https://github.com/dsh-tauri/deepseek-harness-desktop/tree/main/packages/dsh-tauri-mobile-ui) — 터치 레이아웃과 모바일 환경 설정
- [DSH Tauri Worktree](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-worktree) — 세션 단위 Git 워크트리와 체크아웃
- [DSH Tauri Extension](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-extension) — 공식 플러그인 관리자, 플러그인 마켓, Skills, MCP
- [DSH Tauri Scheduler](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-scheduler) — 예약 작업과 실행 기록
- [DSH Tauri Archive](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-archive) — 대화 보관과 복원
- [DSH Tauri Pet](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-pet) — 데스크톱 펫과 활동 상태 설정
- [DSH Tauri Rightclick Menu](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-rightclick) — 세션, 작업 공간, 텍스트의 컨텍스트 메뉴
- [DSH Tauri Model](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-model) — 모델 선택, 매개변수, 자동 구성
- [DSH Tauri Remote](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-remote) — SSH를 통한 원격 Harness 연결 및 동기화, LAN 또는 공개 터널을 통한 로컬 Harness 공유
- [DSH Tauri Notification](https://dshtauri.mintlify.site/en/built-in-plugins/dsh-tauri-notification) — 대화 알림과 관련 동작

## 선택적 프리셋

초기 설정 과정에서 다음 커뮤니티 플러그인을 필요에 따라 설치할 수 있습니다.

- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — 세션별 편집기 사이드바
- [Billion Context](https://github.com/ranxianglei/billion-context) — 컨텍스트 압축과 기록 복원
- [DSH Office Kit](https://github.com/hairyf/dsh-office-kit) — Office 문서, PDF, 프레젠테이션, 스프레드시트
- [DSH Market](https://github.com/dsh-market/dsh-market) — 커뮤니티 플러그인 마켓
- [DSH Rewind](https://github.com/SiriLee/dsh-rewind) — 대화 되감기와 작업 공간 백업
- [DSH IM](https://github.com/xmanrui/dsh-im) — IM 채널과 봇 관리
- [DSH OPS](https://github.com/T-Auto/dsh-ops) — 토큰 사용량과 작업 실행 시간을 줄이는 저수준 작업 도구

프리셋 추가나 업데이트는 [Issues](https://github.com/dsh-tauri/deepseek-harness-desktop/issues)를 통해 요청하세요. 사용 가능한 버전은 매니페스트의 코어 호환성 규칙을 따릅니다.

## 빠른 시작

[Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases)에서 사용 중인 플랫폼과 아키텍처에 맞는 설치 프로그램을 다운로드하세요:

| 플랫폼 | 요구 사항 | 설치 프로그램 |
| --- | --- | --- |
| Windows | Windows 10+, WebView2 | x64 `.exe` / `.msi` |
| macOS | macOS 12+; 웹 UI는 Safari 17.4+ 수준의 기능 필요 | Intel / Apple Silicon `.dmg` |
| Linux | WebKit2GTK 4.1 런타임 라이브러리 | x64 `.AppImage` / `.deb` |

macOS에서는 Homebrew로도 설치할 수 있습니다:

```bash
brew install dsh-tauri/desktop/deepseek-harness
```

Fedora 43+(x64 / ARM64)에서는 Copr 저장소로 설치할 수 있습니다. 업데이트는 `dnf upgrade`로 받으며 앱 내 업데이트는 비활성화됩니다. 프리릴리스를 쓰려면 `dsh-tauri-beta`를 설치하세요(`dsh-tauri`와 동시에 설치할 수 없으며 `sudo dnf swap dsh-tauri dsh-tauri-beta`로 전환합니다):

```bash
sudo dnf copr enable fairyband/dsh-tauri
sudo dnf install dsh-tauri        # 정식 버전
```

- 일반 설치 프로그램은 첫 실행 시 누락된 런타임 및 코어 구성 요소를 다운로드하기 위해 네트워크가 필요합니다. Git 기능을 사용하려면 Git을 실행할 수 있어야 합니다.
- 이름에 `Bundle` 접미사가 있는 파일은 오프라인 설치 프로그램입니다(`_Bundle_*.exe`, `_Bundle_*.deb`, 두 종류의 `_Bundle_*.dmg`).
- 로컬 실행이 완전한 오프라인 실행을 의미하지는 않습니다. 모델 서비스, 플러그인 설치, 업데이트, 사전 설정된 펫 미디어는 여전히 네트워크를 사용할 수 있습니다.
- Linux 화면 표시, Wayland, AppImage, 권한 문제의 해결 방법은 [설치 및 문제 해결 문서](https://dshtauri.mintlify.site/en/help/troubleshooting)를 참고하세요.

### 데스크톱 프록시

- **구성 → 애플리케이션 → 프록시 URL**에서 HTTP, HTTPS, SOCKS5 또는 SOCKS5H 프록시를 설정하세요.
- 데스크톱 런타임 및 코어 다운로드, 업데이트 확인, 플러그인 메타데이터에만 적용됩니다. 모델 요청이나 플러그인 하위 프로세스의 네트워크 통신에는 적용되지 않습니다.
- 비워 두면 시스템 및 환경 설정을 따릅니다. 저장한 변경 사항은 새 요청부터 적용되므로, 이후 실패한 다운로드를 다시 시도하세요.
- SOCKS5H는 프록시를 통해 대상 이름을 해석하며, 루프백 연결은 계속 직접 연결됩니다.

## 모바일 지원

**DSH Mobile**은 LAN 또는 공개 터널을 통해 컴퓨터의 Harness에 접속하며, 휴대폰에서 코어를 실행하지 않습니다.

- **Android**: [Releases](https://github.com/dsh-tauri/deepseek-harness-desktop/releases)에서 APK를 다운로드하세요.
- **iOS**: [TestFlight 초대](https://testflight.apple.com/join/kYXkpnp1)를 통해 베타 버전을 설치하세요. 승인 여부와 잔여 인원에 따라 이용이 제한될 수 있습니다. Releases의 서명되지 않은 IPA는 직접 서명해야 합니다.

데스크톱 상단 표시줄의 **공유**에서 공유를 활성화한 뒤 QR 코드를 스캔하여 페어링하세요. 컴퓨터, Harness, 사용 중인 터널을 모두 온라인 상태로 유지해야 합니다. 원격 접속은 읽기 전용이 아니므로 QR 코드와 접근 코드를 비공개로 유지하세요. [모바일 원격 접속 가이드](https://dshtauri.mintlify.site/en/guides/mobile-remote-access)를 참고하세요.

이 앱은 공식 모바일 서비스가 출시될 때까지만 유지보수됩니다. 개발 관련 세부 사항은 [모바일 명세](docs/specs/native.md)를 참고하세요.

## 런타임

Windows에서 시작에 실패하면 네이티브 대화 상자에 원인 오류가 표시됩니다. `STARTUP_LOW_INTEGRITY`가 발생한 경우:

- 프로세스가 Medium보다 낮은 무결성 수준으로 실행되어 일반 사용자 데이터를 쓸 수 없는 상태입니다. 업데이트 시 폴더의 Low 레이블을 상속할 수 있습니다.
- `icacls`로 폴더와 실행 파일을 확인하세요. 신뢰할 수 있는 설치의 무결성 수준을 Medium으로 복원하거나, 일반 폴더에 다시 설치하세요.
- 관리자 권한으로 실행해도 Low 레이블 제한은 해제되지 않습니다. 세션과 `DSH_HOME`은 변경하지 마세요.

| 현재 기준 | 버전 |
| --- | --- |
| 권장 Harness 코어 | `0.2.1-rc.2` |
| 지원하는 최소 코어 | `0.1.7-rc.1`; 모든 플러그인의 호환성을 보장하지는 않음 |

이전 코어는 더 이상 지원하지 않습니다. 과거의 호환성 기록은 이력을 나타낼 뿐, 현재 지원 범위를 의미하지 않습니다.

- 코어와 프리셋 선택은 [리소스 매니페스트](<./src-tauri/resources/manifest.jsonc>)와 플러그인에 선언된 버전 범위를 따릅니다. 임의의 최신 업스트림 릴리스와의 호환성을 보장하는 것은 아닙니다.
- 정식 릴리스에서는 CLI 통합이 기본으로 활성화됩니다. Windows / macOS / Linux에서 PATH가 자동으로 업데이트됩니다. 터미널을 다시 여세요. 다른 셸은 여전히 수동 설정이 필요할 수 있습니다.

## 커뮤니티

<table>
  <tr>
    <td align="center"><img src="./docs/images/community/qq.png" width="180" height="180" alt="QQ group QR code" /><br /><strong>QQ 그룹</strong></td>
    <td align="center"><img src="./docs/images/community/wechat.png" width="180" height="180" alt="WeChat group QR code" /><br /><strong>WeChat 그룹 (정원 마감, 먼저 WeChat에서 저를 추가하세요) →</strong></td>
    <td align="center"><img src="./docs/images/community/wechat-hairy.png" width="180" height="180" alt="WeChat QR code" /><br /><strong>WeChat</strong></td>
  </tr>
</table>

## 개발

[영문 개발 가이드](<./docs/DEVELOPMENT.md>) 또는 [중문 개발 가이드](<./docs/DEVELOPMENT.zh.md>)를 참고하세요. 기능별 세부 사항은 [온라인 문서](https://dshtauri.mintlify.site)에서 확인할 수 있습니다.

## 참고 사항

> [!WARNING]
> **개발자 프리뷰** — 업스트림 `dsh`는 빠르게 발전하고 있어 호환성을 깨는 변경이 도입될 수 있습니다. 업그레이드 전에 호환성을 확인하세요.

> [!NOTE]
> **보안** — `dsh`는 로컬에서 코드를 실행할 수 있습니다. 학습 / 연구 / 테스트 용도로만 사용하고, 신뢰할 수 있는 격리된 환경에서 실행하세요.

## 커뮤니티 추천

- [dsh-tauri-notify-webhook](https://github.com/iuuuuuuuu/dsh-tauri-notify-webhook) - 작업이 비정상적으로 중단되거나 완료되면 webhook, 이메일(SMTP), pushplus로 알림 전달 · 제작: @iuuuuuuuu
- [dsh-pdf-reader](https://github.com/SkanderBog/dsh-pdf-reader) - 페이지별 PDF 읽기, 로컬 OCR, 인용, 검색, 시각적 자르기 · 제작: @SkanderBog
- [dsh-context-manager](https://github.com/SkanderBog/dsh-context-manager) - 적용 전 컨텍스트를 검토하고, 전체 기록 그룹별로 이전 내용을 유지, 요약 또는 생략할지 선택 · 제작: @SkanderBog
- [@ryuu-64/dsh-find-all](https://github.com/Ryuu-64/dsh-find-all) - 현재 대화에서 Ctrl+F로 저장된 기록 검색 · 제작: @Ryuu-64

## 관련 프로젝트

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 업스트림 `dsh` 에이전트 플랫폼
- [deepseek-harness-pkg](https://github.com/dsh-tauri/deepseek-harness-pkg) — 사전 빌드된 Harness 배포판과 다운로드 소스
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) · [dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) · [dsh-pet-component](https://github.com/dsh-tauri/dsh-pet-component) — 펫 리소스와 렌더러
- [dsh-plugin-codex-pets](https://github.com/Skylarking/dsh-plugin-codex-pets) · [BongoCat](https://github.com/ayangweb/BongoCat) · [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) · [codex-to-dsh-pet](https://github.com/Signalight/codex-to-dsh-pet) — 펫 참고 프로젝트

## 기여자

![Contributors](https://contrib.rocks/image?repo=dsh-tauri/deepseek-harness-desktop)

## 라이선스

[MIT](<./LICENSE>)에 [비상업적 이용 조건](<./LICENSE.details>)이 추가로 적용됩니다. © deepseek-harness-desktop contributors
