//! Colour group: color_matrix, channel_drop, icc_loss.

use super::*;
use crate::coeffs::ColorSpace;
use crate::color::Matrix;
use crate::markers::{segment, APP0, APP14, APP2};
use crate::sample::Plane8;

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "color_matrix",
            "Colour conversion mix-up",
            "Colour",
            Layer::Pixel,
            false,
            false,
            false,
            "JPEG stores brightness and two colour-difference channels, not red, green and blue. If the maths or the label for that conversion is wrong, every colour shifts at once: skin goes green, skies go pink.",
            vec![p_enum(
                "mode",
                "What goes wrong",
                &[
                    ("bt709_mismatch", "HD (BT.709) maths, read as BT.601"),
                    ("rgb_as_ycc", "RGB stored as if it were YCbCr"),
                    ("ycc_as_rgb", "YCbCr shown as RGB"),
                    ("adobe_flag_flip", "Flip Adobe colour-transform flag"),
                ],
                "ycc_as_rgb",
            )],
        ),
        info(
            "channel_drop",
            "Drop a channel",
            "Colour",
            Layer::Coeff,
            false,
            false,
            false,
            "One of the three stored channels loses its data. Lose a colour channel and the picture swings to one tint; lose brightness and only flat colour patches are left.",
            vec![
                p_enum("component", "Channel", COMPONENTS, "1"),
                p_enum("mode", "Mode", &[("zero", "Empty it"), ("flat", "Keep only block averages"), ("negate", "Invert it")], "zero"),
            ],
        ),
        info(
            "icc_loss",
            "Lost colour profile",
            "Colour",
            Layer::Pixel,
            true,
            false,
            false,
            "Wide-gamut photos need their ICC colour profile to be shown right. Without it the numbers are read as ordinary sRGB, so everything looks washed out and dull.",
            vec![p_enum(
                "mode",
                "Photo was",
                &[("adobe_rgb", "Adobe RGB (shown as sRGB)"), ("p3", "Display P3 (shown as sRGB)"), ("strip", "Just remove the ICC profile")],
                "adobe_rgb",
            )],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], _ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "color_matrix" => color_matrix(p, input),
        "channel_drop" => channel_drop(p, input),
        "icc_loss" => icc_loss(p, input),
        _ => return None,
    })
}

/// Remove APP segments matching a predicate (before the first SOS).
pub(crate) fn drop_segments(input: &[u8], pred: impl Fn(u8, &[u8]) -> bool) -> Vec<u8> {
    let l = walk(input);
    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0;
    for s in &l.segments {
        if s.marker == 0xDA {
            break;
        }
        if pred(s.marker, s.payload(input)) {
            out.extend_from_slice(&input[pos..s.offset]);
            pos = s.offset + s.length;
        }
    }
    out.extend_from_slice(&input[pos..]);
    out
}

/// Insert a segment right after SOI.
pub(crate) fn insert_after_soi(input: &[u8], seg: Vec<u8>) -> Vec<u8> {
    let at = if input.starts_with(&[0xFF, 0xD8]) { 2 } else { 0 };
    let mut out = input[..at].to_vec();
    out.extend(seg);
    out.extend_from_slice(&input[at..]);
    out
}

fn set_adobe(input: &[u8], transform: Option<u8>) -> Vec<u8> {
    let l = walk(input);
    let existing = l.segments.iter().find(|s| s.marker == APP14 && s.payload(input).starts_with(b"Adobe"));
    let current = existing.and_then(|s| s.payload(input).get(11).copied());
    let ncomp = l.sof().and_then(|s| s.payload(input).get(5).copied()).unwrap_or(3);
    let t = transform.unwrap_or(match (ncomp, current) {
        (4, Some(2)) => 0,
        (4, _) => 2,
        (_, Some(0)) => 1,
        _ => 0,
    });
    // JFIF overrides the Adobe flag in libjpeg, so it has to go.
    let base = drop_segments(input, |m, p| (m == APP14 && p.starts_with(b"Adobe")) || (m == APP0 && p.starts_with(b"JFIF")));
    insert_after_soi(&base, segment(APP14, &[b'A', b'd', b'o', b'b', b'e', 0, 100, 0, 0, 0, 0, t]))
}

