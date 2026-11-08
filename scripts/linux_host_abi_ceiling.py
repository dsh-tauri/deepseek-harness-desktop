#!/usr/bin/env python3
"""镜像向宿主索要的库版本符号契约检查。

镜像把 NSS / OpenSSL / krb5 交还宿主后，主程序仍会向宿主索要版本符号（NSS_3.30、
OPENSSL_3.0.0 等）。这些符号名就是镜像对宿主的最低版本要求：超出契约意味着旧发行版
加载失败，而那正是 #1407（NSSUTIL_3.108 缺失导致 SIGTRAP）与 #1299（OPENSSL_3.5.0）
的形态。契约分两类：

- 上限：命名空间允许索要的最高版本，值取当前镜像实测需求，涨上去就必须先确认发行版基线。
- 禁止：这些命名空间的提供者已整体交还宿主（krb5 链被 #1412 删除），镜像内任何 ELF
  都不该再索要它们；一旦出现，说明又有库把 krb5 挂回镜像内部（#1407 的 libcups 悬空）。

GLIBC_ 不在这里判定，由 check-linux-glibc-abi.sh 的 --max 参数按产物逐文件检查。
输入是 stdin 上每行 LABEL<TAB>SYMBOL，直接来自 readelf --version-info 的 Name: 行。
"""

import sys

CEILINGS = {
    'NSS_': '3.30',
    'NSSUTIL_': '3.12.3',
    'OPENSSL_': '3.0.0',
}
FORBIDDEN = ('krb5_', 'krb5support_', 'gssapi_krb5_')
USAGE = 'usage: linux_host_abi_ceiling.py < labels-and-symbols'


def split_symbol(symbol):
    for index in range(1, len(symbol) - 1):
        if symbol[index] == '_' and symbol[index + 1].isdigit():
            return symbol[:index + 1], symbol[index + 1:]
    return symbol, ''


def version_key(version):
    key = []
    digits = ''
    for char in version:
        if char.isdigit():
            digits += char
            continue
        if digits:
            key.append((0, int(digits)))
            digits = ''
        key.append((1, char))
    if digits:
        key.append((0, int(digits)))
    return key


def exceeds(version, ceiling):
    left, right = version_key(version), version_key(ceiling)
    for index in range(max(len(left), len(right))):
        if index >= len(left):
            return False
        if index >= len(right):
            return True
        if left[index] != right[index]:
            return left[index] > right[index]
    return False


def inspect(lines):
    violations = []
    inspected = 0
    seen = set()
    for line in lines:
        line = line.rstrip('\r\n')
        if '\t' not in line:
            continue
        label, symbol = line.split('\t', 1)
        symbol = symbol.strip()
        if not symbol:
            continue
        namespace, version = split_symbol(symbol)
        if not version:
            continue
        if namespace in FORBIDDEN:
            inspected += 1
            seen.add(namespace)
            violations.append(f'LINUX_HOST_ABI_FORBIDDEN: {label} requires {symbol}, '
                              f'but {namespace}* is provided by the host only')
            continue
        ceiling = CEILINGS.get(namespace)
        if ceiling is None:
            continue
        inspected += 1
        seen.add(namespace)
        if exceeds(version, ceiling):
            violations.append(f'LINUX_HOST_ABI_CEILING: {label} requires {symbol}, '
                              f'which exceeds the host contract {namespace}{ceiling}')
    return violations, inspected, sorted(seen)


def main(argv):
    if argv:
        print(f'::error::LINUX_HOST_ABI_FAILED: {USAGE}', file=sys.stderr)
        return 2
    violations, inspected, namespaces = inspect(sys.stdin)
    for violation in violations:
        print(f'::error::{violation}', file=sys.stderr)
    print(f'linux-host-abi: {inspected} host-interface version symbol(s) across '
          f'{len(namespaces)} namespace(s): {" ".join(namespaces) or "none"}')
    if violations:
        print(f'::error::linux host ABI check failed: {len(violations)} violation(s)', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
