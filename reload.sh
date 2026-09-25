#!/usr/bin/env bash
# Recompila el schema y recarga GNOME Shell (solo X11).
set -e
cd "$(dirname "$0")"
glib-compile-schemas schemas/
if [ "$XDG_SESSION_TYPE" = "x11" ]; then
    dbus-send --session --type=method_call --dest=org.gnome.Shell \
        /org/gnome/Shell org.gnome.Shell.Eval \
        string:'Meta.restart("Recargando…")' >/dev/null 2>&1 \
        || echo "Eval bloqueado: recargá con Alt+F2 -> r"
else
    echo "Wayland: cerrá y volvé a iniciar sesión para recargar."
fi
