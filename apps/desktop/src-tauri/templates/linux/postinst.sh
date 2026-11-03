#!/bin/sh

parser_bin() {
    if [ -x /usr/sbin/apparmor_parser ]; then
        printf '%s' /usr/sbin/apparmor_parser
    elif command -v apparmor_parser >/dev/null 2>&1; then
        command -v apparmor_parser
    else
        return 1
    fi
}

apparmor_enabled() {
    [ -r /sys/module/apparmor/parameters/enabled ] || return 1
    [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ]
}

slug() {
    printf '%s' "$1" | sed -e 's/[^A-Za-z0-9]/-/g' | tr 'A-Z' 'a-z'
}

emit_profile() {
    if [ -f /etc/apparmor.d/abi/4.0 ]; then
        printf 'abi <abi/4.0>,\n'
    fi
    printf 'include <tunables/global>\n\n'
    printf 'profile "%s" "%s" flags=(unconfined) {\n' "$1" "$1"
    printf '  userns,\n\n'
    printf '  include if exists <local/dsh-tauri>\n'
    printf '}\n'
}

install_profile() {
    exe=$1
    file=$2
    tmp="$file.tmp.$$"
    emit_profile "$exe" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
    if ! "$parser" -Q "$tmp" >/dev/null 2>&1; then
        rm -f "$tmp"
        return 1
    fi
    chmod 0644 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$file" 2>/dev/null || { rm -f "$tmp"; return 1; }
    "$parser" --replace --write-cache "$file" >/dev/null 2>&1 || true
    return 0
}

package_sandboxes() {
    [ -n "${DPKG_MAINTSCRIPT_PACKAGE:-}" ] || return 1
    command -v dpkg >/dev/null 2>&1 || return 1
    dpkg -L "$DPKG_MAINTSCRIPT_PACKAGE" 2>/dev/null | grep -E '/runtime/[^/]+/chrome-sandbox$'
}

sandboxes=$(package_sandboxes) || sandboxes=
[ -n "$sandboxes" ] || exit 0

parser=$(parser_bin) || parser=
profiles=false
if [ -n "$parser" ] && apparmor_enabled && [ -d /etc/apparmor.d ]; then
    profiles=true
fi

printf '%s\n' "$sandboxes" | while IFS= read -r sandbox; do
    [ -f "$sandbox" ] || continue
    chown root:root "$sandbox" 2>/dev/null || true
    chmod 0755 "$sandbox" 2>/dev/null || true
    [ "$profiles" = true ] || continue
    runtime_dir=$(dirname "$sandbox")
    app_dir=$(basename "$(dirname "$(dirname "$runtime_dir")")")
    arch_dir=$(basename "$runtime_dir")
    prefix="/etc/apparmor.d/dsh-tauri-$(slug "$app_dir")-$(slug "$arch_dir")"
    for exe in "$runtime_dir"/*; do
        [ -f "$exe" ] || continue
        [ -x "$exe" ] || continue
        case "$exe" in
            */chrome-sandbox|*/chrome_crashpad_handler|*.so|*.so.*|*.pak|*.dat|*.bin|*.node) continue ;;
        esac
        install_profile "$exe" "$prefix-$(slug "$(basename "$exe")")"
    done
done

exit 0
