//! Sensor group (simulated, pixel level): sensor_noise, oversharpen, purple_fringe, date_stamp.

use super::*;

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "sensor_noise",
            "Sensor noise",
            "Sensor",
            Layer::Pixel,
            false,
            true,
            false,
            "Simulated: small camera sensors in dim light add grain to brightness and blotchy colour speckles. The JPEG encoder then has to spend bits on the noise, which turns into extra block mush.",
            vec![p_float("amount", "Amount", 0.0, 1.0, 0.05, 0.3)],
        ),
        info(
            "oversharpen",
            "In-camera oversharpening",
            "Sensor",
            Layer::Pixel,
            false,
            false,
            false,
            "Simulated: cheap cameras sharpened every photo hard, drawing bright and dark halos along edges. JPEG compression then makes the halos ring.",
            vec![p_float("amount", "Amount", 0.0, 1.0, 0.05, 0.5)],
        ),
        info(
            "purple_fringe",
            "Purple fringing",
            "Sensor",
            Layer::Pixel,
            true,
            false,
            false,
            "Simulated: cheap lenses can't focus all colours at once, so dark edges against bright sky get a purple rim. It sits in colour detail, which JPEG blurs even further.",
            vec![p_float("amount", "Amount", 0.0, 1.0, 0.05, 0.6)],
        ),
        info(
            "date_stamp",
            "Orange date stamp",
            "Sensor",
            Layer::Pixel,
            false,
            false,
            false,
            "Simulated: the camera burns the date into the corner in orange seven-segment digits. Saved as JPEG, the sharp orange edges get colour smears around them.",
            vec![
                p_text("text", "Text", "'04 7 15"),
                p_enum("corner", "Corner", &[("br", "Bottom right"), ("bl", "Bottom left"), ("tr", "Top right"), ("tl", "Top left")], "br"),
            ],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    let f: fn(&Value, &mut Rgba, &StepCtx) = match id {
        "sensor_noise" => noise,
        "oversharpen" => sharpen,
        "purple_fringe" => fringe,
        "date_stamp" => stamp,
        _ => return None,
    };
    Some(px_in(input).map(|(mut img, s)| {
        f(p, &mut img, ctx);
        px_out(&img, &s)
    }))
}

fn gauss(rng: &mut Pcg32) -> f64 {
    (rng.unit() + rng.unit() + rng.unit() + rng.unit() - 2.0) * 1.732
}

