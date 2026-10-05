//! Camera / phone / app encoder profiles. The Canon IXUS 400 tables were measured from real
//! IXUS 400 "Superfine" files (identical headers across the camera): 4:2:2 (h2v1),
//! baseline, Annex K Huffman tables, no restart interval, APP1 Exif first and no JFIF.
//! Phone and app profiles are approximations from publicly observed behaviour.

use crate::encoder::{EncodeSettings, HuffMode};
use crate::markers::APP1;
use crate::tables::zigzag_to_natural;
use serde::Serialize;

/// Canon DIGITAL IXUS 400 "Superfine" luminance table, zigzag order as stored in DQT.
const IXUS400_LUMA_ZZ: [u16; 64] = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 2, 3, 1, 2, 3, 3, 3, 3, 3, 2, 4, 3, 3, 5, 5, 4, 3, 4, 4,
    3, 3, 3, 4, 6, 4, 4, 5, 5, 5, 5, 6, 3, 4, 6, 6, 5, 5, 6, 5, 5, 5, 5,
];
/// Canon DIGITAL IXUS 400 "Superfine" chrominance table, zigzag order.
const IXUS400_CHROMA_ZZ: [u16; 64] = [
    1, 1, 1, 2, 1, 2, 4, 2, 2, 4, 6, 4, 3, 4, 6, 11, 8, 4, 4, 8, 11, 11, 11, 11, 5, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11,
    11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11,
];

#[derive(Serialize, Clone, Debug)]
pub struct ProfileInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    pub width: usize,
    pub height: usize,
    pub quality_note: &'static str,
}

struct Def {
    info: ProfileInfo,
    quality: i32,
    sub: &'static str,
    progressive: bool,
    optimize: bool,
    restart: usize,
    exif: Option<(&'static str, &'static str)>,
    custom: Option<([u16; 64], [u16; 64])>,
}

fn defs() -> Vec<Def> {
    let p = |id, label, kind, year, width, height, quality_note| ProfileInfo { id, label, kind, year, width, height, quality_note };
    vec![
        Def {
            info: p("canon_ixus400", "Canon DIGITAL IXUS 400 (2003)", "camera", Some(2003), 2272, 1704, "Measured from real photos: Superfine tables, 4:2:2"),
            quality: 97,
            sub: "422",
            progressive: false,
            optimize: false,
            restart: 0,
            exif: Some(("Canon", "Canon DIGITAL IXUS 400")),
            custom: Some((zigzag_to_natural(&IXUS400_LUMA_ZZ), zigzag_to_natural(&IXUS400_CHROMA_ZZ))),
        },
        Def {
            info: p("digicam_2004", "Generic 2004 digicam (3 MP)", "camera", Some(2004), 2048, 1536, "Approximation: ~q85, 4:2:2, standard tables"),
            quality: 85,
            sub: "422",
            progressive: false,
            optimize: false,
            restart: 0,
            exif: Some(("DIGICAM", "3.2 Megapixel")),
            custom: None,
        },
        Def {
            info: p("phone_2010", "2010 phone camera (5 MP)", "phone", Some(2010), 2592, 1944, "Approximation: ~q88, 4:2:0, restart markers"),
            quality: 88,
            sub: "420",
            progressive: false,
            optimize: false,
            restart: 162,
            exif: Some(("Phone", "Phone Camera 5MP")),
            custom: None,
        },
        Def {
            info: p("phone_modern", "Modern phone (12 MP)", "phone", Some(2023), 4032, 3024, "Approximation: ~q92, 4:2:0, optimised tables"),
            quality: 92,
            sub: "420",
            progressive: false,
            optimize: true,
            restart: 0,
            exif: Some(("Phone", "Phone Camera 12MP")),
            custom: None,
        },
        Def {
            info: p("whatsapp", "WhatsApp (sent as photo)", "app", None, 1600, 1600, "Approximation: long side 1600 px, ~q75, 4:2:0"),
            quality: 75,
            sub: "420",
            progressive: false,
            optimize: true,
            restart: 0,
            exif: None,
            custom: None,
        },
        Def {
            info: p("facebook", "Facebook upload", "app", None, 2048, 2048, "Approximation: long side 2048 px, ~q85, progressive"),
            quality: 85,
            sub: "420",
            progressive: true,
            optimize: true,
            restart: 0,
            exif: None,
            custom: None,
        },
        Def {
            info: p("instagram", "Instagram feed", "app", None, 1080, 1080, "Approximation: long side 1080 px, ~q78, 4:2:0"),
            quality: 78,
            sub: "420",
            progressive: false,
            optimize: true,
            restart: 0,
            exif: None,
            custom: None,
        },
        Def {
            info: p("mms", "MMS picture message", "app", Some(2005), 640, 640, "Approximation: long side 640 px, ~q50"),
            quality: 50,
            sub: "420",
            progressive: false,
            optimize: false,
            restart: 0,
            exif: None,
            custom: None,
        },
        Def {
            info: p("libjpeg_q90", "libjpeg quality 90", "generic", None, 0, 0, "IJG tables scaled to q90, 4:2:0"),
            quality: 90,
            sub: "420",
            progressive: false,
            optimize: false,
            restart: 0,
            exif: None,
            custom: None,
        },
        Def {
            info: p("libjpeg_q75", "libjpeg quality 75", "generic", None, 0, 0, "IJG tables scaled to q75, 4:2:0 (default)"),
            quality: 75,
            sub: "420",
            progressive: false,
            optimize: false,
            restart: 0,
            exif: None,
            custom: None,
        },
        Def {
            info: p("libjpeg_q50", "libjpeg quality 50", "generic", None, 0, 0, "IJG base tables (q50), 4:2:0"),
            quality: 50,
            sub: "420",
            progressive: false,
            optimize: false,
            restart: 0,
            exif: None,
            custom: None,
        },
    ]
}

