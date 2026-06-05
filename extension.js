import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SolidRenderer} from './solidFrame.js';
import {AuroraRenderer} from './auroraFrame.js';

// Settings keys that affect the DBus subscription or visible styling.
// Any change to these triggers a full teardown + rebuild.
const WATCHED_KEYS = [
    'bus-name',
    'object-path',
    'interface-name',
    'property-name',
    'trigger-value',
    'style',
    'border-color',
    'border-thickness',
    'pulse-duration',
    'aurora-glow-width',
    'aurora-flow-duration',
    'aurora-breath-duration',
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

        this._renderer = this._createRenderer();
        this._pulseActive = false;

        this._proxy = null;
        this._proxyCancellable = new Gio.Cancellable();
        this._propsChangedId = 0;
        this._monitorsChangedId = 0;
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
                        // The watched property is assumed to be an unsigned integer. deep_unpack on the
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
                        if (this._pulseActive) {
                            this._renderer.stop(true);
                            // Route through _startPulse so the hot-plug restart
                            // gets the same solid fallback as the trigger path.
                            this._startPulse();
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

        this._proxy = null;
        this._renderer = null;
    }

    _createRenderer() {
        if (this._settings.get_string('style') === 'aurora') {
            return new AuroraRenderer({
                glowWidth: this._settings.get_uint('aurora-glow-width'),
                flowDuration: this._settings.get_uint('aurora-flow-duration'),
                breathDuration: this._settings.get_uint('aurora-breath-duration'),
            });
        }
        return this._createSolidRenderer();
    }

    _createSolidRenderer() {
        const rawColor = this._settings.get_string('border-color');
        return new SolidRenderer({
            borderColor: rawColor.trim() ? rawColor : 'white',
            borderThickness: this._settings.get_uint('border-thickness'),
            pulseDuration: this._settings.get_uint('pulse-duration'),
        });
    }

    _startPulse() {
        this._pulseActive = true;
        try {
            this._renderer.start();
        } catch (e) {
            // This extension is a security signal (pending YubiKey touch);
            // the alert must never silently disappear. If the aurora path
            // fails (e.g. shader construction on exotic drivers), fall back
            // to the plain border.
            logError(e, 'dbus-pulse: renderer failed to start, falling back to solid border');
            this._renderer.stop(true);
            this._renderer = this._createSolidRenderer();
            this._renderer.start();
        }
    }

    _stopPulse(immediate = false) {
        this._pulseActive = false;
        if (this._renderer)
            this._renderer.stop(immediate);
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
}
