import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DockerContainersPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'application-x-executable-symbolic',
        });
        window.add(page);

        /* --- Comandos --- */
        const cmdGroup = new Adw.PreferencesGroup({
            title: 'Comandos',
            description: 'La terminal se usa para "docker logs" y para abrir una shell adentro del contenedor.',
        });
        page.add(cmdGroup);

        const dockerRow = new Adw.EntryRow({title: 'Binario de docker'});
        dockerRow.set_text(settings.get_string('docker-command'));
        dockerRow.connect('changed', () =>
            settings.set_string('docker-command', dockerRow.get_text()));
        cmdGroup.add(dockerRow);

        const termRow = new Adw.EntryRow({title: 'Comando de terminal'});
        termRow.set_text(settings.get_string('terminal-command'));
        termRow.connect('changed', () =>
            settings.set_string('terminal-command', termRow.get_text()));
        cmdGroup.add(termRow);

        const presets = new Adw.ComboRow({
            title: 'Presets',
            subtitle: 'Rellena el campo de arriba',
            model: Gtk.StringList.new([
                'ghostty -e',
                'gnome-terminal --',
                'kitty',
                'alacritty -e',
                'wezterm start --',
                'xterm -e',
            ]),
        });
        presets.connect('notify::selected', () => {
            const item = presets.get_model().get_string(presets.get_selected());
            termRow.set_text(item);
        });
        cmdGroup.add(presets);

        /* --- Comportamiento --- */
        const behGroup = new Adw.PreferencesGroup({title: 'Comportamiento'});
        page.add(behGroup);

        const clickActions = ['logs', 'shell', 'restart', 'none'];
        const clickRow = new Adw.ComboRow({
            title: 'Clic en un contenedor',
            subtitle: 'logs abre "docker logs -f"; shell abre "docker exec -it … sh"',
            model: Gtk.StringList.new(clickActions),
        });
        clickRow.set_selected(Math.max(0,
            clickActions.indexOf(settings.get_string('click-action'))));
        clickRow.connect('notify::selected', () =>
            settings.set_string('click-action', clickActions[clickRow.get_selected()]));
        behGroup.add(clickRow);

        const pauseRow = new Adw.SwitchRow({
            title: 'Mostrar también un botón de pausa',
            subtitle: '⏸ corre "docker pause": congela el contenedor pero se queda con la RAM. El botón de detener está siempre',
        });
        settings.bind('show-pause-button', pauseRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behGroup.add(pauseRow);

        const groupRow = new Adw.SwitchRow({
            title: 'Agrupar por proyecto de compose',
            subtitle: 'Una fila por proyecto, con la RAM de sus contenedores sumada',
        });
        settings.bind('group-by-project', groupRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behGroup.add(groupRow);

        const stoppedRow = new Adw.SwitchRow({
            title: 'Mostrar los proyectos detenidos',
            subtitle: 'Apagado, van juntos en un submenú al final',
        });
        settings.bind('show-stopped', stoppedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behGroup.add(stoppedRow);

        /* --- Medición --- */
        const statsGroup = new Adw.PreferencesGroup({
            title: 'Medición',
            description: 'Los cgroups se leen al instante; "docker stats" tarda un par de segundos con muchos contenedores.',
        });
        page.add(statsGroup);

        const sources = ['auto', 'cgroup', 'stats', 'off'];
        const sourceRow = new Adw.ComboRow({
            title: 'De dónde salen la RAM y la CPU',
            subtitle: 'auto prueba los cgroups y cae a docker stats si no están',
            model: Gtk.StringList.new(sources),
        });
        sourceRow.set_selected(Math.max(0,
            sources.indexOf(settings.get_string('memory-source'))));
        sourceRow.connect('notify::selected', () =>
            settings.set_string('memory-source', sources[sourceRow.get_selected()]));
        statsGroup.add(sourceRow);

        const statsIntervalRow = new Adw.SpinRow({
            title: 'Intervalo mínimo de "docker stats"',
            subtitle: 'Segundos. Solo aplica si no se pueden leer los cgroups',
            adjustment: new Gtk.Adjustment({
                lower: 3, upper: 300, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('stats-interval', statsIntervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        statsGroup.add(statsIntervalRow);

        /* --- Apariencia --- */
        const uiGroup = new Adw.PreferencesGroup({title: 'Apariencia'});
        page.add(uiGroup);

        const iconRow = new Adw.EntryRow({title: 'Icono del panel'});
        iconRow.set_text(settings.get_string('panel-icon'));
        iconRow.connect('changed', () =>
            settings.set_string('panel-icon', iconRow.get_text()));
        uiGroup.add(iconRow);

        const alertIconRow = new Adw.EntryRow({title: 'Icono cuando algo anda mal'});
        alertIconRow.set_text(settings.get_string('panel-icon-alert'));
        alertIconRow.connect('changed', () =>
            settings.set_string('panel-icon-alert', alertIconRow.get_text()));
        uiGroup.add(alertIconRow);

        const countRow = new Adw.SwitchRow({
            title: 'Mostrar cantidad en el panel',
            subtitle: 'Contenedores corriendo',
        });
        settings.bind('show-count', countRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(countRow);

        const memRow = new Adw.SwitchRow({
            title: 'Mostrar RAM total en el panel',
        });
        settings.bind('show-memory', memRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(memRow);

        const detailRow = new Adw.SwitchRow({
            title: 'Mostrar detalle de cada contenedor',
            subtitle: 'Estado, RAM, CPU, tiempo en línea y puertos',
        });
        settings.bind('show-detail', detailRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(detailRow);

        const posRow = new Adw.ComboRow({
            title: 'Posición en el panel',
            model: Gtk.StringList.new(['left', 'center', 'right']),
        });
        const positions = ['left', 'center', 'right'];
        posRow.set_selected(Math.max(0, positions.indexOf(settings.get_string('panel-position'))));
        posRow.connect('notify::selected', () =>
            settings.set_string('panel-position', positions[posRow.get_selected()]));
        uiGroup.add(posRow);

        const intervalRow = new Adw.SpinRow({
            title: 'Intervalo de refresco',
            subtitle: 'Segundos',
            adjustment: new Gtk.Adjustment({
                lower: 2, upper: 300, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(intervalRow);
    }
}
