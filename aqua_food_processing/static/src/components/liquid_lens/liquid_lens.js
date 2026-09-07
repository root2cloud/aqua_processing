/** @odoo-module **/
/**
 * LiquidLens — a full-surface WebGL fluid simulation that stirs the real
 * dashboard content wherever the cursor moves.
 *
 * This used to live inline inside AquaDashboard (dashboard.js). It has been
 * pulled out into its own component purely to keep the ~900 lines of WebGL
 * plumbing (shaders, framebuffers, the stable-fluids solve) out of the main
 * dashboard class - nothing about *how* the effect works has changed.
 *
 * Mount it as the FIRST child of whatever element it should cover (see
 * dashboard_templates.xml, where it's the first thing inside
 * .o_aqua_dashboard) - it reads its own root element's parentElement as the
 * surface to size against and listen for pointer events on, exactly as it
 * did when this code lived directly inside AquaDashboard.
 */
import { Component, onMounted, onWillUnmount, useRef } from "@odoo/owl";

export class LiquidLens extends Component {
    static template = "aqua_food_processing.LiquidLens";
    static props = {};

    setup() {
        this.liquidLensRef = useRef("liquidLens");
        this.liquidLensCanvasRef = useRef("liquidLensCanvas");
        onMounted(() => this._initLiquidLens());
        onWillUnmount(() => this._teardownLiquidLens());
    }

    // ==========================================================================
    // Liquid ripple
    //
    // A direct WebGL port of the reference effect: a real fluid simulation
    // (velocity + dye advected through a divergence/pressure solve, exactly
    // the "stable fluids" technique) that displaces a texture per-pixel via
    // a fragment shader - see https://liquid-image.learnframer.site/ and
    // the CodePen behind it, https://codepen.io/ksenia-k/pen/jENEMjN
    // (itself built on Pavel Dobryakov's fluid sim,
    // https://codepen.io/PavelDoGreat/pen/zdWzEL).
    //
    // An earlier version of this effect ran on the 2D canvas API: a coarse
    // grid of tiles, each redrawn from a screenshot at a small sine-based
    // offset. That is fundamentally the wrong tool for this job. A tiled
    // copy-and-offset approach is fine on a smooth photograph (which is
    // all the reference ever distorts) but breaks visibly on crisp UI
    // text and icons: the moment a displacement boundary crosses through a
    // letterform, that letter visibly tears, because neighbouring pixels a
    // few px apart suddenly sample from different, discontinuous source
    // offsets. No amount of tuning grid size or amplitude fixes that - the
    // discontinuity is the tiling itself. The reference never has this
    // problem because its shader computes a smooth, continuous, per-pixel
    // UV offset (via a velocity field sampled with bilinear filtering) -
    // there is no grid to see the seams of. Reproducing that fully
    // therefore means reproducing the actual technique, not a CPU/2D
    // approximation of its silhouette: real WebGL textures, a real
    // divergence-free velocity field, sampled continuously.
    //
    // What's kept from the reference, faithfully:
    //  - The full simulation pipeline and its constants: splat -> solve
    //    divergence -> 16-iteration Jacobi pressure solve -> subtract the
    //    pressure gradient (making the field divergence-free, which is
    //    what makes disturbances curl into little vortices instead of
    //    just smearing) -> self-advect velocity -> advect the "dye" field
    //    that the display pass reads its displacement strength from.
    //  - The exact same shaders for every one of those steps (see the
    //    LIQUID_*_SRC constants below) - only the final display shader
    //    differs, and only where it has to (see below).
    //  - The same manual bilinear-sampling trick (`bilerp()`) the
    //    reference uses in its advection shader, wherever this needs to
    //    read a velocity/dye value smoothly. This one is *load-bearing*:
    //    WebGL1 doesn't guarantee LINEAR filtering on floating-point
    //    textures, so both the reference and this port build bilinear
    //    sampling out of four NEAREST reads instead of trusting hardware
    //    filtering - without it, the low-resolution simulation grid would
    //    show through as blocky steps, reintroducing the exact "visible
    //    seams" problem this rewrite exists to fix.
    //
    // What's deliberately different, and why:
    //  - The "photo" being distorted is a live thing, not a fixed image:
    //    `canvas` can only ever draw from an image/canvas/video source,
    //    never the DOM directly, so a periodic html2canvas screenshot of
    //    the real dashboard (every card, chart, gap) is captured on a
    //    timer and re-uploaded into a texture (see _liquidTakeSnapshot).
    //  - The reference always paints a full-bleed photo - there's nothing
    //    behind its canvas to show through. Here, the real dashboard *is*
    //    what's behind the canvas, so the display shader outputs alpha 0
    //    wherever nothing is currently disturbed (derived from the same
    //    dye density that drives the displacement itself), letting the
    //    real DOM show through untouched. Nothing is drawn "on top" of
    //    calm content - hence no lens, frame, or edge anywhere.
    //  - The reference runs its simulation at the same resolution as the
    //    display canvas (confirmed straight from its own source: its
    //    `resizeCanvas()` sets the sim's `res.w/h` to literally
    //    `canvasEl.width/height` - no downsampling at all). This port
    //    follows the same approach: the velocity/pressure/divergence
    //    solve runs at close to the dashboard's own display resolution,
    //    which is what gives the swirls their crisp, richly-detailed
    //    edges rather than a soft blur. It's still capped
    //    (LIQUID_SIM_RESOLUTION) rather than fully uncapped, because a
    //    scrollable dashboard can be considerably taller than the single
    //    browser window the reference always runs in - the cap only
    //    matters on unusually long pages, and is high enough that it
    //    never engages on an ordinary viewport-sized one. The dye field
    //    gets its own, higher-still cap (LIQUID_DYE_RESOLUTION) for extra
    //    swirl detail, which the reference's own advection shader already
    //    supports natively (it takes the advected field's texel size as a
    //    parameter separate from the velocity field's) - this isn't a
    //    deviation so much as using a knob the original shader always had.
    //  - The reference's idle preview drifts the splat point in a lazy
    //    Lissajous curve before you've touched it - nice for a demo page,
    //    not for a data dashboard someone is trying to read. This version
    //    only ever reacts to a real cursor/touch and sits perfectly still
    //    (and fully invisible) otherwise.
    // ==========================================================================

