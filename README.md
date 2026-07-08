# DBus Property Pulse

A GNOME Shell extension that lights up every monitor whenever a watched DBus
property transitions to a chosen trigger value — either as a pulsing colored
border ("solid", the default) or as a flowing rainbow glow ("aurora"). The
effect fades out when the property leaves that value.

You can watch a **list** of signals, each with its own DBus source, trigger
value, style, and appearance knobs. The list is ordered by priority (topmost
wins): when several watched properties are in their trigger state at once, only
the highest-priority signal's effect is shown, and it hands off to the next one
when that signal clears. Out of the box a single entry lights up on a pending
touch from `yubikey-touch-detector`; every piece of the wiring is exposed
through a preferences UI.

## Requirements

- GNOME Shell 49 or 50
- A DBus session-bus service that exports the property you want to watch and
  emits `org.freedesktop.DBus.Properties.PropertiesChanged` when it changes.
- The property must be an unsigned integer (only uint types are supported).

## Install

```
git clone <this-repo> ~/.local/share/gnome-shell/extensions/dbus-pulse@dev.gourves.net
cd ~/.local/share/gnome-shell/extensions/dbus-pulse@dev.gourves.net
glib-compile-schemas schemas/
# On Wayland, reloading an extension requires a full re-login.
gnome-extensions enable dbus-pulse@dev.gourves.net
```

After installing, log out and back in (Wayland can't restart the shell in
place), then enable the extension.

## Configuration

Open the prefs with `gnome-extensions prefs dbus-pulse@dev.gourves.net`. The
window shows a **Watched signals** list — one row per signal, ordered by
priority (top = highest). Drag a row (or use the ↑/↓ buttons) to reorder; that
order is the priority used to arbitrate simultaneous triggers. Use **+** to add
a signal and click a row to edit it.

Each signal's editor has two groups:

- **DBus source** — bus name, object path, interface name, property name, and
  the unsigned integer trigger value that starts the pulse. Any value other
  than the trigger stops it.
- **Appearance** — a **Style** selector with two renderings:
  - **Solid border** (default) — the original pulsing border. Knobs: CSS
    color string (anything valid in GNOME Shell's CSS, e.g.
    `rgba(255, 200, 0, 0.95)` or `#ff0000`), border thickness in pixels, and
    the per-half-cycle pulse duration in milliseconds.
  - **Aurora glow** — a soft rainbow glow whose colors flow around the
    screen edge while the glow breathes. Knobs: glow width (px), flow
    duration (ms for one full lap), breathing duration (ms per
    bright-dim-bright cycle). The palette is fixed.

Each signal can use a different style. Edits persist live via `GSettings` (the
signal list is stored as a JSON array); the extension rebuilds its watchers on
every change, so there is no need to toggle it off and on. A single-signal
configuration from an older version is migrated into the first list entry
automatically on first run.

## Worked example: yubikey-touch-detector

The defaults target [yubikey-touch-detector](https://github.com/max-baz/yubikey-touch-detector)
directly. Run the detector with its DBus server enabled (for example via a
systemd user unit):

```
yubikey-touch-detector -dbus
```

With the detector running and this extension enabled, pending GPG touches
light up the pulsing border (or the aurora glow, if selected) on every
monitor until the key is tapped.

To retarget it to another service — say, a hypothetical VPN daemon that
exposes a `Connected` uint on `org.example.Vpn` — edit the entry (or add
another one) in the prefs and fill in the matching bus name, path, interface,
and property, set the trigger value, and pick a color. Add several signals and
order them to control which effect wins when more than one is active.

## How it works

The extension builds one `Gio.DBusProxy` per watched signal and connects to
`g-properties-changed`. A priority arbiter tracks which signals are currently
in their trigger state and shows the effect for the highest-priority one (the
topmost list entry); it switches immediately when a higher-priority signal
fires and hands back to a lower one when the higher clears. Only one effect is
on screen at a time.

When a signal is shown it adds a full-screen frame on every monitor. In
**solid** style the frame is an `St.Widget` border whose opacity eases
between two levels. In **aurora** style the frame carries a
`Shell.GLSLEffect` fragment shader computing a conic rainbow gradient with a
soft distance-to-edge falloff, advanced by a repeating `Clutter.Timeline`;
if the aurora renderer fails to start, the extension falls back to the solid
border so the alert is never lost. When no watched signal is in its trigger
value the frame fades out and is removed. Monitor hot-plug is handled by
recreating the frame on `monitors-changed`.

## License

Released under the GNU General Public License version 2 or later — see [LICENSE](LICENSE).
