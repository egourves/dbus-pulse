import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SolidRenderer} from './solidFrame.js';
import {AuroraRenderer} from './auroraFrame.js';

// Defaults for a hand-edited or partial signal entry. Keep these in sync with
// the gschema defaults for the legacy flat keys (the migration source).
const ENTRY_DEFAULTS = {
    triggerValue: 1,
    borderColor: 'rgba(255, 200, 0, 0.95)',
    borderThickness: 8,
    pulseDuration: 700,
    auroraGlowWidth: 80,
    auroraFlowDuration: 5000,
    auroraBreathDuration: 2400,
};

// Accepts any integer-ish GVariant (uint16/uint32/uint64/int16/int32/int64).
// Returns a JS number.
function readIntLike(variant) {
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

// Truncate to an integer, falling back when the input is not a finite number.
// Not `| 0`: triggerValue can be a full uint32 (> 2^31), which bitwise ops
// would corrupt.
function toInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// Normalize one raw (parsed-JSON) entry with defaults so a partial or
// hand-edited blob never crashes the shell.
function normalizeEntry(obj) {
    const src = (obj && typeof obj === 'object') ? obj : {};
    const str = (value, fallback) => (typeof value === 'string' ? value : fallback);
    return {
        id: (typeof src.id === 'string' && src.id) ? src.id : GLib.uuid_string_random(),
        busName: str(src.busName, ''),
        objectPath: str(src.objectPath, ''),
        interfaceName: str(src.interfaceName, ''),
        propertyName: str(src.propertyName, ''),
        triggerValue: toInt(src.triggerValue, ENTRY_DEFAULTS.triggerValue),
        // Anything but the exact string 'aurora' is treated as solid.
        style: src.style === 'aurora' ? 'aurora' : 'solid',
        // A blank string is preserved here and mapped to 'white' at render time.
        borderColor: str(src.borderColor, ENTRY_DEFAULTS.borderColor),
        borderThickness: toInt(src.borderThickness, ENTRY_DEFAULTS.borderThickness),
        pulseDuration: toInt(src.pulseDuration, ENTRY_DEFAULTS.pulseDuration),
        auroraGlowWidth: toInt(src.auroraGlowWidth, ENTRY_DEFAULTS.auroraGlowWidth),
        auroraFlowDuration: toInt(src.auroraFlowDuration, ENTRY_DEFAULTS.auroraFlowDuration),
        auroraBreathDuration: toInt(src.auroraBreathDuration, ENTRY_DEFAULTS.auroraBreathDuration),
    };
}

// Parse the 'signals' JSON array into normalized configs. On any JSON error
// (or a non-array payload) return [] so a broken blob simply shows nothing.
function parseSignals(settings) {
    let parsed;
    try {
        parsed = JSON.parse(settings.get_string('signals'));
    } catch (_e) {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    return parsed.map(normalizeEntry);
}

// One-shot migration from the legacy flat keys into the 'signals' array.
// A fresh install and an upgrade both seed the initial entry via this path:
// an empty 'signals' array is filled from the flat keys, then the flag is set.
function migrateIfNeeded(settings) {
    if (settings.get_boolean('migrated'))
        return;

    let parsed;
    try {
        parsed = JSON.parse(settings.get_string('signals'));
    } catch (_e) {
        parsed = [];
    }
    if (!Array.isArray(parsed))
        parsed = [];

    if (parsed.length === 0) {
        const entry = {
            id: GLib.uuid_string_random(),
            busName: settings.get_string('bus-name'),
            objectPath: settings.get_string('object-path'),
            interfaceName: settings.get_string('interface-name'),
            propertyName: settings.get_string('property-name'),
            triggerValue: settings.get_uint('trigger-value'),
            style: settings.get_string('style'),
            borderColor: settings.get_string('border-color'),
            borderThickness: settings.get_uint('border-thickness'),
            pulseDuration: settings.get_uint('pulse-duration'),
            auroraGlowWidth: settings.get_uint('aurora-glow-width'),
            auroraFlowDuration: settings.get_uint('aurora-flow-duration'),
            auroraBreathDuration: settings.get_uint('aurora-breath-duration'),
        };
        settings.set_string('signals', JSON.stringify([entry]));
    }

    settings.set_boolean('migrated', true);
}

// Build a plain solid-border renderer from a config. A blank border color is
// mapped to 'white', matching the pre-list behavior.
function createSolidRenderer(cfg) {
    return new SolidRenderer({
        borderColor: cfg.borderColor.trim() ? cfg.borderColor : 'white',
        borderThickness: cfg.borderThickness,
        pulseDuration: cfg.pulseDuration,
    });
}

// Build the renderer selected by a config's style.
function createRenderer(cfg) {
    if (cfg.style === 'aurora') {
        return new AuroraRenderer({
            glowWidth: cfg.auroraGlowWidth,
            flowDuration: cfg.auroraFlowDuration,
            breathDuration: cfg.auroraBreathDuration,
        });
    }
    return createSolidRenderer(cfg);
}

// Watches one DBus property on the session bus and tracks whether it currently
// equals its trigger value. Invokes onTransition(this) whenever that
// active-state flips (in either direction), so the arbiter can re-pick a winner.
class SignalWatcher {
    constructor(config, onTransition) {
        this.config = config;
        this.active = false;

        this._onTransition = onTransition;
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        this._propsChangedId = 0;
        this._stopped = false;
    }

    start() {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            null,
            this.config.busName,
            this.config.objectPath,
            this.config.interfaceName,
            this._cancellable,
            (obj, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, `dbus-pulse: failed to build proxy for ${this.config.busName} ${this.config.objectPath} ${this.config.interfaceName}`);
                    return;
                }

                // The watcher may have been stopped while the proxy was still
                // resolving. Guard so a late callback never wires signals into
                // (or fires transitions out of) a torn-down watcher.
                if (this._stopped)
                    return;

                this._proxy = proxy;
                this._cancellable = null;

                const initial = this._proxy.get_cached_property(this.config.propertyName);
                if (initial !== null)
                    this.active = readIntLike(initial) === this.config.triggerValue;

                this._propsChangedId = this._proxy.connect('g-properties-changed',
                    (_proxy, changed) => {
                        const unpacked = changed.deep_unpack();
                        if (!(this.config.propertyName in unpacked))
                            return;
                        // The watched property is assumed to be an unsigned integer.
                        // deep_unpack on the inner GVariant returns a JS number (or
                        // BigInt for 64-bit), which readIntLike normalizes.
                        const next = readIntLike(unpacked[this.config.propertyName]);
                        const isActive = next === this.config.triggerValue;
                        if (isActive !== this.active) {
                            this.active = isActive;
                            this._onTransition(this);
                        }
                    });

                // A signal already in its trigger state at startup lights up.
                if (this.active)
                    this._onTransition(this);
            });
    }

    stop() {
        this._stopped = true;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._proxy && this._propsChangedId) {
            this._proxy.disconnect(this._propsChangedId);
            this._propsChangedId = 0;
        }

        this._proxy = null;
        this.active = false;
    }
}

