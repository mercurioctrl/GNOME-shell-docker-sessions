/* extension.js — Docker Containers
 * Indicador en la barra superior con los contenedores de Docker agrupados por
 * proyecto de compose, su RAM y sus controles.
 * Hermano de tmux-sessions@hermess y pm2-apps@hermess: mismo esqueleto.
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Separador de campos para el --format de docker (unit separator): no aparece
// en nombres, imágenes ni etiquetas.
const SEP = String.fromCharCode(31);

// Sondeo mientras el menú está abierto, en segundos. Cerrado manda la clave
// 'refresh-interval'.
const MENU_OPEN_INTERVAL = 3;

// Ventana en la que un clic sobre un botón de la fila anula el 'activate' de
// la fila misma (microsegundos). Ver Row.consumeSuppress().
const SUPPRESS_US = 400000;

// Proyecto con el que se agrupan los contenedores que no son de compose.
const LOOSE = '(sueltos)';

const STATE_LABEL = {
    running: 'corriendo',
    paused: 'en pausa',
    restarting: 'reiniciando',
    removing: 'borrándose',
    exited: 'detenido',
    created: 'creado',
    dead: 'muerto',
};

const STATE_ICON = {
    running: 'media-playback-start-symbolic',
    paused: 'media-playback-pause-symbolic',
    restarting: 'content-loading-symbolic',
    removing: 'content-loading-symbolic',
    exited: 'media-playback-stop-symbolic',
    created: 'media-playback-stop-symbolic',
    dead: 'dialog-warning-symbolic',
};

// Layouts de cgroup donde puede estar un contenedor, en orden de probabilidad.
// El primero es cgroup v2 con el driver systemd, que es lo que trae Docker en
// una Ubuntu actual.
const CGROUP_BASES = [
    id => `/sys/fs/cgroup/system.slice/docker-${id}.scope`,
    id => `/sys/fs/cgroup/docker/${id}`,
    id => `/sys/fs/cgroup/memory/docker/${id}`,
];

/* ---------- helpers de proceso ---------- */

function runCapture(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: String(e)});
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({ok: p.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                resolve({ok: false, stdout: '', stderr: String(e)});
            }
        });
    });
}

// Lanza un proceso que sobrevive a la extensión.
//
// Se usa Gio.Subprocess y no GLib.spawn_async() a propósito: GSubprocess se
// cosecha solo (mantiene su propio child watch en el worker de GLib, aunque se
// suelte esta referencia), así que el proceso no queda zombie en la tabla de
// gnome-shell ni hace falta un GSource nuestro que después habría que remover
// en destroy().
function spawnDetached(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        return true;
    } catch (e) {
        Main.notifyError('Docker Containers', `No se pudo ejecutar: ${argv.join(' ')}`);
        return false;
    }
}

/* ---------- lectura de cgroups ---------- */

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

// Los archivos de cgroup son "clave valor" por línea.
function statValue(text, key) {
    if (!text)
        return 0;
    for (const line of text.split('\n')) {
        if (line.startsWith(`${key} `))
            return parseInt(line.slice(key.length + 1), 10) || 0;
    }
    return 0;
}

// RAM y CPU acumulada de un contenedor, leídas del cgroup. Devuelve null si no
// está en ninguno de los layouts conocidos (y entonces se cae a docker stats).
//
// A memory.current se le resta inactive_file porque es lo que hace docker stats
// para su columna MEM USAGE: sin eso, el page cache infla el número.
function readCgroup(id) {
    for (const base of CGROUP_BASES) {
        const dir = base(id);

        const current = readText(`${dir}/memory.current`);
        if (current !== null) {
            const stat = readText(`${dir}/memory.stat`);
            const memory = Math.max(0,
                (parseInt(current, 10) || 0) - statValue(stat, 'inactive_file'));
            return {memory, cpuUsec: statValue(readText(`${dir}/cpu.stat`), 'usage_usec')};
        }

        // cgroup v1: no hay cpu.stat en el mismo árbol, así que ahí solo RAM.
        const v1 = readText(`${dir}/memory.usage_in_bytes`);
        if (v1 !== null) {
            const stat = readText(`${dir}/memory.stat`);
            const memory = Math.max(0,
                (parseInt(v1, 10) || 0) - statValue(stat, 'total_inactive_file'));
            return {memory, cpuUsec: 0};
        }
    }
    return null;
}

