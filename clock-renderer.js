// Shared clock renderer.
//
// Used by three surfaces so they always look identical:
//   • main.js      – node-canvas, static (native) wallpaper
//   • live.html    – browser canvas over the video wallpaper
//   • settings.html – the live preview
//
// Everything here works with any CanvasRenderingContext2D-compatible context.

const DEFAULTS = Object.freeze({
    clockEnabled:   true,
    clockStyle:     "digital",      // "digital" | "analog"
    clockAnchor:    "middle-center",
    clockOffsetX:   0,
    clockOffsetY:   0,

    hour12:         true,
    showSeconds:    false,

    // Digital
    dayFont:    "Anurati",  daySize:  110, daySpacing: 10, dayY:  -270,
    dateFont:   "Rajdhani", dateSize: 45,                  dateY: -170,
    timeFont:   "Rajdhani", timeSize: 50,                  timeY: -80,
    timePrefix: "- ",
    timeSuffix: " -",

    // Analog
    analogSize:     170,            // dial radius in px
    analogFace:     "ring",         // "ring" | "glass" | "none"
    analogMarkers:  "ticks",        // "ticks" | "numbers" | "dots" | "minimal"
    analogShowDate: true,

    // Look
    fontColor:     "#ffffff",
    accentColor:   "#ff4d4d",
    shadowEnabled: true,
    shadowColor:   "#000000",
    shadowBlur:    40,
});

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getClockText(now, config) {
    const day  = now.toLocaleDateString("en-US", { weekday: "long" });
    const date = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const opts = { hour: "2-digit", minute: "2-digit", hour12: config.hour12 !== false };
    if (config.showSeconds === true) opts.second = "2-digit";
    return { day, date, time: now.toLocaleTimeString("en-US", opts) };
}

function parseAnchor(config) {
    const [v = "middle", h = "center"] = String(config.clockAnchor || DEFAULTS.clockAnchor).split("-");
    return { v, h };
}

// Anchor point for the digital layout (relative to the region's origin).
function getClockBase(config, width, height) {
    const { v, h } = parseAnchor(config);
    const offsetX  = num(config.clockOffsetX, 0);
    const offsetY  = num(config.clockOffsetY, 0);
    let baseX, baseY, textAlign;
    if (h === "left")       { baseX = Math.round(width * 0.08) + offsetX; textAlign = "left"; }
    else if (h === "right") { baseX = Math.round(width * 0.92) + offsetX; textAlign = "right"; }
    else                    { baseX = Math.round(width / 2)    + offsetX; textAlign = "center"; }
    if (v === "top")         baseY = Math.round(height * 0.15) + offsetY;
    else if (v === "bottom") baseY = Math.round(height * 0.82) + offsetY;
    else                     baseY = Math.round(height / 2)    + offsetY;
    return { baseX, baseY, textAlign };
}

function applyShadow(ctx, config) {
    if (config.shadowEnabled !== false) {
        ctx.shadowBlur  = num(config.shadowBlur, DEFAULTS.shadowBlur);
        ctx.shadowColor = config.shadowColor || DEFAULTS.shadowColor;
    } else {
        ctx.shadowBlur  = 0;
        ctx.shadowColor = "transparent";
    }
}

function font(size, family) {
    return `${size}px "${family}"`;
}

// ── Text engines ────────────────────────────────────────────────────────────
// All text goes through a small engine so the same layout code can use the
// browser's native text (renderers, where fonts come from FontFace) or glyph
// outlines read straight from the TTF files (node-canvas in the main process,
// whose Windows build can't see privately registered fonts).

function nativeTextEngine(ctx) {
    return {
        font(size, family) { ctx.font = font(size, family); },
        measure(str)       { return ctx.measureText(str).width; },
        fill(str, x, y)    { ctx.fillText(str, x, y); },
    };
}

// getFont(family) → opentype.js Font or null (falls back to native text).
function createOutlineTextEngine(getFont) {
    return ctx => {
        const native = nativeTextEngine(ctx);
        let current = null, size = 0;
        return {
            font(sz, family) {
                size    = sz;
                current = getFont(family);
                native.font(sz, family);
            },
            measure(str) {
                return current ? current.getAdvanceWidth(str, size) : native.measure(str);
            },
            fill(str, x, y) {
                if (!current) { native.fill(str, x, y); return; }
                const w = current.getAdvanceWidth(str, size);
                if (ctx.textAlign === "center")                               x -= w / 2;
                else if (ctx.textAlign === "right" || ctx.textAlign === "end") x -= w;
                if (ctx.textBaseline === "middle") {
                    const capHeight = current.tables.os2?.sCapHeight || current.unitsPerEm * 0.7;
                    y += (capHeight / current.unitsPerEm) * size / 2;
                }
                const path = current.getPath(str, x, y, size);
                ctx.beginPath();
                for (const c of path.commands) {
                    if (c.type === "M")      ctx.moveTo(c.x, c.y);
                    else if (c.type === "L") ctx.lineTo(c.x, c.y);
                    else if (c.type === "C") ctx.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
                    else if (c.type === "Q") ctx.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
                    else if (c.type === "Z") ctx.closePath();
                }
                ctx.fill();
            },
        };
    };
}