    // ---- Vertex shader shared by every program below ----
    static LIQUID_VERT_SRC = `
        precision highp float;

        varying vec2 vUv;
        attribute vec2 a_position;

        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 u_texel;

        void main () {
            vUv = .5 * (a_position + 1.);
            vL = vUv - vec2(u_texel.x, 0.);
            vR = vUv + vec2(u_texel.x, 0.);
            vT = vUv + vec2(0., u_texel.y);
            vB = vUv - vec2(0., u_texel.y);
            gl_Position = vec4(a_position, 0., 1.);
        }
    `;

    // ---- Splats a pointer-movement impulse into whatever field it's targeting ----
    static LIQUID_SPLAT_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D u_input_texture;
        uniform float u_ratio;
        uniform vec3 u_point_value;
        uniform vec2 u_point;
        uniform float u_point_size;

        void main () {
            vec2 p = vUv - u_point.xy;
            p.x *= u_ratio;
            vec3 splat = .6 * pow(2., -dot(p, p) / u_point_size) * u_point_value;

            vec3 base = texture2D(u_input_texture, vUv).xyz;
            gl_FragColor = vec4(base + splat, 1.);
        }
    `;

    static LIQUID_DIVERGENCE_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D u_velocity_texture;

        void main () {
            float L = texture2D(u_velocity_texture, vL).x;
            float R = texture2D(u_velocity_texture, vR).x;
            float T = texture2D(u_velocity_texture, vT).y;
            float B = texture2D(u_velocity_texture, vB).y;

            float div = .25 * (R - L + T - B);
            gl_FragColor = vec4(div, 0., 0., 1.);
        }
    `;

    static LIQUID_PRESSURE_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D u_pressure_texture;
        uniform sampler2D u_divergence_texture;

        void main () {
            float L = texture2D(u_pressure_texture, vL).x;
            float R = texture2D(u_pressure_texture, vR).x;
            float T = texture2D(u_pressure_texture, vT).x;
            float B = texture2D(u_pressure_texture, vB).x;
            float divergence = texture2D(u_divergence_texture, vUv).x;
            float pressure = (L + R + B + T - divergence) * .25;

            gl_FragColor = vec4(pressure, 0., 0., 1.);
        }
    `;

    static LIQUID_GRADIENT_SUBTRACT_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D u_pressure_texture;
        uniform sampler2D u_velocity_texture;

        void main () {
            float L = texture2D(u_pressure_texture, vL).x;
            float R = texture2D(u_pressure_texture, vR).x;
            float T = texture2D(u_pressure_texture, vT).x;
            float B = texture2D(u_pressure_texture, vB).x;
            vec2 velocity = texture2D(u_velocity_texture, vUv).xy;
            velocity.xy -= vec2(R - L, T - B);
            gl_FragColor = vec4(velocity, 0., 1.);
        }
    `;