fn color_matrix(p: &Value, input: &[u8]) -> StepResult {
    match get_str(p, "mode", "ycc_as_rgb") {
        "ycc_as_rgb" => Ok(set_adobe(input, Some(0))),
        "adobe_flag_flip" => Ok(set_adobe(input, None)),
        mode => {
            let (img, s) = px_in(input)?;
            let rgb_raw = mode == "rgb_as_ycc";
            let mut planes = vec![Plane8::new(img.w, img.h, 0), Plane8::new(img.w, img.h, 0), Plane8::new(img.w, img.h, 0)];
            for i in 0..img.w * img.h {
                let (r, g, b) = (img.px[i * 4], img.px[i * 4 + 1], img.px[i * 4 + 2]);
                let (y, cb, cr) = if rgb_raw { (r, g, b) } else { crate::color::rgb_to_ycc(r, g, b, Matrix::Bt709) };
                planes[0].data[i] = y;
                planes[1].data[i] = cb;
                planes[2].data[i] = cr;
            }
            let mut s = s;
            if s.color != ColorSpace::YCbCr {
                s = profiles::get(profiles::DEFAULT_PROFILE).unwrap().settings;
            }
            Ok(encoder::encode_planes(&planes, img.w, img.h, &s))
        }
    }
}

fn channel_drop(p: &Value, input: &[u8]) -> StepResult {
    let (mut img, s) = co_in(input)?;
    let ci = component(p, "component", 1);
    let Some(c) = img.comps.get_mut(ci) else { return Err("this image has no such channel".into()) };
    match get_str(p, "mode", "zero") {
        "flat" => c.coef.chunks_mut(64).for_each(|b| b[1..].fill(0)),
        "negate" => c.coef.iter_mut().for_each(|v| *v = v.saturating_neg()),
        _ => c.coef.fill(0),
    }
    Ok(co_out(&img, &s))
}

fn icc_loss(p: &Value, input: &[u8]) -> StepResult {
    let mode = get_str(p, "mode", "adobe_rgb");
    let stripped = drop_segments(input, |m, d| m == APP2 && d.starts_with(b"ICC_PROFILE\0"));
    if mode == "strip" {
        return Ok(stripped);
    }
    let (mut img, s) = px_in(&stripped)?;
    // sRGB -> wide-gamut linear matrices (D65).
    let (m, gamma): ([[f64; 3]; 3], Option<f64>) = if mode == "p3" {
        ([[0.8225, 0.1774, 0.0], [0.0332, 0.9669, 0.0], [0.0171, 0.0724, 0.9108]], None)
    } else {
        ([[0.7152, 0.2848, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0412, 0.9588]], Some(563.0 / 256.0))
    };
    let lin: Vec<f64> = (0..256)
        .map(|i| {
            let c = i as f64 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect();
    let enc = |v: f64| -> u8 {
        let v = v.clamp(0.0, 1.0);
        let e = match gamma {
            Some(g) => v.powf(1.0 / g),
            None => {
                if v <= 0.0031308 {
                    v * 12.92
                } else {
                    1.055 * v.powf(1.0 / 2.4) - 0.055
                }
            }
        };
        (e * 255.0 + 0.5) as u8
    };
    for px in img.px.chunks_mut(4) {
        let (r, g, b) = (lin[px[0] as usize], lin[px[1] as usize], lin[px[2] as usize]);
        px[0] = enc(m[0][0] * r + m[0][1] * g + m[0][2] * b);
        px[1] = enc(m[1][0] * r + m[1][1] * g + m[1][2] * b);
        px[2] = enc(m[2][0] * r + m[2][1] * g + m[2][2] * b);
    }
    Ok(px_out(&img, &s))
}