let T = null;   // active engine for the current drawClock call

// Text with manual letter spacing (canvas letterSpacing isn't available in
// node-canvas). Returns the drawn width.
function measureSpaced(ctx, text, spacing) {
    let w = 0;
    for (const ch of text) w += T.measure(ch);
    return w + spacing * Math.max(0, [...text].length - 1);
}

function fillSpaced(ctx, text, x, y, spacing) {
    for (const ch of text) {
        T.fill(ch, x, y);
        x += T.measure(ch) + spacing;
    }
}

// ── Digital ─────────────────────────────────────────────────────────────────
function drawDigital(ctx, config, ox, oy, W, H, text) {
    const { baseX, baseY, textAlign } = getClockBase(config, W, H);
    const absX = ox + baseX;
    const absY = oy + baseY;

    ctx.textAlign = "left";
    const dayText = text.day.toUpperCase();
    const spacing = num(config.daySpacing, DEFAULTS.daySpacing);
    T.font(num(config.daySize, DEFAULTS.daySize), config.dayFont || DEFAULTS.dayFont);
    const dayWidth = measureSpaced(ctx, dayText, spacing);

    let startX;
    if (textAlign === "left")       startX = absX;
    else if (textAlign === "right") startX = absX - dayWidth;
    else                            startX = absX - dayWidth / 2;

    fillSpaced(ctx, dayText, startX, absY + num(config.dayY, DEFAULTS.dayY), spacing);

    const centerX = startX + dayWidth / 2;
    ctx.textAlign = "center";

    T.font(num(config.dateSize, DEFAULTS.dateSize), config.dateFont || DEFAULTS.dateFont);
    T.fill(text.date, centerX, absY + num(config.dateY, DEFAULTS.dateY));

    T.font(num(config.timeSize, DEFAULTS.timeSize), config.timeFont || DEFAULTS.timeFont);
    T.fill(
        (config.timePrefix ?? DEFAULTS.timePrefix) + text.time + (config.timeSuffix ?? DEFAULTS.timeSuffix),
        centerX,
        absY + num(config.timeY, DEFAULTS.timeY)
    );
}

// ── Analog ──────────────────────────────────────────────────────────────────
function getAnalogCenter(config, W, H, r, belowHeight) {
    const { v, h } = parseAnchor(config);
    const margin = Math.round(Math.min(W, H) * 0.06);
    let cx, cy;
    if (h === "left")       cx = margin + r;
    else if (h === "right") cx = W - margin - r;
    else                    cx = W / 2;
    if (v === "top")         cy = margin + r;
    else if (v === "bottom") cy = H - margin - r - belowHeight;
    else                     cy = H / 2 - belowHeight / 2;
    return {
        cx: cx + num(config.clockOffsetX, 0),
        cy: cy + num(config.clockOffsetY, 0),
    };
}

function drawHand(ctx, cx, cy, angle, length, width, tail, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.strokeStyle = color;
    ctx.lineWidth   = width;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(0, tail);
    ctx.lineTo(0, -length);
    ctx.stroke();
    ctx.restore();
}

