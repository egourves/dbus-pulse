import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const FADE_OUT_MS = 200;
const OPACITY_MIN = 60;
const OPACITY_MAX = 255;

// Settings keys that affect the DBus subscription or visible styling.
// Any change to these triggers a full teardown + rebuild.
const WATCHED_KEYS = [
    'bus-name',
    'object-path',
    'interface-name',
    'property-name',
    'trigger-value',
    'border-color',
    'border-thickness',
    'pulse-duration',
];

export default class DBusPulseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsChangedIds = [];

        for (const key of WATCHED_KEYS) {
            const id = this._settings.connect(`changed::${key}`, () => this._rebuild());
            this._settingsChangedIds.push(id);
        }

        this._start();
    }

    disable() {
        this._stop();

        if (this._settings && this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
        }
        this._settingsChangedIds = [];
        this._settings = null;
    }

    _rebuild() {
        this._stop();
        this._start();
    }

    _start() {
        // Snapshot settings into locals so live edits do not race the pulse loop.
        this._busName = this._settings.get_string('bus-name');
        this._objectPath = this._settings.get_string('object-path');
        this._ifaceName = this._settings.get_string('interface-name');
        this._propName = this._settings.get_string('property-name');
        this._triggerValue = this._settings.get_uint('trigger-value');
        const rawColor = this._settings.get_string('border-color');
        this._borderColor = rawColor.trim() ? rawColor : 'white';
        this._borderThickness = this._settings.get_uint('border-thickness');
        this._pulseDuration = this._settings.get_uint('pulse-duration');

        this._proxy = null;
        this._proxyCancellable = new Gio.Cancellable();
        this._propsChangedId = 0;
        this._monitorsChangedId = 0;
        this._frames = [];
        this._pulsing = false;
        this._stopping = false;
        this._pulseTimeoutId = 0;
        this._pulseHigh = true;
        this._lastValue = 0;

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            this._busName,
            this._objectPath,
            this._ifaceName,
            this._proxyCancellable,
            (obj, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, `dbus-pulse: failed to build proxy for ${this._busName} ${this._objectPath} ${this._ifaceName}`);
                    this._proxy = null;
                    return;
                }

                this._proxyCancellable = null;

                const initial = this._proxy.get_cached_property(this._propName);
                if (initial !== null)
                    this._lastValue = this._readIntLike(initial);

                this._propsChangedId = this._proxy.connect('g-properties-changed',
                    (_proxy, changed) => {
                        const unpacked = changed.deep_unpack();
                        if (!(this._propName in unpacked))
                            return;
                        // v1 assumption: the watched property is an unsigned integer. deep_unpack on the
                        // inner GVariant returns a JS number (or BigInt for 64-bit), which _readIntLike normalizes.
                        const next = this._readIntLike(unpacked[this._propName]);
                        const prev = this._lastValue;
                        this._lastValue = next;
                        const wasTrigger = prev === this._triggerValue;
                        const isTrigger = next === this._triggerValue;
                        if (!wasTrigger && isTrigger)
                            this._startPulse();
                        else if (wasTrigger && !isTrigger)
                            this._stopPulse();
                    });

                this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
                    () => {
                        if (this._pulsing) {
                            this._removeFrames();
                            this._addFrames();
                        }
                    });

                if (this._lastValue === this._triggerValue)
                    this._startPulse();
            });
    }

    _stop() {
        if (this._proxyCancellable) {
            this._proxyCancellable.cancel();
            this._proxyCancellable = null;
        }

        this._stopPulse(true);

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        if (this._proxy && this._propsChangedId) {
            this._proxy.disconnect(this._propsChangedId);
            this._propsChangedId = 0;
        }

        if (this._pulseTimeoutId) {
            GLib.source_remove(this._pulseTimeoutId);
            this._pulseTimeoutId = 0;
        }

        this._proxy = null;
        this._frames = [];
    }

    // Accepts any integer-ish GVariant (uint16/uint32/uint64/int16/int32/int64).
    // Returns a JS number.
    _readIntLike(variant) {
        try {
            const v = variant.deep_unpack();
            if (typeof v === 'number')
                return v;
            if (typeof v === 'bigint')
                return Number(v);
        } catch (_e) {
            // fall through
        }
        return 0;
    }

    _addFrames() {
        for (const mon of Main.layoutManager.monitors) {
            const frame = new St.Widget({
                reactive: false,
                can_focus: false,
                track_hover: false,
                style: `border: ${this._borderThickness}px solid ${this._borderColor};`,
                x: mon.x,
                y: mon.y,
                width: mon.width,
                height: mon.height,
                opacity: OPACITY_MAX,
            });
            Main.layoutManager.addTopChrome(frame);
            this._frames.push(frame);
        }
    }

    _removeFrames() {
        for (const frame of this._frames) {
            Main.layoutManager.removeChrome(frame);
            frame.destroy();
        }
        this._frames = [];
    }

    _startPulse() {
        this._stopping = false;

        if (this._pulsing) {
            for (const frame of this._frames) {
                frame.remove_all_transitions();
                frame.opacity = OPACITY_MAX;
            }
            return;
        }

        this._pulsing = true;
        this._addFrames();
        this._pulseHigh = true;

        const tick = () => {
            if (!this._pulsing || this._stopping)
                return GLib.SOURCE_REMOVE;

            const target = this._pulseHigh ? OPACITY_MIN : OPACITY_MAX;
            this._pulseHigh = !this._pulseHigh;
            for (const frame of this._frames) {
                frame.ease({
                    opacity: target,
                    duration: this._pulseDuration,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                });
            }
            return GLib.SOURCE_CONTINUE;
        };

        tick();
        this._pulseTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._pulseDuration,
            tick,
        );
    }

    _stopPulse(immediate = false) {
        if (!this._pulsing)
            return;

        this._stopping = true;

        if (this._pulseTimeoutId) {
            GLib.source_remove(this._pulseTimeoutId);
            this._pulseTimeoutId = 0;
        }

        const frames = this._frames;
        this._frames = [];
        this._pulsing = false;

        if (immediate) {
            for (const frame of frames) {
                frame.remove_all_transitions();
                Main.layoutManager.removeChrome(frame);
                frame.destroy();
            }
            this._stopping = false;
            return;
        }

        let remaining = frames.length;
        if (remaining === 0) {
            this._stopping = false;
            return;
        }

        for (const frame of frames) {
            frame.remove_all_transitions();
            frame.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    Main.layoutManager.removeChrome(frame);
                    frame.destroy();
                    remaining -= 1;
                    if (remaining === 0)
                        this._stopping = false;
                },
            });
        }
    }
}