fn noise(p: &Value, img: &mut Rgba, ctx: &StepCtx) {
    let a = get_f64(p, "amount", 0.3).clamp(0.0, 1.0);
    let mut rng = ctx.rng();
    let (cw, ch) = (img.w.div_ceil(3), img.h.div_ceil(3));
    let chroma: Vec<(f64, f64)> = (0..cw * ch).map(|_| (gauss(&mut rng) * a * 14.0, gauss(&mut rng) * a * 14.0)).collect();
    for y in 0..img.h {
        for x in 0..img.w {
            let l = gauss(&mut rng) * a * 18.0;
            let (u, v) = chroma[(y / 3) * cw + x / 3];
            let i = (y * img.w + x) * 4;
            let add = [l + v, l - 0.4 * u - 0.4 * v, l + u];
            for c in 0..3 {
                img.px[i + c] = (img.px[i + c] as f64 + add[c]).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

fn sharpen(p: &Value, img: &mut Rgba, _ctx: &StepCtx) {
    let k = get_f64(p, "amount", 0.5).clamp(0.0, 1.0) * 3.0;
    let src = img.clone();
    for y in 0..img.h {
        for x in 0..img.w {
            let mut s = [0i32; 3];
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let q = src.at(x as i64 + dx, y as i64 + dy);
                    for c in 0..3 {
                        s[c] += q[c] as i32;
                    }
                }
            }
            let o = src.get(x, y);
            let mut px = [0u8; 3];
            for c in 0..3 {
                let blur = s[c] as f64 / 9.0;
                px[c] = (o[c] as f64 + k * (o[c] as f64 - blur)).round().clamp(0.0, 255.0) as u8;
            }
            img.set(x, y, px);
        }
    }
}

fn fringe(p: &Value, img: &mut Rgba, _ctx: &StepCtx) {
    let a = get_f64(p, "amount", 0.6).clamp(0.0, 1.0);
    let src = img.clone();
    let lum = |q: [u8; 4]| (q[0] as i32 * 77 + q[1] as i32 * 150 + q[2] as i32 * 29) >> 8;
    for y in 0..img.h {
        for x in 0..img.w {
            let me = lum(src.get(x, y));
            if me > 170 {
                continue;
            }
            let mut bright = 0;
            for dy in -2i64..=2 {
                for dx in -2i64..=2 {
                    bright = bright.max(lum(src.at(x as i64 + dx, y as i64 + dy)));
                }
            }
            let edge = (bright - me - 60).max(0) as f64 / 120.0;
            if bright < 200 || edge <= 0.0 {
                continue;
            }
            let w = (edge.min(1.0) * a).min(1.0);
            let o = src.get(x, y);
            img.set(
                x,
                y,
                [
                    (o[0] as f64 + w * 70.0).min(255.0) as u8,
                    (o[1] as f64 - w * 30.0).max(0.0) as u8,
                    (o[2] as f64 + w * 110.0).min(255.0) as u8,
                ],
            );
        }
    }
}

/// Seven-segment glyphs: bits a b c d e f g (top, top-right, bottom-right, bottom, bottom-left, top-left, middle).
fn segments(c: char) -> u8 {
    match c {
        '0' => 0b1111110,
        '1' => 0b0110000,
        '2' => 0b1101101,
        '3' => 0b1111001,
        '4' => 0b0110011,
        '5' => 0b1011011,
        '6' => 0b1011111,
        '7' => 0b1110000,
        '8' => 0b1111111,
        '9' => 0b1111011,
        '-' => 0b0000001,
        _ => 0,
    }
}

fn stamp(p: &Value, img: &mut Rgba, _ctx: &StepCtx) {
    let text: String = get_str(p, "text", "'04 7 15").chars().take(32).collect();
    let corner = get_str(p, "corner", "br");
    let gh = (img.h.min(img.w) / 18).max(9);
    let gw = gh * 6 / 10;
    let t = (gh / 7).max(1);
    let gap = gw / 3;
    let adv = |c: char| if c == '\'' || c == '.' || c == ':' { gw / 2 } else { gw + gap };
    let total: usize = text.chars().map(adv).sum();
    let margin = gh;
    let x0 = if corner.ends_with('l') { margin } else { img.w.saturating_sub(total + margin) };
    let y0 = if corner.starts_with('t') { margin } else { img.h.saturating_sub(gh + margin) };
    let mut mask = vec![0u8; total.max(1) * gh];
    let mw = total.max(1);
    let rect = |m: &mut Vec<u8>, x: usize, y: usize, w: usize, h: usize| {
        for yy in y..(y + h).min(gh) {
            for xx in x..(x + w).min(mw) {
                m[yy * mw + xx] = 1;
            }
        }
    };
    let mut cx = 0;
    for c in text.chars() {
        let s = segments(c);
        let half = gh / 2;
        if s & 0b1000000 != 0 {
            rect(&mut mask, cx + t, 0, gw - 2 * t, t);
        }
        if s & 0b0100000 != 0 {
            rect(&mut mask, cx + gw - t, t, t, half - t);
        }
        if s & 0b0010000 != 0 {
            rect(&mut mask, cx + gw - t, half, t, half - t);
        }
        if s & 0b0001000 != 0 {
            rect(&mut mask, cx + t, gh - t, gw - 2 * t, t);
        }
        if s & 0b0000100 != 0 {
            rect(&mut mask, cx, half, t, half - t);
        }
        if s & 0b0000010 != 0 {
            rect(&mut mask, cx, t, t, half - t);
        }
        if s & 0b0000001 != 0 {
            rect(&mut mask, cx + t, half - t / 2, gw - 2 * t, t);
        }
        match c {
            '\'' => rect(&mut mask, cx, 0, t, gh / 4),
            '.' => rect(&mut mask, cx, gh - t, t, t),
            ':' => {
                rect(&mut mask, cx, gh / 3, t, t);
                rect(&mut mask, cx, gh * 2 / 3, t, t);
            }
            _ => {}
        }
        cx += adv(c);
    }
    let orange = [255.0, 138.0, 28.0];
    for my in 0..gh {
        for mx in 0..mw {
            let (x, y) = (x0 + mx, y0 + my);
            if x >= img.w || y >= img.h {
                continue;
            }
            let on = mask[my * mw + mx] == 1;
            let near = !on && (mx > 0 && mask[my * mw + mx - 1] == 1 || mx + 1 < mw && mask[my * mw + mx + 1] == 1 || my > 0 && mask[(my - 1) * mw + mx] == 1 || my + 1 < gh && mask[(my + 1) * mw + mx] == 1);
            let w = if on { 0.92 } else if near { 0.35 } else { 0.0 };
            if w > 0.0 {
                let o = img.get(x, y);
                let mut px = [0u8; 3];
                for c in 0..3 {
                    px[c] = (o[c] as f64 * (1.0 - w) + orange[c] * w).round() as u8;
                }
                img.set(x, y, px);
            }
        }
    }
}
