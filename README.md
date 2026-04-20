# DBus Property Pulse

A GNOME Shell extension that draws a pulsing colored border around every monitor
whenever a chosen DBus property transitions to a chosen trigger value. The
border fades out when the property leaves that value. Out of the box it is
configured to light up on a pending touch from `yubikey-touch-detector`, but
every piece of the wiring — bus name, object path, interface, property,
trigger value, border color, thickness, and pulse duration — is exposed
through a preferences UI.

## Requirements

- GNOME Shell 49
- A DBus session-bus service that exports the property you want to watch and
  emits `org.freedesktop.DBus.Properties.PropertiesChanged` when it changes.
- The property must be an unsigned integer (v1 only supports uint types).

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
window has one page with two groups:

- **DBus source** — bus name, object path, interface name, property name, and
  the unsigned integer trigger value that starts the pulse. Any value other
  than the trigger stops it.
- **Appearance** — CSS color string for the border (anything valid in
  GNOME Shell's CSS, e.g. `rgba(255, 200, 0, 0.95)` or `#ff0000`), border
  thickness in pixels, and the per-half-cycle pulse duration in milliseconds.

Edits persist live via `GSettings`; the extension tears down its DBus proxy
and rebuilds on every change, so there is no need to toggle it off and on.

## Worked example: yubikey-touch-detector

The defaults target [yubikey-touch-detector](https://github.com/max-baz/yubikey-touch-detector)
directly. Run the detector with its DBus server enabled (for example via a
systemd user unit):

```
yubikey-touch-detector -dbus
```

With the detector running and this extension enabled, pending GPG touches
light up an amber border on every monitor until the key is tapped.

To retarget it to another service — say, a hypothetical VPN daemon that
exposes a `Connected` uint on `org.example.Vpn` — open the prefs and fill in
the matching bus name, path, interface, and property, set the trigger value,
and pick a color.

## How it works

The extension builds a `Gio.DBusProxy` for the configured service and
connects to `g-properties-changed`. When the watched property transitions
into the trigger value it adds a full-screen `St.Widget` border on every
monitor and eases its opacity between two levels; when the property leaves
the trigger value the frames fade out and are removed. Monitor hot-plug is
handled by re-adding the frames on `monitors-changed`.

## License

Released under the GNU General Public License version 2 or later — see [LICENSE](LICENSE).
