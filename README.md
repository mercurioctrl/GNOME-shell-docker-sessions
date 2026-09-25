# Docker Containers — extensión de GNOME Shell

Indicador en la barra superior con los contenedores de Docker **agrupados por
proyecto de compose**: cuánta RAM ocupan, cuáles están arriba, y botones para
levantarlos, detenerlos y reiniciarlos sin abrir una terminal.

Hermana de [tmux Sessions](https://github.com/mercurioctrl/GNOME-shell-tmux-sessions)
y de **pm2 Apps**: mismo esqueleto, mismas convenciones y las mismas trampas de
GNOME ya sorteadas.

```
🔵 33 · 1,9 GB
┌────────────────────────────────────────────────┐
│ 33/64 arriba · 17/27 proyectos · 1,9 GB        │
│ ────────────────────────────────────────────── │
│ ▸ erp                        6/6 · 78,5 MB ■ ▸ │
│ ▸ homeassistant              1/1 · 299 MB  ■ ▸ │
│ ▸ tienda                     6/6 · 205 MB  ■ ▸ │
│ ▸ api-rest                   3/5 · 16,2 MB ■ ▸ │
│ ▸ unifi                      2/2 · 678 MB  ■ ▸ │
│ ────────────────────────────────────────────── │
│ ▸ Detenidos (10 proyectos)                     │
│ ────────────────────────────────────────────── │
│ Actualizar                                     │
│ Preferencias                                   │
└────────────────────────────────────────────────┘
```

Abriendo un proyecto:

```
│ ▶ backend        11,9 MB · 3 d              ■ ↻ │
│ ▶ db             36,8 MB · 3 d ✓ · 3310     ■ ↻ │
│ ▶ nginx           6,7 MB · 3 d · 8824       ■ ↻ │
│ ─────────────────────────────────────────────── │
│ Levantar todo · Detener todo · Reiniciar todo   │
```

## Instalación

```bash
git clone git@github.com:mercurioctrl/GNOME-shell-docker-sessions.git ~/Proyectos/gnome-shell-docker-containers
ln -s ~/Proyectos/gnome-shell-docker-containers ~/.local/share/gnome-shell/extensions/docker-containers@hermess
glib-compile-schemas ~/Proyectos/gnome-shell-docker-containers/schemas/
# recargar GNOME Shell: Alt+F2 -> r -> Enter (X11) o cerrar sesión (Wayland)
gnome-extensions enable docker-containers@hermess
```

Requiere `docker` en el `PATH` y que el usuario esté en el grupo `docker`
(`id -nG | grep docker`); si no, el menú va a decir «Docker no responde». Debería
andar igual con `podman` cambiando `docker-command`, aunque no está probado.

## Uso

**En el panel:** el icono (`🔵` por defecto, configurable), cuántos contenedores
están corriendo y la RAM total que ocupan. Apagado si no hay nada arriba (o
Docker no responde), 🔴 si algún contenedor quedó `dead` o en bucle de
`restarting`.

Los emoji son mapas de bits y **el panel los dibuja a 11px**: los de figura
plana (🔵, 🟢) aguantan el reescalado, los ilustrados (🐳) se ven pixelados —
por eso el default no es la ballena. Un glifo de texto (`▣`, `⬒`) es vectorial y
además toma el `color` del CSS; usando uno, `panel-icon-alert` se puede dejar
vacío y el rojo sale solo.

**En el menú**, una fila por proyecto de compose con `arriba/total · RAM` y un
botón que **frena o levanta el proyecto entero**: ■ mientras haya algo arriba,
▶ cuando está todo abajo. Se despliega y adentro está cada contenedor por su
**nombre de servicio** (`backend`, `db`, `nginx`…), con estado, RAM, CPU, tiempo
en línea, healthcheck y puertos publicados. Al final de cada proyecto siguen
estando *Levantar / Detener / Reiniciar todo*.

Un proyecto que frenás desde el menú **se queda donde está**, con el ▶ en el
mismo lugar donde estaba el ■, aunque ya no tenga nada corriendo. Recién cuando
cerrás el menú se acomoda con el resto de los detenidos.

Los contenedores que no son de compose caen en un proyecto `(sueltos)`.

| Botón | Qué hace |
|---|---|
| ■ | `docker stop` — apaga el contenedor y **libera su RAM** |
| ▶ | `docker start`, o `docker unpause` si estaba pausado |
| ↻ | `docker restart` |
| ⏸ | `docker pause` — congela los procesos pero **se queda con la RAM**. Apagado por defecto |

Detener y pausar no son lo mismo: `stop` es el que baja el consumo, `pause` solo
congela. El ■ está siempre; el ⏸ se prende en las preferencias. Un contenedor
pausado se puede detener directo, sin despausarlo antes.

**Clic en un contenedor** abre `docker logs -f --tail 200` en la terminal. Se
puede cambiar a `shell` (`docker exec -it … sh`), `restart` o nada.

Los proyectos **sin nada corriendo** no se listan sueltos: van juntos en un
submenú *Detenidos* al final, cada uno con un botón para levantarlo entero. Con
27 proyectos, mostrarlos todos hacía un menú más alto que la pantalla. Se puede
cambiar con *Mostrar los proyectos detenidos*.

**No hay botón de borrar.** A diferencia de pm2, acá un `docker rm` sobre un
contenedor de compose es puro ruido (el próximo `up` lo recrea) y sobre uno
suelto es destructivo de verdad. Eso se hace en la terminal.

## De dónde sale la RAM

`docker stats --no-stream` tarda **~2,6 s** con 33 contenedores corriendo — es
inviable para un menú que refresca cada 3 s. Así que por defecto la extensión
lee los **cgroups** directamente, que tarda **~4 ms**:

```
/sys/fs/cgroup/system.slice/docker-<id-completo>.scope/
    memory.current     menos memory.stat:inactive_file   -> RAM
    cpu.stat:usage_usec                                  -> CPU (por delta)
```

A `memory.current` hay que **restarle `inactive_file`**, que es exactamente lo
que hace `docker stats` para su columna `MEM USAGE`: sin eso el page cache infla
el número. Medido contra `docker stats` en esta máquina, el desvío máximo fue de
**7,6 %** y sobre el contenedor más chico (3,3 MB), o sea ruido de muestreo.

La CPU sale del delta de `usage_usec` entre dos refrescos, con la misma
convención que `docker stats`: porcentaje sobre un core, así que un contenedor
con dos hilos al palo marca 200 %. En el primer refresco todavía no hay delta,
así que la CPU aparece recién en el segundo.

Se prueban tres layouts de cgroup (v2 con driver systemd, v2 con cgroupfs, v1) y
si ninguno responde se cae solo a `docker stats`, espaciado según
`stats-interval`. Eso se puede forzar con `memory-source`.

## Preferencias

`gnome-extensions prefs docker-containers@hermess`, o desde el menú.

| Clave | Default | Qué hace |
|---|---|---|
| `docker-command` | `docker` | Ejecutable. Sirve para podman |
| `terminal-command` | `ghostty -e` | Terminal para logs y shell |
| `click-action` | `logs` | `logs`, `shell`, `restart` o `none` |
| `show-pause-button` | `false` | Agrega un ⏸ (`docker pause`) además del ■ |
| `group-by-project` | `true` | Agrupar por proyecto de compose |
| `show-stopped` | `false` | Listar los proyectos detenidos con el resto |
| `memory-source` | `auto` | `auto`, `cgroup`, `stats` u `off` |
| `stats-interval` | `10` | Segundos mínimos entre `docker stats` |
| `panel-icon` | `🔵` | Texto o emoji del panel |
| `panel-icon-alert` | `🔴` | Lo reemplaza mientras haya un contenedor caído |
| `show-count` | `true` | Contenedores corriendo en el panel |
| `show-memory` | `true` | RAM total en el panel |
| `show-detail` | `true` | Renglón de detalle de cada contenedor |
| `panel-position` | `right` | `left`, `center` o `right` |
| `refresh-interval` | `30` | Segundos entre sondeos con el menú cerrado |

## Archivos

| Archivo | Qué hay adentro |
|---|---|
| `extension.js` | Todo el indicador: lectura de docker y cgroups, menú, acciones |
| `prefs.js` | Ventana de preferencias (Adw) |
| `stylesheet.css` | Estilos del panel y del menú |
| `schemas/*.gschema.xml` | Definición de las claves de configuración |
| `reload.sh` | Recompila el schema y reinicia la shell (X11) |

### Piezas de `extension.js`

- `runCapture()` / `spawnDetached()` — correr docker y leerlo, o lanzar la terminal.
- `readCgroup()` / `statValue()` — el camino rápido de RAM y CPU.
- `fmtMem()` / `fmtPct()` / `fmtStatus()` — formato con coma decimal y uptime corto.
- `Row` — fila genérica con icono, título, detalle y botones a la derecha.
- `ProjectItem` — la fila de un proyecto: submenú con contador, RAM y el ■/▶ del conjunto.
- `DockerIndicator` — el botón del panel: timer, lectura, armado del menú, acciones.

## Desarrollo

### Recargar tras editar el código

GJS **cachea los módulos ESM**: después de tocar `extension.js` o `prefs.js` hay
que reiniciar la shell, desactivar/activar no alcanza.

```bash
./reload.sh          # X11
# o: Alt+F2 -> r -> Enter
```

`stylesheet.css` sí se relee con `gnome-extensions disable/enable`.

Tras editar el `.gschema.xml`: `glib-compile-schemas schemas/`.

### Ver errores

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Chequeo de sintaxis sin reiniciar la shell

```bash
cp extension.js /tmp/extension.mjs && node --check /tmp/extension.mjs
```

## Detalles de implementación y trampas

- **GNOME no reescanea el directorio de extensiones.** Recién creado el symlink,
  `gnome-extensions enable` contesta «La extensión no existe» hasta recargar la
  shell.
- **Un menú vacío no abre y no avisa.** `PopupMenu.open()` corta con
  `if (this.isEmpty()) return;`. Por eso el menú se rearma esté abierto o
  cerrado, y siempre tiene al menos *Actualizar* y *Preferencias*.
- **Rearmar el menú destruye y recrea los actores**, así que se calcula una
  *firma* de la lista y solo se rearma si cambió. La RAM se redondea a MB y la
  CPU a entero para que el vaivén normal no dispare un rearmado por tick.
- **`docker ps` necesita `--no-trunc`:** el ID corto no sirve para armar la ruta
  del cgroup, que usa el ID completo.
- **`PopupSubMenuMenuItem` tiene un expander propio.** El contador, la RAM y el
  botón del proyecto se meten con `insert_child_below(actor, this._triangleBin)`
  para que queden pegados a la flecha y no antes del hueco elástico.
- **`PopupSubMenuMenuItem` no emite `activate`:** lo sobreescribe para abrir y
  cerrar el submenú. Así que el botón del proyecto no se puede desacoplar con un
  `connect('activate')` como en las filas comunes — hay que sobreescribir
  `activate()` y consumir ahí la marca del botón, o tocar el ■ despliega el
  proyecto además de frenarlo.
- **El icono del panel es un `St.Label`, no un `St.Icon`:** un SVG
  `-symbolic.svg` lo recolorea St y se pierde el color. Con texto, el `color`
  del CSS manda (los emoji lo ignoran, que es justamente lo que se quiere).
- **Los botones de la fila no deben disparar el clic de la fila.** `St.Button`
  se come el evento, pero por las dudas cada botón marca un `_suppressUntil`
  (400 ms) que el `activate` consume; se limpia solo.
- **`docker` vuelve antes de que el contenedor termine de arrancar**, así que
  después de cada acción hay un refresco inmediato y otro dos segundos después.
- **Gio.Subprocess y no `GLib.spawn_async()`:** GSubprocess se cosecha solo, así
  que las terminales que se abren no dejan zombies en gnome-shell.

## Ideas pendientes

- Sección con scroll si la lista de proyectos supera el alto de la pantalla.
- Acciones de compose de verdad (`docker compose up -d`) leyendo
  `com.docker.compose.project.working_dir`, para levantar un proyecto que no
  tiene contenedores creados.
- Uso de disco por imagen/volumen (`docker system df`).
- Aviso cuando un contenedor entra en bucle de reinicio o queda `unhealthy`.
