//! Generation and Encode groups: resave (generation loss), reencode_profile, encode_like_photo.

use super::*;
use crate::pixels::{crop, resize, shift};

fn profile_options(with_keep: bool) -> Vec<(String, String)> {
    let mut v = Vec::new();
    if with_keep {
        v.push(("keep".to_string(), "Same as the photo".to_string()));
    }
    for i in profiles::infos() {
        v.push((i.id.to_string(), i.label.to_string()));
    }
    v
}

fn p_profile(id: &'static str, label: &'static str, with_keep: bool, def: &str) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Enum { options: profile_options(with_keep) }, default: Value::from(def), expert: false, hint: "" }
}

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "resave",
            "Save again and again",
            "Generation",
            Layer::Pixel,
            false,
            true,
            false,
            "Each save rounds the 8x8 blocks again. On its own that settles down quickly, but a tiny shift, crop or resize moves the grid, so every generation cuts new blocks and the damage piles up, like a meme forwarded forty times.",
            vec![
                p_int("generations", "Generations", 1, 100, 12),
                p_int("quality", "Quality", 1, 100, 75),
                p_int("quality_jitter", "Quality wobble", 0, 40, 5).hint("Random +/- change per save"),
                p_int("shift", "Shift (px)", 0, 8, 1).hint("Random nudge per save, moves the 8x8 grid"),
                p_int("crop", "Crop (px)", 0, 16, 0).expert().hint("Pixels trimmed off the top/left per save"),
                p_int("resize", "Resize (%)", 0, 25, 0).expert().hint("Random rescale per save"),
                p_enum("subsampling", "Colour resolution", &[("keep", "Keep"), ("random", "Random each save"), ("444", "4:4:4"), ("422", "4:2:2"), ("420", "4:2:0")], "keep").expert(),
                p_profile("profile", "Encoder", true, "keep").expert(),
            ],
        ),
        info(
            "reencode_profile",
            "Save like a camera or app",
            "Encode",
            Layer::Pixel,
            false,
            false,
            false,
            "The photo is shrunk to the size limit of that camera or app and saved with its own quantisation tables and colour subsampling, the same real settings it would use.",
            vec![p_profile("profile", "Camera or app", false, "whatsapp"), p_bool("keep_size", "Keep size", false).expert()],
        ),
        info(
            "encode_like_photo",
            "Save like another photo",
            "Encode",
            Layer::Pixel,
            true,
            false,
            true,
            "The tables and settings are copied from another photo's file, so this one is compressed exactly the way that camera did it.",
            vec![p_photo("photo", "Copy settings from")],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "resave" => resave(p, input, ctx),
        "reencode_profile" => reencode_profile(p, input),
        "encode_like_photo" => encode_like_photo(p, input, ctx),
        _ => return None,
    })
}

fn resave(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let gens = get_i64(p, "generations", 12).clamp(1, 200);
    let q = get_i64(p, "quality", 75).clamp(1, 100);
    let jit = get_i64(p, "quality_jitter", 5).clamp(0, 99);
    let sh = get_i64(p, "shift", 1).clamp(0, 64);
    let cr = get_i64(p, "crop", 0).clamp(0, 64) as usize;
    let rs = get_i64(p, "resize", 0).clamp(0, 50);
    let sub = get_str(p, "subsampling", "keep").to_string();
    let prof = get_str(p, "profile", "keep").to_string();
    let mut rng = ctx.rng();
    let (mut img, mut base) = px_in(input)?;
    let (ow, oh) = (img.w, img.h);
    let mut max_box = (0usize, 0usize);
    let profile = profiles::get(&prof);
    if let Some(pr) = &profile {
        base = pr.settings.clone();
        max_box = (pr.max_w, pr.max_h);
    }
    let mut out = input.to_vec();
    // Offsets jitter around the original position (so the picture doesn't wander off) but always
    // change between generations, so every save cuts a fresh 8x8 grid.
    let (mut ox, mut oy) = (0i64, 0i64);
    for _ in 0..gens {
        if sh > 0 {
            let (mut tx, mut ty) = (rng.range(-sh, sh), rng.range(-sh, sh));
            if tx == ox && ty == oy {
                tx = if ox < sh { ox + 1 } else { ox - 1 };
                ty = rng.range(-sh, sh);
            }
            img = shift(&img, tx - ox, ty - oy);
            ox = tx;
            oy = ty;
        }
        if cr > 0 {
            let (cx, cy) = (rng.range(0, cr as i64) as usize, rng.range(0, cr as i64) as usize);
            if img.w > cx + 16 && img.h > cy + 16 {
                img = crop(&img, cx, cy, img.w - cx, img.h - cy);
            }
        }
        if rs > 0 {
            let f = 100 + rng.range(-rs, rs);
            let (nw, nh) = ((ow as i64 * f / 100).max(8) as usize, (oh as i64 * f / 100).max(8) as usize);
            img = resize(&img, nw, nh);
        }
        if max_box.0 > 0 {
            let (bw, bh) = if (img.w >= img.h) == (max_box.0 >= max_box.1) { max_box } else { (max_box.1, max_box.0) };
            let (tw, th) = crate::pixels::fit_dims(img.w, img.h, bw, bh);
            if (tw, th) != (img.w, img.h) {
                img = resize(&img, tw, th);
            }
        }
        let gq = (q + if jit > 0 { rng.range(-jit, jit) } else { 0 }).clamp(1, 100);
        let mut s = match &profile {
            Some(pr) => pr.settings_at(gq as i32),
            None => {
                let mut s = base.clone();
                s.set_quality(gq as i32);
                s
            }
        };
        match sub.as_str() {
            "keep" => {}
            "random" => {
                let opts = ["444", "422", "420"];
                s.set_subsampling(opts[rng.below(3) as usize]);
            }
            other => s.set_subsampling(other),
        }
        out = px_out(&img, &s);
        let d = render::decode(&out, &render::DecodeOpts::default()).map_err(|_| unreadable())?;
        img = Rgba { w: d.width, h: d.height, px: d.rgba };
    }
    Ok(out)
}

pub(crate) fn encode_profile(img: &Rgba, id: &str, keep_size: bool) -> Result<Vec<u8>, String> {
    let pr = profiles::get(id).ok_or_else(|| format!("unknown profile {id}"))?;
    let (tw, th) = if keep_size { (img.w, img.h) } else { pr.target_dims(img.w, img.h) };
    let img = if (tw, th) != (img.w, img.h) { resize(img, tw, th) } else { img.clone() };
    Ok(px_out(&img, &pr.settings))
}

fn reencode_profile(p: &Value, input: &[u8]) -> StepResult {
    let (img, _) = px_in(input)?;
    encode_profile(&img, get_str(p, "profile", "whatsapp"), get_bool(p, "keep_size", false))
}

fn encode_like_photo(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let donor = pick_photo(p, "photo", ctx)?;
    let s = encoder::EncodeSettings::like(donor).ok_or("the other photo's settings can't be read")?;
    let (img, _) = px_in(input)?;
    Ok(px_out(&img, &s))
}