/* ---------- formato ---------- */

// Coma decimal, que es como se escriben los números acá.
function dec(n, digits) {
    return n.toFixed(digits).replace('.', ',');
}

function fmtMem(bytes) {
    if (!bytes)
        return '0 MB';
    const mb = bytes / 1048576;
    if (mb >= 1024)
        return `${dec(mb / 1024, 1)} GB`;
    if (mb >= 100)
        return `${Math.round(mb)} MB`;
    return `${dec(mb, 1)} MB`;
}

function fmtPct(cpu) {
    return `${dec(cpu, 1)} %`;
}

// El campo Status de docker viene en inglés y largo ("Up 3 days (healthy)").
// Se lo compacta al mismo formato corto que usan las otras extensiones.
const UPTIME_UNITS = [
    [/(\d+)\s+seconds?/, 's'],
    [/(\d+)\s+minutes?/, 'min'],
    [/(\d+)\s+hours?/, 'h'],
    [/(\d+)\s+days?/, 'd'],
    [/(\d+)\s+weeks?/, 'sem'],
    [/(\d+)\s+months?/, 'meses'],
    [/(\d+)\s+years?/, 'a\u00f1os'],
];

function fmtStatus(status) {
    if (!status)
        return '';

    let health = '';
    if (status.includes('(healthy)'))
        health = ' \u2713';
    else if (status.includes('(unhealthy)'))
        health = ' \u2717';
    else if (status.includes('(health: starting)'))
        health = ' \u2026';

    const text = status.replace(/^Up\s+/, '').replace(/\s*\(.*\)\s*$/, '').trim();
    if (/Less than a second/i.test(text))
        return `1 s${health}`;
    if (/About an hour/i.test(text))
        return `1 h${health}`;
    if (/About a minute/i.test(text))
        return `1 min${health}`;

    for (const [re, unit] of UPTIME_UNITS) {
        const m = re.exec(text);
        if (m)
            return `${m[1]} ${unit}${health}`;
    }
    return `${text}${health}`;
}

// "13.02MiB / 30.46GiB" -> bytes. Solo se usa en el camino de docker stats.
function parseMemUsage(text) {
    const m = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(text ?? '');
    if (!m)
        return 0;
    const n = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    const mult = {
        B: 1, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12,
        KIB: 1024, MIB: 1048576, GIB: 1073741824, TIB: 1099511627776,
    };
    return Math.round(n * (mult[unit] ?? 1));
}

/* ---------- fila genérica con botones ---------- */

const Row = GObject.registerClass(
class Row extends PopupMenu.PopupBaseMenuItem {
    _init(params) {
        super._init({style_class: 'docker-item'});

        // Un clic sobre uno de los botones de la derecha no tiene que disparar
        // además la acción de la fila. St.Button se come el evento, así que el
        // 'activate' normalmente ni llega; esta marca con vencimiento cubre el
        // caso en que sí llegue, y se limpia sola.
        this._suppressUntil = 0;

        this.add_child(new St.Icon({
            icon_name: params.iconName,
            style_class: 'popup-menu-icon',
        }));

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        textBox.add_child(new St.Label({
            text: params.title,
            style_class: 'docker-name',
        }));
        if (params.detail) {
            textBox.add_child(new St.Label({
                text: params.detail,
                style_class: params.alert ? 'docker-detail-error' : 'docker-detail',
            }));
        }
        this.add_child(textBox);

        for (const b of params.buttons ?? [])
            this._addButton(b.iconName, b.tooltip, b.onClick);
    }

    _addButton(iconName, tooltip, onClick) {
        const btn = new St.Button({
            style_class: 'docker-action-button',
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
            }),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            accessible_name: tooltip,
        });
        btn.connect('clicked', () => {
            this._suppressUntil = GLib.get_monotonic_time() + SUPPRESS_US;
            onClick();
            return Clutter.EVENT_STOP;
        });
        this.add_child(btn);
    }

    // true si el 'activate' que acaba de llegar viene de haber tocado un botón.
    consumeSuppress() {
        const suppressed = GLib.get_monotonic_time() < this._suppressUntil;
        this._suppressUntil = 0;
        return suppressed;
    }
});

