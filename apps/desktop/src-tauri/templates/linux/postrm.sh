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

profile_exe() {
    sed -n 's/^profile "\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

parser=$(parser_bin) || parser=

for profile_file in /etc/apparmor.d/dsh-tauri-*; do
    [ -f "$profile_file" ] || continue
    exe=$(profile_exe "$profile_file")
    [ -n "$exe" ] || continue
    [ -e "$exe" ] && continue
    if [ -n "$parser" ]; then
        "$parser" -R "$profile_file" >/dev/null 2>&1 || true
    fi
    case "${1:-}" in
        remove|purge) rm -f "$profile_file" 2>/dev/null || true ;;
    esac
done

exit 0