pub const DEFAULT_PROFILE: &str = "libjpeg_q75";

pub fn infos() -> Vec<ProfileInfo> {
    defs().into_iter().map(|d| d.info).collect()
}

/// A resolved profile: encoder settings plus its size rule.
pub struct Profile {
    pub settings: EncodeSettings,
    /// The quality its tables stand for.
    pub quality: i32,
    /// Its tables were measured from real files (not libjpeg's standard ones).
    pub measured: bool,
    /// (max_w, max_h) box for cameras, or (n, n) long-side cap for apps; 0 = keep size.
    pub max_w: usize,
    pub max_h: usize,
}

impl Profile {
    /// Its settings at quality `q`: libjpeg's standard tables for `q`, or its own measured tables scaled
    /// from the quality they were made for (they used to be replaced by the standard ones).
    pub fn settings_at(&self, q: i32) -> EncodeSettings {
        let mut s = self.settings.clone();
        if self.measured {
            s.rescale_quality(self.quality, q);
        } else {
            s.set_quality(q);
        }
        s
    }

    /// Target dimensions for a w x h source (never upscales; rotates the box for portrait).
    pub fn target_dims(&self, w: usize, h: usize) -> (usize, usize) {
        if self.max_w == 0 {
            return (w, h);
        }
        let (bw, bh) = if (w >= h) == (self.max_w >= self.max_h) { (self.max_w, self.max_h) } else { (self.max_h, self.max_w) };
        crate::pixels::fit_dims(w, h, bw, bh)
    }
}

pub fn get(id: &str) -> Option<Profile> {
    let d = defs().into_iter().find(|d| d.info.id == id)?;
    // standard() already gives the tables for d.quality, the sampling, YCbCr and BT.601
    let mut s = EncodeSettings::standard(d.quality, d.sub);
    if let Some((l, c)) = d.custom {
        s.qtables = vec![l, c, c];
    }
    s.progressive = d.progressive;
    s.huffman = if d.optimize { HuffMode::Optimize } else { HuffMode::Standard };
    s.restart_interval = d.restart;
    if let Some((make, model)) = d.exif {
        s.jfif = false;
        s.segments.push((APP1, crate::exif::minimal(make, model)));
    }
    Some(Profile { settings: s, quality: d.quality, measured: d.custom.is_some(), max_w: d.info.width, max_h: d.info.height })
}

pub fn json() -> String {
    serde_json::to_string(&infos()).unwrap_or_else(|_| "[]".into())
}
