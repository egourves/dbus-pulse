import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FADE_OUT_MS = 200;
const BREATH_MIN = 0.4;

// Fragment shader: a conic rainbow gradient around the screen center with a
// soft distance-to-edge falloff (the glow) plus a thin bright rim. The fixed
// palette is the approved Apple-Intelligence-inspired set:
// #0a84ff #64d2ff #bf5af2 #ff375f #ff9f0a #ffd60a, looping.
// Stops are interpolated with a branchless mix chain — dynamic array indexing
// is not portable across the GLSL versions cogl may pick.
const DECLARATIONS = `
uniform vec2 u_size;
uniform float u_glow_width;
uniform float u_flow_phase;
uniform float u_breath;

const float PI = 3.141592653589793;
const float RIM_PX = 2.0;

vec3 aurora_palette(float t) {
    vec3 c0 = vec3(0.039, 0.518, 1.000);
    vec3 c1 = vec3(0.392, 0.824, 1.000);
    vec3 c2 = vec3(0.749, 0.353, 0.949);
    vec3 c3 = vec3(1.000, 0.216, 0.373);
    vec3 c4 = vec3(1.000, 0.624, 0.039);
    vec3 c5 = vec3(1.000, 0.839, 0.039);
    float x = fract(t) * 6.0;
    vec3 c = mix(c0, c1, clamp(x, 0.0, 1.0));
    c = mix(c, c2, clamp(x - 1.0, 0.0, 1.0));
    c = mix(c, c3, clamp(x - 2.0, 0.0, 1.0));
    c = mix(c, c4, clamp(x - 3.0, 0.0, 1.0));
    c = mix(c, c5, clamp(x - 4.0, 0.0, 1.0));
    c = mix(c, c0, clamp(x - 5.0, 0.0, 1.0));
    return c;
}
`;

const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 px = uv * u_size;
float d = min(min(px.x, u_size.x - px.x), min(px.y, u_size.y - px.y));

float glow = 1.0 - smoothstep(0.0, u_glow_width, d);
glow *= glow; // sharpen the falloff toward the edge
float rim = 1.0 - smoothstep(0.0, RIM_PX, d);

vec2 centered = uv - 0.5;
centered.x *= u_size.x / u_size.y; // aspect-correct so the wheel is circular
float angle = atan(centered.y, centered.x) / (2.0 * PI);
vec3 color = aurora_palette(angle + u_flow_phase);

float alpha = clamp(glow * 0.85 + rim * 0.9, 0.0, 1.0) * u_breath;
cogl_color_out = vec4(color * alpha, alpha); // premultiplied
`;

export const AuroraEffect = GObject.registerClass(
class AuroraEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        // Look uniforms up only after construction: the effect's Cogl
        // pipeline is assigned when build_pipeline() returns, so lookups
        // inside the vfunc dereference a NULL pipeline and crash the shell.
        this._uSize = this.get_uniform_location('u_size');
        this._uGlowWidth = this.get_uniform_location('u_glow_width');
        this._uFlowPhase = this.get_uniform_location('u_flow_phase');
        this._uBreath = this.get_uniform_location('u_breath');
        // Exceptions inside vfunc_build_pipeline are swallowed at the C
        // boundary; this plain-JS guard makes the failure visible so the
        // extension can fall back to the solid renderer.
        if (!(this._uSize >= 0))
            throw new Error('aurora GLSL uniforms unavailable (snippet not built?)');
    }

    vfunc_build_pipeline() {
        // GNOME 49+ exposes the snippet hooks through Cogl; the old
        // Shell.SnippetHook re-export is gone.
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    setGeometry(width, height, glowWidth) {
        this.set_uniform_float(this._uSize, 2, [width, height]);
        this.set_uniform_float(this._uGlowWidth, 1, [glowWidth]);
    }

    setPhase(flowPhase, breath) {
        this.set_uniform_float(this._uFlowPhase, 1, [flowPhase]);
        this.set_uniform_float(this._uBreath, 1, [breath]);
        this.queue_repaint();
    }
});

// Flowing rainbow soft glow on every monitor ("Apple Intelligence" style).
// Same contract as SolidRenderer: start() / stop(immediate).
export class AuroraRenderer {
    constructor({glowWidth, flowDuration, breathDuration}) {
        this._glowWidth = glowWidth;
        this._flowDuration = flowDuration;
        this._breathDuration = breathDuration;

        this._frames = []; // [{actor, effect}]
        this._timeline = null;
        this._active = false;
        this._startUs = 0;
    }

    // Idempotent: calling while active resets the frames to full intensity —
    // opacity for the actors, and the breath/flow clock for the shader.
    start() {
        if (this._active) {
            this._startUs = GLib.get_monotonic_time();
            for (const {actor} of this._frames) {
                actor.remove_all_transitions();
                actor.opacity = 255;
            }
            return;
        }

        this._active = true;
        this._startUs = GLib.get_monotonic_time();
        this._addFrames();
        this._startTimeline();
    }

    stop(immediate = false) {
        if (!this._active)
            return;

        this._active = false;

        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }

        const frames = this._frames;
        this._frames = [];

        if (immediate) {
            for (const {actor} of frames) {
                actor.remove_all_transitions();
                Main.layoutManager.removeChrome(actor);
                actor.destroy();
            }
            return;
        }

        // Colors freeze during the 200 ms fade-out (timeline is stopped);
        // matches the solid renderer, whose own animation also winds down.
        for (const {actor} of frames) {
            actor.remove_all_transitions();
            actor.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    Main.layoutManager.removeChrome(actor);
                    actor.destroy();
                },
            });
        }
    }

    _addFrames() {
        // Monitor geometry is in stage (logical) coordinates, and the shader
        // works in the same units, so the glow width is consistent across
        // mixed-DPI monitors without an explicit scale factor.
        for (const mon of Main.layoutManager.monitors) {
            const actor = new St.Widget({
                reactive: false,
                can_focus: false,
                track_hover: false,
                // Nearly-invisible fill so the actor has paintable content for
                // the offscreen effect; the shader overwrites it entirely.
                style: 'background-color: rgba(0, 0, 0, 0.01);',
                x: mon.x,
                y: mon.y,
                width: mon.width,
                height: mon.height,
                opacity: 255,
            });
            const effect = new AuroraEffect();
            actor.add_effect(effect);
            effect.setGeometry(mon.width, mon.height, this._glowWidth);
            effect.setPhase(0, 1); // deterministic bright start
            Main.layoutManager.addTopChrome(actor);
            this._frames.push({actor, effect});
        }
    }

    _startTimeline() {
        const first = this._frames[0]?.actor;
        if (!first)
            return;

        // One shared timeline drives every monitor's effect. The duration is
        // a dummy: it repeats forever and each tick derives the real phases
        // from the monotonic clock, so the knobs stay in JS and the shader
        // stays free of timing logic.
        this._timeline = new Clutter.Timeline({
            actor: first,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    _tick() {
        const elapsedMs = (GLib.get_monotonic_time() - this._startUs) / 1000;
        const flowPhase = (elapsedMs % this._flowDuration) / this._flowDuration;
        const breathT = (elapsedMs % this._breathDuration) / this._breathDuration;
        const breath = BREATH_MIN +
            (1 - BREATH_MIN) * (0.5 + 0.5 * Math.cos(2 * Math.PI * breathT));
        for (const {effect} of this._frames)
            effect.setPhase(flowPhase, breath);
    }
}