/* ---------- fila de un proyecto ---------- */

const ProjectItem = GObject.registerClass(
class ProjectItem extends PopupMenu.PopupSubMenuMenuItem {
    _init(project, opts) {
        super._init(project.name);

        this._suppressUntil = 0;

        const bits = [`${project.running}/${project.containers.length}`];
        if (project.memory > 0)
            bits.push(fmtMem(project.memory));
        const status = new St.Label({
            text: bits.join(' · '),
            style_class: project.alert ? 'docker-detail-error' : 'docker-project-status',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // PopupSubMenuMenuItem arma [icono?, label, expander elástico, flecha].
        // Metiendo el estado y el botón justo antes de la flecha quedan
        // pegados a la derecha, con el expander empujándolos.
        this.insert_child_below(status, this._triangleBin);

        const up = project.running > 0;
        const btn = new St.Button({
            style_class: 'docker-action-button',
            child: new St.Icon({
                icon_name: up
                    ? 'media-playback-stop-symbolic'
                    : 'media-playback-start-symbolic',
                style_class: 'popup-menu-icon',
            }),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            accessible_name: up
                ? `Detener todo ${project.name}`
                : `Levantar todo ${project.name}`,
        });
        btn.connect('clicked', () => {
            this._suppressUntil = GLib.get_monotonic_time() + SUPPRESS_US;
            opts.onToggle(project, up ? 'stop' : 'start');
            return Clutter.EVENT_STOP;
        });
        this.insert_child_below(btn, this._triangleBin);
    }

    // PopupSubMenuMenuItem no emite 'activate': lo sobreescribe para abrir y
    // cerrar el submenú. Así que la marca del botón se consume acá, para que
    // tocar el ■ no despliegue además el proyecto.
    activate(event) {
        if (GLib.get_monotonic_time() < this._suppressUntil) {
            this._suppressUntil = 0;
            return;
        }
        super.activate(event);
    }
});

/* ---------- indicador ---------- */

const DockerIndicator = GObject.registerClass(
class DockerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Docker Containers');

        this._ext = extension;
        this._settings = extension.getSettings();
        this._containers = [];
        this._projects = [];
        this._normalIcon = '🔵';
        this._available = true;    // docker contestó la última vez
        this._timeoutId = 0;
        this._pendingId = 0;
        this._destroyed = false;
        this._refreshing = false;  // hay un docker ps en vuelo
        this._statsRunning = false;
        this._statsAt = 0;         // monotonic del último docker stats
        this._cgroupOk = true;     // los cgroups contestaron la última vez
        this._stats = new Map();   // id -> {memory, cpu}
        this._cpuPrev = new Map(); // id -> {usec, at} para el delta de CPU
        // Proyectos que el usuario frenó desde el menú y que se quedan en la
        // lista principal aunque ya no tengan nada corriendo, para que el ▶
        // quede donde estaba el ■. Se limpia al cerrar el menú.
        this._pinned = new Set();
        this._menuDirty = true;
        this._signature = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Label({
            text: '🔵',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'docker-panel-icon',
        });
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'docker-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        // Con el menú abierto se mira más seguido; cerrado, solo hace falta
        // mantener el resumen del panel.
        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open && this._pinned.size > 0) {
                this._pinned.clear();
                this._menuDirty = true;
            }
            if (open && this._menuDirty)
                this._rebuildMenu();
            this._restartTimer();
            if (open)
                this._refresh();
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval')
                this._restartTimer();
            if (key === 'memory-source')
                this._cgroupOk = true;
            this._menuDirty = true;
            this._refresh();
        });

        this._restartTimer();
        this._refresh();
    }

    /* --- config --- */

    _docker() {
        return this._settings.get_string('docker-command') || 'docker';
    }

    _terminalArgv() {
        const raw = this._settings.get_string('terminal-command') || 'ghostty -e';
        try {
            const [ok, argv] = GLib.shell_parse_argv(raw);
            if (ok && argv.length > 0)
                return argv;
        } catch (e) {
            // cae al default
        }
        return ['ghostty', '-e'];
    }

    /* --- timer --- */

    _restartTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        const secs = this.menu.isOpen
            ? MENU_OPEN_INTERVAL
            : this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* --- datos --- */

    // Devuelve null si docker no contestó (daemon caído, sin permisos), para
    // poder distinguirlo de "contestó y no hay contenedores".
    async _listContainers() {
        // --no-trunc para tener el ID completo, que es lo que nombra al cgroup.
        const fmt = ['{{.ID}}', '{{.Names}}', '{{.State}}', '{{.Status}}', '{{.Image}}',
            '{{.Label "com.docker.compose.project"}}',
            '{{.Label "com.docker.compose.service"}}',
            '{{.Ports}}'].join(SEP);
        const res = await runCapture([this._docker(), 'ps', '-a', '--no-trunc', '--format', fmt]);
        if (!res.ok)
            return null;

        return res.stdout.split('\n')
            .filter(l => l.trim().length > 0)
            .map(line => {
                const [id, name, state, status, image, project, service, ports] = line.split(SEP);
                return {
                    id,
                    name,
                    state,
                    status,
                    image,
                    project: project && project.length > 0 ? project : LOOSE,
                    service: service && service.length > 0 ? service : name,
                    ports: DockerIndicator.parsePorts(ports),
                    memory: 0,
                    cpu: 0,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp" -> ["8080"], sin repetidos.
    static parsePorts(text) {
        if (!text)
            return [];
        const out = [];
        for (const m of text.matchAll(/:(\d+)->/g)) {
            if (!out.includes(m[1]))
                out.push(m[1]);
        }
        return out;
    }

    // Llena this._stats leyendo los cgroups. Devuelve false si no encontró
    // ninguno, que es la señal para caer a docker stats.
    _readStatsFromCgroups(running) {
        const now = GLib.get_monotonic_time();
        const stats = new Map();
        let found = 0;

        for (const c of running) {
            const raw = readCgroup(c.id);
            if (!raw)
                continue;
            found += 1;

            let cpu = 0;
            const prev = this._cpuPrev.get(c.id);
            if (prev && raw.cpuUsec > prev.usec && now > prev.at) {
                // Misma convención que docker stats: porcentaje sobre un core,
                // así que un contenedor con 2 hilos al palo marca 200 %.
                cpu = ((raw.cpuUsec - prev.usec) / (now - prev.at)) * 100;
            }
            this._cpuPrev.set(c.id, {usec: raw.cpuUsec, at: now});
            stats.set(c.id, {memory: raw.memory, cpu});
        }

        if (found === 0 && running.length > 0)
            return false;

        this._stats = stats;
        return true;
    }

    // Camino lento: docker stats tarda ~2,5 s con varias decenas de
    // contenedores, así que corre aparte del refresco y espaciado.
    async _readStatsFromDocker() {
        if (this._statsRunning)
            return;
        const now = GLib.get_monotonic_time();
        const minGap = this._settings.get_int('stats-interval') * 1000000;
        if (this._statsAt && now - this._statsAt < minGap)
            return;

        this._statsRunning = true;
        this._statsAt = now;
        const fmt = ['{{.ID}}', '{{.MemUsage}}', '{{.CPUPerc}}'].join(SEP);
        let res;
        try {
            res = await runCapture([this._docker(), 'stats', '--no-stream', '--format', fmt]);
        } finally {
            this._statsRunning = false;
        }
        if (this._destroyed || !res.ok)
            return;

        // docker stats trunca el ID; los del ps son completos.
        const stats = new Map();
        for (const line of res.stdout.split('\n')) {
            if (line.trim().length === 0)
                continue;
            const [id, mem, cpu] = line.split(SEP);
            const full = this._containers.find(c => c.id.startsWith(id));
            stats.set(full ? full.id : id, {
                memory: parseMemUsage(mem),
                cpu: parseFloat((cpu ?? '').replace('%', '').replace(',', '.')) || 0,
            });
        }
        this._stats = stats;
        this._applyStats();
        this._updatePanel();
        this._menuDirty = true;
        this._rebuildMenu();
    }

    _applyStats() {
        for (const c of this._containers) {
            const s = this._stats.get(c.id);
            c.memory = s ? s.memory : 0;
            c.cpu = s ? s.cpu : 0;
        }
    }

    _groupByProject() {
        const map = new Map();
        for (const c of this._containers) {
            let p = map.get(c.project);
            if (!p) {
                p = {
                    name: c.project,
                    containers: [],
                    running: 0,
                    memory: 0,
                    cpu: 0,
                    alert: false,
                };
                map.set(c.project, p);
            }
            p.containers.push(c);
            if (c.state === 'running')
                p.running += 1;
            if (c.state === 'dead' || c.state === 'restarting')
                p.alert = true;
            p.memory += c.memory;
            p.cpu += c.cpu;
        }
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async _refresh() {
        // El timer, el abrir el menú y las acciones pueden pedir refresco casi
        // a la vez: sin esta guarda quedarían varios docker ps en vuelo
        // pisándose el resultado.
        if (this._destroyed || this._refreshing)
            return;
        this._refreshing = true;

        let containers;
        try {
            containers = await this._listContainers();
        } finally {
            this._refreshing = false;
        }
        if (this._destroyed)
            return;

        this._available = containers !== null;
        this._containers = containers ?? [];

        const source = this._settings.get_string('memory-source');
        const running = this._containers.filter(c => c.state === 'running');
        if (source === 'cgroup' || (source === 'auto' && this._cgroupOk)) {
            // Leer los cgroups es sincrónico pero son dos archivitos por
            // contenedor: unos pocos ms aun con medio centenar.
            this._cgroupOk = this._readStatsFromCgroups(running);
            if (!this._cgroupOk && source === 'auto')
                this._readStatsFromDocker();
        } else if (source === 'stats' || (source === 'auto' && !this._cgroupOk)) {
            this._readStatsFromDocker();
        } else {
            this._stats = new Map();
        }
        this._applyStats();

        this._projects = this._groupByProject();
        this._updatePanel();

        // Rearmar el menú destruye y recrea todos los actores, así que solo se
        // hace si algo cambió de verdad. La RAM se redondea a MB y la CPU a
        // entero para que el vaivén normal no dispare un rearmado por tick.
        const signature = [this._available ? 'ok' : 'off'].concat(
            this._containers.map(c => [
                c.id, c.state, Math.round(c.memory / 1048576), Math.round(c.cpu),
            ].join('\t'))).join('\n');
        if (signature !== this._signature) {
            this._signature = signature;
            this._menuDirty = true;
        }

        // PopupMenu.open() se planta si el menú está vacío, así que armarlo
        // recién al abrirse no alcanza: nunca se abre y el clic no hace nada.
        // Por eso se rearma esté abierto o cerrado; la firma de arriba ya evita
        // rearmar de gusto en cada tick.
        if (this._menuDirty)
            this._rebuildMenu();
    }

    _updatePanel() {
        this._normalIcon = this._settings.get_string('panel-icon') || '🔵';

        const running = this._containers.filter(c => c.state === 'running');
        const alert = this._containers.some(c => c.state === 'dead' || c.state === 'restarting');
        const totalMem = running.reduce((acc, c) => acc + c.memory, 0);

        const bits = [];
        if (this._settings.get_boolean('show-count'))
            bits.push(String(running.length));
        if (this._settings.get_boolean('show-memory') && totalMem > 0)
            bits.push(fmtMem(totalMem));

        const text = bits.join(' · ');
        this._label.text = text ? ` ${text}` : '';
        this._label.visible = text.length > 0;

        // Los emoji ignoran el color del CSS, así que el aviso de error se da
        // cambiando el emoji. Con un glifo de texto alcanzaría con la clase.
        const alertIcon = this._settings.get_string('panel-icon-alert');
        this._icon.text = alert && alertIcon ? alertIcon : this._normalIcon;

        let cls = 'docker-panel-icon';
        if (!this._available || running.length === 0)
            cls += ' docker-panel-icon-idle';
        if (alert)
            cls += ' docker-panel-icon-error';
        this._icon.style_class = cls;
        this._icon.opacity = this._available && running.length > 0 ? 255 : 140;
    }

    /* --- menú --- */

    _rebuildMenu() {
        this.menu.removeAll();
        this._menuDirty = false;

        if (!this._available) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Docker no responde'), {reactive: false}));
        } else if (this._containers.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Sin contenedores'), {reactive: false}));
        } else {
            this._addSummary();
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (this._settings.get_boolean('group-by-project'))
                this._addProjects();
            else
                this._addFlatList();
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem(_('Actualizar'));
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferencias'));
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _addSummary() {
        const running = this._containers.filter(c => c.state === 'running');
        const projUp = this._projects.filter(p => p.running > 0).length;
        const mem = running.reduce((acc, c) => acc + c.memory, 0);
        const cpu = running.reduce((acc, c) => acc + c.cpu, 0);

        const parts = [
            `${running.length}/${this._containers.length} arriba`,
            `${projUp}/${this._projects.length} proyectos`,
            fmtMem(mem),
        ];
        if (cpu > 0)
            parts.push(fmtPct(cpu));

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(new St.Label({
            text: parts.join(' · '),
            style_class: 'docker-summary',
            x_expand: true,
        }));
        this.menu.addMenuItem(item);
    }

    _addProjects() {
        const showStopped = this._settings.get_boolean('show-stopped');
        const up = this._projects.filter(
            p => p.running > 0 || this._pinned.has(p.name));
        const down = this._projects.filter(
            p => p.running === 0 && !this._pinned.has(p.name));

        for (const p of showStopped ? this._projects : up)
            this.menu.addMenuItem(this._projectItem(p));

        if (showStopped || down.length === 0)
            return;

        // Los proyectos sin nada corriendo son mayoría y ensucian el menú, así
        // que van juntos abajo, con un botón para levantar cada uno.
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const sub = new PopupMenu.PopupSubMenuMenuItem(
            down.length === 1
                ? _('Detenidos (1 proyecto)')
                : `Detenidos (${down.length} proyectos)`);
        for (const p of down) {
            const row = new Row({
                iconName: 'media-playback-stop-symbolic',
                title: p.name,
                detail: p.containers.length === 1
                    ? '1 contenedor'
                    : `${p.containers.length} contenedores`,
                buttons: [{
                    iconName: 'media-playback-start-symbolic',
                    tooltip: `Levantar todo ${p.name}`,
                    onClick: () => {
                        this._pinned.add(p.name);
                        this._runOn('start', p.containers);
                    },
                }],
            });
            sub.menu.addMenuItem(row);
        }
        this.menu.addMenuItem(sub);
    }

    _projectItem(p) {
        const item = new ProjectItem(p, {
            onToggle: (project, verb) => {
                this._pinned.add(project.name);
                this._runOn(verb, project.containers);
            },
        });

        for (const c of p.containers)
            item.menu.addMenuItem(this._containerRow(c, true));

        item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const [label, verb] of [
            ['Levantar todo', 'start'],
            ['Detener todo', 'stop'],
            ['Reiniciar todo', 'restart'],
        ]) {
            const entry = new PopupMenu.PopupMenuItem(label);
            entry.connect('activate', () => {
                this._pinned.add(p.name);
                this._runOn(verb, p.containers);
            });
            item.menu.addMenuItem(entry);
        }

        return item;
    }

    _addFlatList() {
        for (const c of this._containers)
            this.menu.addMenuItem(this._containerRow(c, false));
    }

    _containerRow(c, insideProject) {
        const running = c.state === 'running';
        const paused = c.state === 'paused';

        const detail = [];
        if (!running)
            detail.push(STATE_LABEL[c.state] ?? c.state);
        if (c.memory > 0)
            detail.push(fmtMem(c.memory));
        if (c.cpu > 0)
            detail.push(fmtPct(c.cpu));
        if (running && c.status)
            detail.push(fmtStatus(c.status));
        if (c.ports.length > 0)
            detail.push(c.ports.slice(0, 3).join(', '));

        // Detener y pausar no son lo mismo y la diferencia importa: "docker
        // stop" apaga el contenedor y libera su RAM, "docker pause" solo
        // congela sus procesos y se la queda. Por eso el botón de detener es un
        // cuadrado y está siempre, y el de pausa es un ⏸ aparte y opcional: con
        // un solo botón de ⏸ que hacía stop, la acción se leía al revés.
        const buttons = [];
        if (paused) {
            buttons.push({
                iconName: 'media-playback-start-symbolic',
                tooltip: 'Reanudar (docker unpause)',
                onClick: () => this._runOn('unpause', [c]),
            });
        } else if (!running) {
            buttons.push({
                iconName: 'media-playback-start-symbolic',
                tooltip: 'Levantar (docker start)',
                onClick: () => this._runOn('start', [c]),
            });
        }

        if (running && this._settings.get_boolean('show-pause-button')) {
            buttons.push({
                iconName: 'media-playback-pause-symbolic',
                tooltip: 'Pausar (docker pause) — no libera la RAM',
                onClick: () => this._runOn('pause', [c]),
            });
        }

        // Un contenedor pausado también se puede detener, sin despausarlo antes.
        if (running || paused) {
            buttons.push({
                iconName: 'media-playback-stop-symbolic',
                tooltip: 'Detener (docker stop) — libera la RAM',
                onClick: () => this._runOn('stop', [c]),
            });
        }

        buttons.push({
            iconName: 'view-refresh-symbolic',
            tooltip: 'Reiniciar (docker restart)',
            onClick: () => this._runOn('restart', [c]),
        });

        const row = new Row({
            iconName: STATE_ICON[c.state] ?? 'application-x-executable-symbolic',
            // Adentro de un proyecto alcanza con el servicio ("backend"); en la
            // lista plana hace falta el nombre completo del contenedor.
            title: insideProject ? c.service : c.name,
            detail: this._settings.get_boolean('show-detail') ? detail.join(' · ') : '',
            alert: c.state === 'dead' || c.state === 'restarting',
            buttons,
        });
        row.connect('activate', () => {
            if (row.consumeSuppress())
                return;
            this._onRowActivate(c);
        });
        return row;
    }

    /* --- acciones --- */

    // Sobre un conjunto (un proyecto entero) hay que mandar solo los que
    // corresponde: "docker stop" a los que están arriba y "docker start" a los
    // que están abajo. Si no queda ninguno es porque el conjunto ya está en el
    // estado pedido, y entonces no hay nada que hacer.
    static _targets(verb, containers) {
        if (verb === 'stop')
            return containers.filter(c => c.state === 'running' || c.state === 'paused');
        if (verb === 'start')
            return containers.filter(c => c.state !== 'running' && c.state !== 'paused');
        return containers;
    }

    async _runOn(verb, containers) {
        const ids = DockerIndicator._targets(verb, containers).map(c => c.id);
        if (ids.length === 0)
            return;

        const res = await runCapture([this._docker(), verb, ...ids]);
        if (!res.ok) {
            const msg = (res.stderr || res.stdout).split('\n')
                .filter(l => l.trim().length > 0).pop() ?? '';
            Main.notifyError('Docker Containers', `docker ${verb}: ${msg}`);
        }
        this._menuDirty = true;
        this._refresh();
        // docker vuelve antes de que el contenedor termine de arrancar, así que
        // se mira de nuevo un par de segundos después.
        this._scheduleRefresh();
    }

    _onRowActivate(c) {
        const action = this._settings.get_string('click-action');
        if (action === 'restart') {
            this._runOn('restart', [c]);
            return;
        }
        if (action === 'none')
            return;

        const argv = this._terminalArgv();
        if (action === 'shell') {
            // sh está en toda imagen; bash no.
            argv.push(this._docker(), 'exec', '-it', c.name, 'sh');
        } else {
            argv.push(this._docker(), 'logs', '-f', '--tail', '200', c.name);
        }
        spawnDetached(argv);
    }

    _scheduleRefresh() {
        if (this._pendingId)
            GLib.Source.remove(this._pendingId);
        this._pendingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._pendingId = 0;
            this._menuDirty = true;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._pendingId) {
            GLib.Source.remove(this._pendingId);
            this._pendingId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._containers = [];
        this._projects = [];
        this._stats.clear();
        this._cpuPrev.clear();
        this._pinned.clear();
        super.destroy();
    }
});

/* ---------- extensión ---------- */

export default class DockerContainersExtension extends Extension {
    enable() {
        this._indicator = new DockerIndicator(this);
        const pos = this.getSettings().get_string('panel-position');
        const index = pos === 'left' ? 1 : 0;
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, pos);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