// Owns the single on-screen effect. Given the watchers in priority order
// (index 0 = highest priority), it shows the effect for the first currently
// active watcher, switching immediately as active-states change.
class Arbiter {
    constructor(watchers) {
        this._watchers = watchers;
        this._renderer = null;
        this._currentWinner = null;

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());
    }

    // Winner = first active watcher in priority order, or null. Only touch the
    // renderer when the winner actually changes.
    reevaluate() {
        let winner = null;
        for (const watcher of this._watchers) {
            if (watcher.active) {
                winner = watcher;
                break;
            }
        }

        if (winner === this._currentWinner)
            return;

        if (winner) {
            // Switching to a different signal's effect: drop the outgoing one
            // immediately so two effects never overlap.
            this._teardownRenderer(true);
            this._currentWinner = winner;
            this._render(winner.config);
        } else {
            // No signal is active anymore: fade the current effect out
            // gracefully, matching the pre-list behavior when the watched
            // property left its trigger value.
            this._teardownRenderer(false);
            this._currentWinner = null;
        }
    }

    _render(config) {
        this._renderer = createRenderer(config);
        try {
            this._renderer.start();
        } catch (e) {
            // This extension is a security signal (e.g. a pending YubiKey
            // touch); the alert must never silently disappear. If the aurora
            // path fails (e.g. shader construction on exotic drivers), fall
            // back to a plain border built from the same config.
            logError(e, 'dbus-pulse: renderer failed to start, falling back to solid border');
            this._renderer.stop(true);
            this._renderer = createSolidRenderer(config);
            this._renderer.start();
        }
    }

    _onMonitorsChanged() {
        if (!this._currentWinner)
            return;
        // Rebuild the current effect for the new monitor set, routing through
        // _render so the hot-plug restart gets the same solid fallback as the
        // trigger path.
        this._teardownRenderer();
        this._render(this._currentWinner.config);
    }

    _teardownRenderer(immediate = true) {
        if (this._renderer) {
            this._renderer.stop(immediate);
            this._renderer = null;
        }
    }

    stop() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._teardownRenderer();
        this._currentWinner = null;
    }
}

export default class DBusPulseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Seed the initial entry (fresh install or upgrade) before anything
        // reads the 'signals' array.
        migrateIfNeeded(this._settings);

        this._settingsChangedIds = [];
        // 'signals' is now the only watched key: any change (add/remove/reorder/
        // edit) triggers a full teardown + rebuild.
        this._settingsChangedIds.push(
            this._settings.connect('changed::signals', () => this._rebuild()));

        this._watchers = [];
        this._arbiter = null;

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
        const configs = parseSignals(this._settings);

        // Each watcher's transition callback re-runs the arbiter. The arbiter
        // is constructed right after, and proxy resolution is async, so
        // `this._arbiter` is always set before any callback can fire.
        this._watchers = configs.map(config =>
            new SignalWatcher(config, () => this._arbiter.reevaluate()));

        this._arbiter = new Arbiter(this._watchers);

        for (const watcher of this._watchers)
            watcher.start();
    }

    _stop() {
        if (this._arbiter) {
            this._arbiter.stop();
            this._arbiter = null;
        }

        if (this._watchers) {
            for (const watcher of this._watchers)
                watcher.stop();
        }
        this._watchers = [];
    }
}
