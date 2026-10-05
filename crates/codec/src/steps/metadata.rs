//! Metadata group: exif_orientation, exif_thumb_mismatch, exif_corrupt, strip_exif.

use super::*;
use crate::exif;
use crate::markers::APP1;
use crate::pixels::resize;

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "exif_orientation",
            "Wrong rotation tag",
            "Metadata",
            Layer::Meta,
            false,
            false,
            false,
            "The pixels are untouched; only the little Exif note saying which way is up changes. Viewers that obey it show the photo sideways or mirrored, viewers that ignore it don't, which is why a photo can look fine on one device and turned on another.",
            vec![p_enum(
                "value",
                "Orientation",
                &[
                    ("1", "Normal"),
                    ("2", "Mirrored"),
                    ("3", "Upside down"),
                    ("4", "Flipped vertically"),
                    ("5", "Mirrored + 90° left"),
                    ("6", "90° right"),
                    ("7", "Mirrored + 90° right"),
                    ("8", "90° left"),
                    ("0", "Garbage value"),
                ],
                "6",
            )],
        ),
        info(
            "exif_thumb_mismatch",
            "Thumbnail of another photo",
            "Metadata",
            Layer::Meta,
            false,
            false,
            true,
            "Cameras hide a tiny preview inside the Exif data. Swap it for another photo's and file browsers show one picture in the thumbnail while the photo itself is a different one.",
            vec![p_photo("photo", "Thumbnail from")],
        ),
        info(
            "exif_corrupt",
            "Corrupt Exif",
            "Metadata",
            Layer::Meta,
            true,
            true,
            false,
            "Random bytes inside the Exif block are damaged: pointers lead nowhere or loop back on themselves. The picture is fine, but some programs lose the date, rotation or thumbnail, or refuse the file.",
            vec![p_float("rate", "Damage", 0.0, 1.0, 0.01, 0.05).hint("Share of Exif bytes changed")],
        ),
        info(
            "strip_exif",
            "Remove Exif",
            "Metadata",
            Layer::Meta,
            false,
            false,
            false,
            "Removes the hidden notes a camera writes into the file: location, serial numbers and more. The picture itself does not change.",
            vec![p_enum("mode", "Remove", &[("private", "Private fields (GPS, serials, owner)"), ("all", "All metadata")], "private")],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "exif_orientation" => {
            let v = match p.get("value") {
                Some(Value::String(s)) => s.parse().unwrap_or(6),
                Some(v) => v.as_i64().unwrap_or(6),
                None => 6,
            };
            let v = if !(1..=8).contains(&v) { 0x5A5A } else { v as u16 };
            Ok(exif::set_orientation(input, v))
        }
        "exif_thumb_mismatch" => thumb_mismatch(p, input, ctx),
        "exif_corrupt" => exif_corrupt(p, input, ctx),
        "strip_exif" => Ok(if get_str(p, "mode", "private") == "all" {
            super::colour::drop_segments(input, |m, d| (m == APP1) || m == 0xED || m == 0xFE || (m == 0xE2 && !d.starts_with(b"ICC_PROFILE")))
        } else {
            exif::strip_private(input)
        }),
        _ => return None,
    })
}

fn thumb_mismatch(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let donor = pick_photo(p, "photo", ctx)?;
    let d = render::decode(donor, &render::DecodeOpts::default()).map_err(|_| "the other photo can't be read".to_string())?;
    let src = Rgba { w: d.width, h: d.height, px: d.rgba };
    let (tw, th) = if src.w >= src.h { (160, 120) } else { (120, 160) };
    let thumb = resize(&src, tw, th);
    let mut s = encoder::EncodeSettings::standard(75, "422");
    s.jfif = false;
    exif::with_thumbnail(input, &px_out(&thumb, &s))
}

fn exif_corrupt(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let with = if exif::read(input).is_some() { input.to_vec() } else { exif::set_orientation(input, 1) };
    let l = walk(&with);
    let seg = l
        .segments
        .iter()
        .find(|s| s.marker == APP1 && s.payload(&with).starts_with(b"Exif\0\0"))
        .ok_or("no Exif block to damage")?
        .clone();
    let rate = get_f64(p, "rate", 0.05).clamp(0.0, 1.0);
    let a = seg.start + 14; // keep "Exif\0\0" + TIFF header
    let b = seg.end;
    if b <= a {
        return Err("Exif block is too small".into());
    }
    let mut rng = ctx.rng();
    let mut out = with.clone();
    let n = (((b - a) as f64) * rate).ceil() as usize;
    for _ in 0..n {
        let i = a + rng.below((b - a) as u32) as usize;
        out[i] = rng.next_u32() as u8;
    }
    if rate >= 0.2 {
        // IFD loop: point IFD0's next-IFD pointer back at IFD0.
        let t = seg.start + 6;
        let le = with.get(t..t + 2) == Some(b"II");
        let rd16 = |o: usize| -> usize { let x = [with[o], with[o + 1]]; (if le { u16::from_le_bytes(x) } else { u16::from_be_bytes(x) }) as usize };
        let ifd0 = 8usize;
        if t + ifd0 + 2 <= b {
            let next = t + ifd0 + 2 + rd16(t + ifd0) * 12;
            if next + 4 <= b {
                let v = if le { 8u32.to_le_bytes() } else { 8u32.to_be_bytes() };
                out[next..next + 4].copy_from_slice(&v);
            }
        }
    }
    Ok(out)
}
