//! Chroma group: chroma_subsample (subsampling mode, upsampling method, plane offset, passes).

use super::*;
use crate::coeffs::ColorSpace;
use crate::color::{rgb_to_ycc, Matrix};
use crate::sample::Plane8;

pub fn infos() -> Vec<StepInfo> {
    vec![info(
        "chroma_subsample",
        "Colour resolution (subsampling)",
        "Chroma",
        Layer::Pixel,
        false,
        false,
        false,
        "JPEG keeps colour at lower resolution than brightness, because eyes barely notice. Do it harshly, or several times, and colours bleed over edges and red text gets fuzzy halos.",
        vec![
            p_enum("mode", "Subsampling", &[("444", "4:4:4 (full colour)"), ("422", "4:2:2"), ("420", "4:2:0"), ("411", "4:1:1"), ("440", "4:4:0")], "411"),
            p_enum("upsampling", "Decoder upsampling", &[("fancy", "Smooth (fancy)"), ("nearest", "Blocky (nearest)")], "fancy"),
            p_int("shift_x", "Colour shift X", -16, 16, 0).hint("Pixels the colour planes slide out of line"),
            p_int("shift_y", "Colour shift Y", -16, 16, 0),
            p_int("passes", "Passes", 1, 20, 3).hint("Each pass decodes and re-encodes, so bleeding builds up"),
        ],
    )]
}

pub fn apply(id: &str, p: &Value, input: &[u8], _ctx: &StepCtx) -> Option<StepResult> {
    match id {
        "chroma_subsample" => Some(chroma_subsample(p, input)),
        _ => None,
    }
}

fn shift_plane(p: &Plane8, dx: i64, dy: i64) -> Plane8 {
    if dx == 0 && dy == 0 {
        return p.clone();
    }
    let mut o = Plane8::new(p.w, p.h, 0);
    for y in 0..p.h {
        let sy = (y as i64 - dy).clamp(0, p.h as i64 - 1) as usize;
        for x in 0..p.w {
            let sx = (x as i64 - dx).clamp(0, p.w as i64 - 1) as usize;
            o.data[y * p.w + x] = p.data[sy * p.w + sx];
        }
    }
    o
}

fn chroma_subsample(p: &Value, input: &[u8]) -> StepResult {
    let mode = get_str(p, "mode", "411").to_string();
    let fancy = get_str(p, "upsampling", "fancy") != "nearest";
    let dx = get_i64(p, "shift_x", 0).clamp(-64, 64);
    let dy = get_i64(p, "shift_y", 0).clamp(-64, 64);
    let passes = get_i64(p, "passes", 3).clamp(1, 50);
    let mut s = settings_of(input);
    if s.color != ColorSpace::YCbCr {
        s = profiles::get(profiles::DEFAULT_PROFILE).unwrap().settings;
    }
    s.set_subsampling(&mode);
    let mut cur = input.to_vec();
    for _ in 0..passes {
        let parsed = crate::decoder::parse(&cur, false);
        let Some(img) = parsed.img.as_ref() else { return Err(unreadable()) };
        let opts = render::DecodeOpts { fancy, ..Default::default() };
        let planes = render::render_planes(img, &parsed, &opts);
        let (w, h) = (planes.width, planes.height);
        let mut ycc = if planes.color == ColorSpace::YCbCr && planes.planes.len() == 3 {
            planes.planes
        } else {
            let rgba = render::planes_to_rgba(&planes);
            let mut v = vec![Plane8::new(w, h, 0), Plane8::new(w, h, 0), Plane8::new(w, h, 0)];
            for i in 0..w * h {
                let (y, cb, cr) = rgb_to_ycc(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], Matrix::Bt601);
                v[0].data[i] = y;
                v[1].data[i] = cb;
                v[2].data[i] = cr;
            }
            v
        };
        ycc[1] = shift_plane(&ycc[1], dx, dy);
        ycc[2] = shift_plane(&ycc[2], dx, dy);
        cur = encoder::encode_planes(&ycc, w, h, &s);
    }
    Ok(cur)
}