    // Reused for both the velocity self-advection pass and the dye
    // advection pass below - u_texel always describes the *velocity*
    // field's own resolution (it's what's used to look up the flow at
    // vUv), while u_output_textel describes whichever field is actually
    // being carried along (u_input_texture) - velocity's own resolution
    // when advecting itself, the dye field's resolution when advecting
    // dye. See _liquidSimulate for exactly how these get set per call.
    static LIQUID_ADVECTION_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D u_velocity_texture;
        uniform sampler2D u_input_texture;
        uniform vec2 u_texel;
        uniform vec2 u_output_textel;
        uniform float u_dt;
        uniform float u_dissipation;

        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;

            vec2 iuv = floor(st);
            vec2 fuv = fract(st);

            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }

        void main () {
            vec2 coord = vUv - u_dt * bilerp(u_velocity_texture, vUv, u_texel).xy * u_texel;
            vec4 velocity = bilerp(u_input_texture, coord, u_output_textel);
            gl_FragColor = u_dissipation * velocity;
        }
    `;

    // The one shader that genuinely differs from the reference, and only
    // by what it has to: no image-aspect-ratio "cover" correction (the
    // snapshot texture is always exactly the same aspect ratio as the
    // canvas, since it's a screenshot of the very thing the canvas
    // overlays - unlike the reference, which fits an arbitrary photo into
    // its frame), and alpha derived from disturbance instead of a
    // constant 1 (so untouched dashboard content shows through instead of
    // being covered by a static "frame"). Both texture reads that feed
    // the displacement go through the same manual `bilerp()` the
    // advection shader above uses, and for the same reason: sampling the
    // low-resolution velocity/dye fields with plain NEAREST texture2D
    // here would reintroduce a blocky step every few screen pixels,
    // right back to the "visible seams on text" problem this rewrite
    // exists to fix.
    static LIQUID_DISPLAY_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform vec2 u_sim_texel;
        uniform vec2 u_dye_texel;
        uniform float u_disturb_power;
        uniform sampler2D u_output_texture;
        uniform sampler2D u_velocity_texture;
        uniform sampler2D u_text_texture;

        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;

            vec2 iuv = floor(st);
            vec2 fuv = fract(st);

            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }

        void main () {
            float offset = bilerp(u_output_texture, vUv, u_dye_texel).r;
            vec2 velocity = bilerp(u_velocity_texture, vUv, u_sim_texel).xy;
            vec2 dir = velocity + vec2(0.0008, 0.0006);
            vec2 uv = vUv - u_disturb_power * normalize(dir) * offset;
            uv = clamp(uv, 0.0, 1.0);
            vec3 img = texture2D(u_text_texture, vec2(uv.x, 1.0 - uv.y)).rgb;
            // Fully transparent at rest; fades in with how disturbed this
            // patch currently is - there is no frame, edge or shape to
            // this effect beyond that, on purpose. The upper edge here is
            // tuned alongside LIQUID_SPLAT_DYE_POWER above: wide enough
            // that reaching full opacity still reads as a gradual fade
            // rather than a hard on/off flicker.
            float alpha = smoothstep(0.0, 0.16, offset);
            gl_FragColor = vec4(img, alpha);
        }
    `;

    // Everything from here down is the same handful of tuning numbers the
    // reference itself uses (splat force, dye/cursor "power", dissipation
    // rates, distortion power), carried over as-is - see the CodePen
    // linked above for their `params` object and `updatePointerPosition` -
    // with two deliberate exceptions: the resolution caps (explained
    // above _initLiquidLens) and LIQUID_SPLAT_DYE_POWER, bumped up from
    // the reference's own default of .024 (24 * .001) to sit closer to
    // the strong, richly-swirled look their own "cursorPower" slider
    // produces around 55-60 - a livelier result than the demo's
    // out-of-the-box default is the better fit for something meant to
    // actually be noticed on a dashboard someone is moving their mouse
    // across, rather than a deliberately understated starting point meant
    // to be tuned upward by hand via a GUI slider.
    static LIQUID_SIM_RESOLUTION = 480;
    static LIQUID_DYE_RESOLUTION = 960;
    static LIQUID_PRESSURE_ITERATIONS = 16;
    static LIQUID_SNAPSHOT_INTERVAL_MS = 1500;
    static LIQUID_VELOCITY_DT = 1 / 60;
    static LIQUID_VELOCITY_DISSIPATION = .97;
    static LIQUID_DYE_DISSIPATION = .98;
    static LIQUID_DYE_DT_MULT = 8;
    static LIQUID_SPLAT_FORCE = 6;
    static LIQUID_SPLAT_SIZE = .002;
    static LIQUID_SPLAT_DYE_POWER = .056;
    static LIQUID_DISTURB_POWER = .4;

    _initLiquidLens() {
        const lensEl = this.liquidLensRef.el;
        const canvasEl = this.liquidLensCanvasRef.el;
        if (!lensEl || !canvasEl) return;
        const rootEl = lensEl.parentElement;
        if (!rootEl) return;

        // Every prerequisite gets checked up front and bails out quietly
        // on failure - the dashboard is fully usable without this effect,
        // so a missing dependency should never be user-visible as
        // anything worse than "no ripple".
        if (typeof window.html2canvas !== "function") return;
        if (typeof ResizeObserver !== "function") return;

        const gl = canvasEl.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false })
            || canvasEl.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
        if (!gl) return;
        // The velocity/pressure/divergence/dye fields are floating-point
        // textures (they hold signed, unbounded values, not 0..1 colour) -
        // not supported on WebGL1 without this extension.
        if (!gl.getExtension("OES_texture_float")) return;

        const vertexShader = this._liquidCompileShader(gl, LiquidLens.LIQUID_VERT_SRC, gl.VERTEX_SHADER);
        if (!vertexShader) return;

        const programs = {
            splatProgram: this._liquidCreateProgram(gl, vertexShader, LiquidLens.LIQUID_SPLAT_SRC),
            divergenceProgram: this._liquidCreateProgram(gl, vertexShader, LiquidLens.LIQUID_DIVERGENCE_SRC),
            pressureProgram: this._liquidCreateProgram(gl, vertexShader, LiquidLens.LIQUID_PRESSURE_SRC),
            gradientSubtractProgram: this._liquidCreateProgram(gl, vertexShader, LiquidLens.LIQUID_GRADIENT_SUBTRACT_SRC),
            advectionProgram: this._liquidCreateProgram(gl, vertexShader, LiquidLens.LIQUID_ADVECTION_SRC),
            displayProgram: this._liquidCreateProgram(gl, vertexShader, LiquidLens.LIQUID_DISPLAY_SRC),
        };
        if (Object.values(programs).some((p) => !p)) {
            // A shader failed to compile/link - extremely unusual, but
            // possible on an old/unusual GPU driver. Bail rather than run
            // with a partially-broken pipeline.
            return;
        }

        const quadVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        const quadIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        // Every program above was linked with a_position pinned to
        // location 0 (see _liquidCreateProgram), so this only needs
        // doing once - it stays valid across every gl.useProgram() switch
        // in the render loop below.
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        const liquid = {
            rootEl, lensEl, canvasEl, gl, programs, quadVbo, quadIbo,
            dpr: Math.min(window.devicePixelRatio || 1, 2),
            width: 0, height: 0,
            velocity: null, divergence: null, pressure: null, dye: null,
            simTexel: { x: 0, y: 0 },
            dyeTexel: { x: 0, y: 0 },
            textTexture: null,
            pointer: { x: 0, y: 0, dx: 0, dy: 0, moved: false },
            hasEntered: false,
            destroyed: false,
            rafId: null,
            snapshotTimer: null,
            snapshotMismatch: false,
            resizeObserver: null,
        };
        this._liquid = liquid;

        // The live DOM snapshot lands in this texture (see
        // _liquidTakeSnapshot). LINEAR is safe here - unlike the FLOAT
        // simulation textures above, this is a plain UNSIGNED_BYTE RGBA
        // texture, which every WebGL1 implementation can filter natively.
        liquid.textTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, liquid.textTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // 1x1 fully-transparent placeholder until the first snapshot lands.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

        if (!this._liquidResize(liquid)) {
            this._teardownLiquidLens();
            return;
        }

        liquid.onPointerMove = (ev) => {
            const r = rootEl.getBoundingClientRect();
            this._liquidUpdatePointer(liquid, ev.clientX - r.left, ev.clientY - r.top);
        };
        liquid.onTouchMove = (ev) => {
            if (!ev.targetTouches.length) return;
            const r = rootEl.getBoundingClientRect();
            const t = ev.targetTouches[0];
            this._liquidUpdatePointer(liquid, t.clientX - r.left, t.clientY - r.top);
        };
        liquid.onMouseEnter = (ev) => {
            const r = rootEl.getBoundingClientRect();
            // Snap straight to the entry point rather than treating the
            // jump from wherever the pointer last was as a giant splat.
            liquid.pointer.x = ev.clientX - r.left;
            liquid.pointer.y = ev.clientY - r.top;
            liquid.hasEntered = true;
        };
        // Bound to the dashboard root (not the canvas): the canvas is
        // pointer-events:none specifically so it never blocks clicks on
        // the real UI it's disturbing, which means the root - not the
        // canvas - is what actually receives these events.
        rootEl.addEventListener("mousemove", liquid.onPointerMove);
        rootEl.addEventListener("touchmove", liquid.onTouchMove, { passive: true });
        rootEl.addEventListener("mouseenter", liquid.onMouseEnter);

        // A ResizeObserver rather than a window "resize" listener: the
        // dashboard's own height changes for lots of reasons that have
        // nothing to do with the window - switching tabs, a chart
        // finishing its first render, a drill-down panel opening.
        liquid.resizeObserver = new ResizeObserver(() => {
            if (!this._liquidResize(liquid)) {
                this._teardownLiquidLens();
                return;
            }
            this._liquidScheduleSnapshot(150);
        });
        liquid.resizeObserver.observe(rootEl);

        // A short initial delay, not an immediate capture: right at mount
        // is exactly when async widgets (weather, charts, CountUp
        // animations) are least likely to have settled yet, and the
        // mismatch self-correction in _liquidTakeSnapshot can then only
        // narrow the resulting gap after the fact, not prevent it.
        this._liquidScheduleSnapshot(300);
        liquid.rafId = requestAnimationFrame(() => this._liquidTick());
    }

    _teardownLiquidLens() {
        const liquid = this._liquid;
        if (!liquid) return;
        liquid.destroyed = true;
        if (liquid.rafId) cancelAnimationFrame(liquid.rafId);
        if (liquid.snapshotTimer) clearTimeout(liquid.snapshotTimer);
        if (liquid.resizeObserver) liquid.resizeObserver.disconnect();
        liquid.rootEl.removeEventListener("mousemove", liquid.onPointerMove);
        liquid.rootEl.removeEventListener("touchmove", liquid.onTouchMove);
        liquid.rootEl.removeEventListener("mouseenter", liquid.onMouseEnter);

        // Explicitly release every GPU resource rather than leaving it to
        // garbage collection - this component can mount and unmount many
        // times as someone navigates in and out of the dashboard action,
        // and WebGL contexts/textures are not cheap to leave dangling.
        const { gl } = liquid;
        if (gl) {
            this._liquidDeleteDoubleFBO(gl, liquid.velocity);
            this._liquidDeleteFBO(gl, liquid.divergence);
            this._liquidDeleteDoubleFBO(gl, liquid.pressure);
            this._liquidDeleteDoubleFBO(gl, liquid.dye);
            if (liquid.textTexture) gl.deleteTexture(liquid.textTexture);
            if (liquid.quadVbo) gl.deleteBuffer(liquid.quadVbo);
            if (liquid.quadIbo) gl.deleteBuffer(liquid.quadIbo);
            for (const key of Object.keys(liquid.programs || {})) {
                const p = liquid.programs[key];
                if (p && p.program) gl.deleteProgram(p.program);
            }
            // Losing the context outright hands the GPU memory back
            // immediately instead of waiting on the canvas element itself
            // to be garbage-collected.
            const loseCtx = gl.getExtension("WEBGL_lose_context");
            if (loseCtx) loseCtx.loseContext();
        }

        this._liquid = null;
    }

    _liquidCompileShader(gl, source, type) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error("Liquid ripple: shader compile error:", gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    _liquidCreateProgram(gl, vertexShader, fragmentSource) {
        const fragmentShader = this._liquidCompileShader(gl, fragmentSource, gl.FRAGMENT_SHADER);
        if (!fragmentShader) return null;
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        // Pin a_position to a known location before linking so every
        // program agrees on it - that's what lets the fullscreen-quad
        // buffer be bound once (in _initLiquidLens) and reused across
        // every gl.useProgram() switch in the render loop.
        gl.bindAttribLocation(program, 0, "a_position");
        gl.linkProgram(program);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("Liquid ripple: program link error:", gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }
        return { program, uniforms: this._liquidGetUniforms(gl, program) };
    }

    _liquidGetUniforms(gl, program) {
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name] = gl.getUniformLocation(program, info.name);
        }
        return uniforms;
    }

    // Creates one float-texture render target. Returns null (after
    // cleaning up after itself) if this GPU/driver can create a
    // floating-point texture but can't actually render into one - rare,
    // but real on some older/mobile drivers, and worth checking
    // explicitly rather than silently producing a broken effect.
    _liquidCreateFBO(gl, w, h) {
        gl.activeTexture(gl.TEXTURE0);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(texture);
            return null;
        }

        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return {
            fbo, texture, width: w, height: h,
            attach(unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return unit;
            },
        };
    }

    _liquidCreateDoubleFBO(gl, w, h) {
        const a = this._liquidCreateFBO(gl, w, h);
        const b = this._liquidCreateFBO(gl, w, h);
        if (!a || !b) {
            if (a) this._liquidDeleteFBO(gl, a);
            if (b) this._liquidDeleteFBO(gl, b);
            return null;
        }
        let read = a;
        let write = b;
        return {
            width: w, height: h,
            texelSizeX: 1 / w, texelSizeY: 1 / h,
            read: () => read,
            write: () => write,
            swap() { const t = read; read = write; write = t; },
        };
    }

    _liquidDeleteFBO(gl, fboObj) {
        if (!fboObj) return;
        gl.deleteFramebuffer(fboObj.fbo);
        gl.deleteTexture(fboObj.texture);
    }

    _liquidDeleteDoubleFBO(gl, doubleFboObj) {
        if (!doubleFboObj) return;
        this._liquidDeleteFBO(gl, doubleFboObj.read());
        this._liquidDeleteFBO(gl, doubleFboObj.write());
    }

    // Picks a grid size that preserves the dashboard's own aspect ratio -
    // needed so splats stay circular (see u_ratio in LIQUID_SPLAT_SRC) and
    // nothing looks stretched.
    _liquidFitResolution(width, height, maxDim) {
        const aspect = width / height;
        if (aspect >= 1) {
            return { w: maxDim, h: Math.max(1, Math.round(maxDim / aspect)) };
        }
        return { w: Math.max(1, Math.round(maxDim * aspect)), h: maxDim };
    }

    // (Re)sizes the canvas to cover the dashboard root edge-to-edge and
    // rebuilds every simulation buffer to match. Called on mount, whenever
    // the root's own box size changes, and speculatively after every
    // snapshot (see _liquidTakeSnapshot) to catch async content that
    // reflowed the page without a discrete resize event ever firing.
    // Deliberately a cheap no-op when the size hasn't actually moved -
    // reallocating throws away the simulation's current velocity/dye
    // state, which would otherwise make ripples visibly "reset" every
    // time this got called defensively rather than only on a real change.
    // Returns false if a buffer failed to allocate (see
    // _liquidCreateFBO), in which case the caller tears the whole effect
    // down rather than run with a broken pipeline.
    _liquidResize(liquid) {
        const { gl, rootEl, canvasEl, dpr } = liquid;
        const width = Math.max(1, rootEl.clientWidth);
        const height = Math.max(1, rootEl.clientHeight);
        if (liquid.velocity && width === liquid.width && height === liquid.height) {
            return true;
        }
        liquid.width = width;
        liquid.height = height;

        canvasEl.style.width = width + "px";
        canvasEl.style.height = height + "px";
        canvasEl.width = Math.round(width * dpr);
        canvasEl.height = Math.round(height * dpr);

        this._liquidDeleteDoubleFBO(gl, liquid.velocity);
        this._liquidDeleteFBO(gl, liquid.divergence);
        this._liquidDeleteDoubleFBO(gl, liquid.pressure);
        this._liquidDeleteDoubleFBO(gl, liquid.dye);

        const simSize = this._liquidFitResolution(width, height, LiquidLens.LIQUID_SIM_RESOLUTION);
        const dyeSize = this._liquidFitResolution(width, height, LiquidLens.LIQUID_DYE_RESOLUTION);

        liquid.velocity = this._liquidCreateDoubleFBO(gl, simSize.w, simSize.h);
        liquid.divergence = this._liquidCreateFBO(gl, simSize.w, simSize.h);
        liquid.pressure = this._liquidCreateDoubleFBO(gl, simSize.w, simSize.h);
        liquid.dye = this._liquidCreateDoubleFBO(gl, dyeSize.w, dyeSize.h);
        liquid.simTexel = { x: 1 / simSize.w, y: 1 / simSize.h };
        liquid.dyeTexel = { x: 1 / dyeSize.w, y: 1 / dyeSize.h };

        return !!(liquid.velocity && liquid.divergence && liquid.pressure && liquid.dye);
    }

    _liquidUpdatePointer(liquid, x, y) {
        if (!liquid.hasEntered) {
            // First move before any mouseenter fired (e.g. the pointer
            // was already sitting over the dashboard when it mounted) -
            // snap rather than splatting in from (0, 0).
            liquid.pointer.x = x;
            liquid.pointer.y = y;
            liquid.hasEntered = true;
            return;
        }
        liquid.pointer.dx = LiquidLens.LIQUID_SPLAT_FORCE * (x - liquid.pointer.x);
        liquid.pointer.dy = LiquidLens.LIQUID_SPLAT_FORCE * (y - liquid.pointer.y);
        liquid.pointer.x = x;
        liquid.pointer.y = y;
        liquid.pointer.moved = true;
    }

    // Grabs a fresh html2canvas screenshot of the whole dashboard root and
    // uploads it into the texture the display shader reads from (see
    // LIQUID_DISPLAY_SRC / _liquidDisplay). Re-runs itself on a timer -
    // and can be nudged to run sooner (a resize, a just-finished previous
    // capture) via the `delayMs` argument - but never overlaps two
    // captures at once.
    _liquidScheduleSnapshot(delayMs) {
        const liquid = this._liquid;
        if (!liquid || liquid.destroyed) return;
        if (liquid.snapshotTimer) clearTimeout(liquid.snapshotTimer);
        liquid.snapshotTimer = setTimeout(() => this._liquidTakeSnapshot(), delayMs);
    }

    _liquidTakeSnapshot() {
        const liquid = this._liquid;
        if (!liquid || liquid.destroyed) return;
        window.html2canvas(liquid.rootEl, {
            backgroundColor: null,
            scale: liquid.dpr,
            logging: false,
            useCORS: true,
            // Never capture the ripple canvas itself - it sits on top of
            // the very content it's meant to be reading from.
            ignoreElements: (el) => el === liquid.lensEl,
        }).then((snapshotCanvas) => {
            if (!liquid || liquid.destroyed) return;
            const { gl } = liquid;
            gl.bindTexture(gl.TEXTURE_2D, liquid.textTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshotCanvas);

            // html2canvas is asynchronous and, on a dashboard with async
            // widgets (a weather fetch, a chart's first render, a
            // CountUp animation finishing), can take just long enough for
            // the page to reflow *while a capture is in flight*. Left
            // alone, the texture just uploaded would then represent a
            // slightly different content height than the canvas is
            // currently sized for - so wherever the effect is active,
            // the displaced content would sample from the wrong place
            // and look stretched or doubled against the real DOM under
            // it, rather than a clean ripple. Re-measure immediately
            // after every capture (cheap - see the no-op guard at the
            // top of _liquidResize) and, if the page genuinely moved
            // since this capture started, resize right away and queue a
            // fast follow-up capture instead of waiting out the full
            // interval, so any mismatch is visible for at most a
            // fraction of a second rather than up to
            // LIQUID_SNAPSHOT_INTERVAL_MS.
            const priorWidth = liquid.width;
            const priorHeight = liquid.height;
            if (!this._liquidResize(liquid)) {
                this._teardownLiquidLens();
                return;
            }
            liquid.snapshotMismatch = liquid.width !== priorWidth || liquid.height !== priorHeight;
        }).catch(() => {
            // A capture can occasionally fail (tainted canvas from a
            // cross-origin image, etc.) - keep the previous snapshot
            // rather than breaking the effect.
        }).finally(() => {
            if (!liquid || liquid.destroyed) return;
            const delay = liquid.snapshotMismatch ? 120 : LiquidLens.LIQUID_SNAPSHOT_INTERVAL_MS;
            liquid.snapshotMismatch = false;
            this._liquidScheduleSnapshot(delay);
        });
    }

    _liquidBindTarget(liquid, target) {
        const { gl } = liquid;
        if (target == null) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.viewport(0, 0, target.width, target.height);
        }
    }

    _liquidBlit(liquid, target) {
        this._liquidBindTarget(liquid, target);
        liquid.gl.drawElements(liquid.gl.TRIANGLES, 6, liquid.gl.UNSIGNED_SHORT, 0);
    }

    // Drives the whole effect every frame: turns pointer movement since
    // the last frame into a splat, steps the fluid simulation, then draws
    // the result over the real dashboard.
    _liquidTick() {
        const liquid = this._liquid;
        if (!liquid) return;

        if (liquid.pointer.moved) {
            liquid.pointer.moved = false;
            this._liquidSplat(liquid, liquid.pointer.x, liquid.pointer.y, liquid.pointer.dx, liquid.pointer.dy);
        }

        this._liquidSimulate(liquid);
        this._liquidDisplay(liquid);

        liquid.rafId = requestAnimationFrame(() => this._liquidTick());
    }

    // Splats a pointer-movement impulse into both the velocity field
    // (which way things should move) and the dye field (how strongly the
    // display pass should displace, independent of direction) - exactly
    // the reference's two-splat-per-move pattern.
    _liquidSplat(liquid, x, y, dx, dy) {
        const { gl, velocity, dye, programs } = liquid;
        const { splatProgram } = programs;
        const u = x / liquid.width;
        const v = 1 - y / liquid.height;

        gl.useProgram(splatProgram.program);
        gl.uniform1f(splatProgram.uniforms.u_ratio, velocity.width / velocity.height);
        gl.uniform2f(splatProgram.uniforms.u_point, u, v);
        gl.uniform1f(splatProgram.uniforms.u_point_size, LiquidLens.LIQUID_SPLAT_SIZE);

        gl.uniform1i(splatProgram.uniforms.u_input_texture, velocity.read().attach(0));
        gl.uniform3f(splatProgram.uniforms.u_point_value, dx, -dy, 0);
        this._liquidBlit(liquid, velocity.write());
        velocity.swap();

        gl.uniform1i(splatProgram.uniforms.u_input_texture, dye.read().attach(0));
        gl.uniform3f(splatProgram.uniforms.u_point_value, LiquidLens.LIQUID_SPLAT_DYE_POWER, 0, 0);
        this._liquidBlit(liquid, dye.write());
        dye.swap();
    }

    // The "stable fluids" solve, in order - this order matters:
    // projecting velocity to be divergence-free (divergence -> pressure
    // -> gradient subtract) has to happen *before* advecting anything
    // with it, or the field never develops the little vortices that read
    // as "liquid" rather than "smearing".
    _liquidSimulate(liquid) {
        const { gl, velocity, divergence, pressure, dye, programs, simTexel, dyeTexel } = liquid;
        const { divergenceProgram, pressureProgram, gradientSubtractProgram, advectionProgram } = programs;

        gl.useProgram(divergenceProgram.program);
        gl.uniform2f(divergenceProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform1i(divergenceProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
        this._liquidBlit(liquid, divergence);

        gl.useProgram(pressureProgram.program);
        gl.uniform2f(pressureProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform1i(pressureProgram.uniforms.u_divergence_texture, divergence.attach(1));
        for (let i = 0; i < LiquidLens.LIQUID_PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(pressureProgram.uniforms.u_pressure_texture, pressure.read().attach(0));
            this._liquidBlit(liquid, pressure.write());
            pressure.swap();
        }

        gl.useProgram(gradientSubtractProgram.program);
        gl.uniform2f(gradientSubtractProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform1i(gradientSubtractProgram.uniforms.u_pressure_texture, pressure.read().attach(0));
        gl.uniform1i(gradientSubtractProgram.uniforms.u_velocity_texture, velocity.read().attach(1));
        this._liquidBlit(liquid, velocity.write());
        velocity.swap();

        // Self-advect the (now divergence-free) velocity field - this is
        // what makes a disturbance curl and drift instead of just fading
        // in place.
        gl.useProgram(advectionProgram.program);
        gl.uniform2f(advectionProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform2f(advectionProgram.uniforms.u_output_textel, simTexel.x, simTexel.y);
        gl.uniform1i(advectionProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
        gl.uniform1i(advectionProgram.uniforms.u_input_texture, velocity.read().attach(0));
        gl.uniform1f(advectionProgram.uniforms.u_dt, LiquidLens.LIQUID_VELOCITY_DT);
        gl.uniform1f(advectionProgram.uniforms.u_dissipation, LiquidLens.LIQUID_VELOCITY_DISSIPATION);
        this._liquidBlit(liquid, velocity.write());
        velocity.swap();

        // Carry the dye field along by that same velocity - a slower,
        // bigger timestep (matching the reference) is what makes a
        // ripple linger and drift a little after the cursor has already
        // moved on, rather than snapping to a stop.
        gl.uniform2f(advectionProgram.uniforms.u_output_textel, dyeTexel.x, dyeTexel.y);
        gl.uniform1i(advectionProgram.uniforms.u_input_texture, dye.read().attach(1));
        gl.uniform1f(advectionProgram.uniforms.u_dt, LiquidLens.LIQUID_VELOCITY_DT * LiquidLens.LIQUID_DYE_DT_MULT);
        gl.uniform1f(advectionProgram.uniforms.u_dissipation, LiquidLens.LIQUID_DYE_DISSIPATION);
        this._liquidBlit(liquid, dye.write());
        dye.swap();
    }

    // Draws the final, displaced result over the real dashboard: fully
    // transparent wherever the dye field is at rest, fading in smoothly
    // wherever it isn't (see LIQUID_DISPLAY_SRC).
    _liquidDisplay(liquid) {
        const { gl, dye, velocity, textTexture, simTexel, dyeTexel, programs } = liquid;
        const { displayProgram } = programs;

        gl.useProgram(displayProgram.program);
        gl.uniform2f(displayProgram.uniforms.u_sim_texel, simTexel.x, simTexel.y);
        gl.uniform2f(displayProgram.uniforms.u_dye_texel, dyeTexel.x, dyeTexel.y);
        gl.uniform1f(displayProgram.uniforms.u_disturb_power, LiquidLens.LIQUID_DISTURB_POWER);
        gl.uniform1i(displayProgram.uniforms.u_output_texture, dye.read().attach(0));
        gl.uniform1i(displayProgram.uniforms.u_velocity_texture, velocity.read().attach(1));
        gl.activeTexture(gl.TEXTURE0 + 2);
        gl.bindTexture(gl.TEXTURE_2D, textTexture);
        gl.uniform1i(displayProgram.uniforms.u_text_texture, 2);

        this._liquidBindTarget(liquid, null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

}