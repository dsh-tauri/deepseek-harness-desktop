# Copr make_srpm 入口：Copr 执行 `make -f .copr/Makefile srpm outdir=<dir> spec=<包的 spec 设置>`。
# Copr 只透传 outdir 与 spec 两个变量，包名借 spec 传递：beta 包把 spec 设为 `dsh-tauri-beta.spec`，
# spec 为空时按 dsh-tauri 构建。本地验证可直接 `make -f .copr/Makefile srpm name=dsh-tauri-beta`。
outdir ?= $(CURDIR)/.temp/copr
name ?= $(or $(basename $(filter %.spec,$(notdir $(spec)))),dsh-tauri)

srpm:
	sh $(dir $(lastword $(MAKEFILE_LIST)))srpm.sh "$(outdir)" "$(name)"

.PHONY: srpm
