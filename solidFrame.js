import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FADE_OUT_MS = 200;
const OPACITY_MIN = 60;
const OPACITY_MAX = 255;

// The original dbus-pulse rendering: a solid CSS border on every monitor
// whose opacity eases between two levels. Extracted verbatim from
// extension.js; behavior must not change.
export class SolidRenderer {
    constructor({borderColor, borderThickness, pulseDuration}) {
        this._borderColor = borderColor;
        this._borderThickness = borderThickness;
        this._pulseDuration = pulseDuration;

        this._frames = [];
        this._active = false;
        this._stopping = false;
        this._timeoutId = 0;
        this._high = true;
    }

    // Idempotent: calling while active resets the frames to full opacity.
    start() {
        this._stopping = false;

        if (this._active) {
            for (const frame of this._frames) {
                frame.remove_all_transitions();
                frame.opacity = OPACITY_MAX;
            }
            return;
        }

        this._active = true;
        this._addFrames();
        this._high = true;

        const tick = () => {
            if (!this._active || this._stopping)
                return GLib.SOURCE_REMOVE;

            const target = this._high ? OPACITY_MIN : OPACITY_MAX;
            this._high = !this._high;
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
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._pulseDuration,
            tick,
        );
    }

    stop(immediate = false) {
        if (!this._active)
            return;

        this._stopping = true;
        this._active = false;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        const frames = this._frames;
        this._frames = [];

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
}