function drawAnalog(ctx, config, ox, oy, W, H, now, text) {
    const r       = Math.max(20, num(config.analogSize, DEFAULTS.analogSize));
    const color   = config.fontColor   || DEFAULTS.fontColor;
    const accent  = config.accentColor || DEFAULTS.accentColor;
    const markers = config.analogMarkers || DEFAULTS.analogMarkers;
    const face    = config.analogFace    || DEFAULTS.analogFace;
    const showDate = config.analogShowDate !== false;

    const dateSize    = Math.max(10, Math.round(r * 0.2));
    const belowHeight = showDate ? Math.round(r * 0.35 + dateSize * 1.2) : 0;
    const c  = getAnalogCenter(config, W, H, r, belowHeight);
    const cx = ox + c.cx;
    const cy = oy + c.cy;
    const unit = r / 100;   // stroke widths scale with the dial

    // Face
    if (face !== "none") {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        if (face === "glass") {
            ctx.shadowColor = "transparent";
            ctx.fillStyle   = "rgba(0, 0, 0, 0.28)";
            ctx.fill();
        }
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = face === "glass" ? 0.55 : 0.9;
        ctx.lineWidth   = Math.max(1.5, 2.2 * unit);
        ctx.stroke();
        ctx.restore();
    }

    // Markers
    ctx.save();
    ctx.fillStyle   = color;
    ctx.strokeStyle = color;
    ctx.lineCap     = "round";
    if (markers === "numbers") {
        T.font(Math.round(r * 0.2), config.dateFont || DEFAULTS.dateFont);
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        for (let i = 1; i <= 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            T.fill(String(i), cx + Math.sin(a) * r * 0.78, cy - Math.cos(a) * r * 0.78);
        }
    } else {
        const count = markers === "ticks" ? 60 : 12;
        for (let i = 0; i < count; i++) {
            const isHour = markers === "ticks" ? i % 5 === 0 : true;
            if (markers === "minimal" && i % 3 !== 0) continue;
            const a = (i / count) * Math.PI * 2;
            const sx = Math.sin(a), sy = -Math.cos(a);
            if (markers === "dots") {
                ctx.beginPath();
                ctx.arc(cx + sx * r * 0.86, cy + sy * r * 0.86, (i % 3 === 0 ? 4 : 2.4) * unit, 0, Math.PI * 2);
                ctx.fill();
            } else {
                const outer = r * 0.92;
                const inner = r * (isHour ? (markers === "minimal" ? 0.76 : 0.8) : 0.87);
                ctx.globalAlpha = isHour ? 1 : 0.55;
                ctx.lineWidth   = (isHour ? 3.2 : 1.4) * unit;
                ctx.beginPath();
                ctx.moveTo(cx + sx * inner, cy + sy * inner);
                ctx.lineTo(cx + sx * outer, cy + sy * outer);
                ctx.stroke();
            }
        }
    }
    ctx.restore();

    // Hands
    const showSeconds = config.showSeconds === true;
    const s = now.getSeconds();
    const m = now.getMinutes() + (showSeconds ? s / 60 : 0);
    const h = (now.getHours() % 12) + m / 60;
    const TAU = Math.PI * 2;

    drawHand(ctx, cx, cy, (h / 12) * TAU, r * 0.5,  6 * unit,   r * 0.08, color);
    // Keep hands inside the number ring when numerals are shown.
    const withNumbers = markers === "numbers";
    drawHand(ctx, cx, cy, (m / 60) * TAU, r * (withNumbers ? 0.6 : 0.76), 3.6 * unit, r * 0.1, color);
    if (showSeconds) drawHand(ctx, cx, cy, (s / 60) * TAU, r * (withNumbers ? 0.66 : 0.86), 1.6 * unit, r * 0.18, accent);

    ctx.save();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 5 * unit, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Day · date under the dial
    if (showDate) {
        ctx.save();
        ctx.fillStyle    = color;
        ctx.textBaseline = "alphabetic";
        const y = cy + r + r * 0.35 + dateSize;
        T.font(dateSize, config.dateFont || DEFAULTS.dateFont);
        const label = `${text.day.toUpperCase()}  ·  ${text.date}`;
        // Line up with the dial's outer edge when anchored to a side so the
        // (usually wider) date line never runs off the screen.
        const { h: hAnchor } = parseAnchor(config);
        const labelWidth = T.measure(label);
        if (hAnchor === "right" && labelWidth > 2 * r)     { ctx.textAlign = "right"; T.fill(label, cx + r, y); }
        else if (hAnchor === "left" && labelWidth > 2 * r) { ctx.textAlign = "left";  T.fill(label, cx - r, y); }
        else                                               { ctx.textAlign = "center"; T.fill(label, cx, y); }
        ctx.restore();
    }
}

// ── Public entry point ──────────────────────────────────────────────────────
// region: { x, y, width, height } in the context's coordinate space.
// textEngine: optional factory from createOutlineTextEngine().
function drawClock(ctx, config, region, now = new Date(), textEngine = null) {
    if (!config || config.clockEnabled === false) return;
    const { x, y, width, height } = region;
    const text = getClockText(now, config);
    T = textEngine ? textEngine(ctx) : nativeTextEngine(ctx);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    ctx.fillStyle    = config.fontColor || DEFAULTS.fontColor;
    ctx.textBaseline = "alphabetic";
    applyShadow(ctx, config);

    if (config.clockStyle === "analog") drawAnalog(ctx, config, x, y, width, height, now, text);
    else                                drawDigital(ctx, config, x, y, width, height, text);

    ctx.restore();
}

// Milliseconds until the drawn clock would next change.
function msUntilNextTick(config, now = new Date()) {
    if (config.showSeconds === true) return 1000 - now.getMilliseconds() + 20;
    return (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
}

module.exports = { DEFAULTS, drawClock, getClockText, msUntilNextTick, createOutlineTextEngine };
