//! File Refragmenter virtual SD card: FAT16/FAT32/exFAT card images, camera write/delete/overwrite scenarios,
//! carving and rebuilding, plus other-format recovery scenarios.

pub mod card;
pub mod carve;
mod formats;
pub mod fs;
pub mod img;
pub mod jpeg;
mod steps;
pub mod thumbs;

use refragmenter_codec::step::*;
use serde_json::{json, Value};

pub use card::Card;

/// Card/format step catalog.
pub fn catalog() -> Vec<StepInfo> {
    let mut v = steps::catalog();
    v.extend(formats::catalog());
    v
}

/// Run a card/format step. Returns None when `id` is not a card step.
pub fn apply_step(id: &str, params: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    steps::apply(id, params, input, ctx).or_else(|| formats::apply(id, params, input, ctx))
}

/// Ready-made cards with a default story (the UI's "Removable Disk (E:)" presets).
pub fn presets() -> Value {
    json!([
        {
            "id": "ixus_512", "label": "512 MB card from a 2004 Canon", "fs": "fat16", "size_mb": 512, "cluster_kb": 8,
            "camera": "canon2004",
            "description": "A typical 2004 digicam card: FAT16, 8 KB clusters, IMG_0001.JPG names, MJPEG movie clips.",
            "events": [
                {"type":"shoot","count":6}, {"type":"video","frames":4}, {"type":"shoot","count":4},
                {"type":"delete","which":"every_other"}, {"type":"overwrite","count":4},
                {"type":"delete","which":"all"}, {"type":"os_junk","kb":192}
            ]
        },
        {
            "id": "tiny_32", "label": "32 MB card, nearly full", "fs": "fat16", "size_mb": 32, "cluster_kb": 2,
            "camera": "generic",
            "description": "Tiny card, tiny clusters: deleting and reshooting fragments everything.",
            "events": [
                {"type":"shoot","count":5}, {"type":"delete","which":"random","count":3}, {"type":"power_cycle"},
                {"type":"shoot","count":4}, {"type":"quick_format"}, {"type":"shoot","count":1}
            ]
        },
        {
            "id": "sdhc_8g", "label": "8 GB SDHC from a phone", "fs": "fat32", "size_mb": 8192, "cluster_kb": 32,
            "camera": "phone",
            "description": "FAT32: deleting wipes the top half of each start-cluster number, so undelete tools look in the wrong place.",
            "events": [
                {"type":"advance","percent":45}, {"type":"shoot","count":6}, {"type":"delete","which":"all"},
                {"type":"power_loss","at":0.4,"mode":"no_entry"}, {"type":"shoot","count":1}, {"type":"chkdsk"}
            ]
        },
        {
            "id": "sdxc_64g", "label": "64 GB SDXC (exFAT)", "fs": "exfat", "size_mb": 65536, "cluster_kb": 128,
            "camera": "phone",
            "description": "exFAT keeps contiguous files without a FAT chain, so plain undelete often works perfectly, until something overwrites them.",
            "events": [
                {"type":"shoot","count":5}, {"type":"delete","which":"all"}, {"type":"shoot","count":2},
                {"type":"flash_fault","mode":"erased","count":6,"page_kb":16}
            ]
        }
    ])
}

/// Scenario event types for the expert timeline (same ParamInfo shape as steps).
pub fn event_catalog() -> Vec<StepInfo> {
    let ev = |id, label, help, params| StepInfo {
        id,
        label,
        group: "Card event",
        layer: Layer::Card,
        expert: false,
        random: false,
        uses_pool: false,
        simulated: false,
        help,
        params,
    };
    vec![
        ev("shoot", "Take photos", "The camera saves the next photos from the roll into free clusters.", vec![p_int("count", "Photos", 1, 200, 3)]),
        ev(
            "burst",
            "Burst / RAW+JPEG",
            "Several files are written at once, so their clusters alternate.",
            vec![p_int("count", "Files at once", 2, 8, 3), p_int("period", "Clusters per turn", 1, 16, 1)],
        ),
        ev(
            "video",
            "Record movie",
            "An MJPEG .AVI movie and its .THM thumbnail are written.",
            vec![p_int("frames", "Frames", 1, 60, 4)],
        ),
        ev(
            "delete",
            "Delete",
            "Directory entries are marked deleted and the clusters are freed. The data itself stays.",
            vec![
                p_enum(
                    "which",
                    "Which",
                    &[("all", "All"), ("last", "Last"), ("first", "First"), ("every_other", "Every other"), ("random", "Random")],
                    "all",
                ),
                p_int("count", "How many", 1, 200, 1),
                p_bool("clear_high", "FAT32: clear high start bits (Windows)", true).expert(),
            ],
        ),
        ev("power_cycle", "Switch camera off/on", "The camera forgets where it was writing; the next photo fills the first gap.", vec![]),
        ev(
            "advance",
            "Card already part-full",
            "Pretend older shots fill the card up to a point.",
            vec![p_float("percent", "Percent", 0.0, 99.0, 1.0, 50.0)],
        ),
        ev("quick_format", "Format in camera", "A fresh, empty file table. Every photo is still physically on the card.", vec![]),
        ev(
            "reformat_pc",
            "Format on a PC",
            "A different file system and cluster size: old photos no longer line up with the new cluster grid.",
            vec![
                p_enum("fs", "File system", &[("fat16", "FAT16"), ("fat32", "FAT32"), ("exfat", "exFAT")], "fat32"),
                p_int("cluster_kb", "Cluster size (KB)", 1, 256, 4),
            ],
        ),
        ev(
            "power_loss",
            "Battery dies during next save",
            "The next photo is only partly written and the file system is left inconsistent.",
            vec![
                p_float("at", "Written before it died", 0.05, 0.95, 0.05, 0.5),
                p_enum("mode", "What got saved", &[("size_zero", "Entry with 0 bytes"), ("no_entry", "Data + FAT, no entry")], "size_zero"),
            ],
        ),
        ev("chkdsk", "Run chkdsk", "Lost cluster chains are saved as FOUND.000\\FILE0000.CHK.", vec![]),
        ev(
            "fat_glitch",
            "FAT glitch (cross-links)",
            "Some FAT links point into other files' chains.",
            vec![p_int("count", "Bad links", 1, 64, 2)],
        ),
        ev(
            "os_junk",
            "Plug into a PC",
            "The PC writes index files, ._ files and Thumbs.db into the lowest free clusters, over deleted photos.",
            vec![
                p_int("kb", "Junk written (KB)", 8, 65536, 256),
                p_enum(
                    "thumbs_of",
                    "Thumbs.db remembers",
                    &[("all", "Every photo it ever showed"), ("live", "Only photos still on the card")],
                    "all",
                )
                .expert(),
                p_bool("exact", "Exactly this much (one index file)", false).expert(),
            ],
        ),
        ev(
            "overwrite",
            "New shots over deleted ones",
            "The camera is switched off and on, so the next photos go into the first free clusters: right on top of deleted photos. Whatever they cover is gone for good.",
            vec![p_int("count", "Photos", 1, 200, 2)],
        ),
        ev(
            "flash_fault",
            "Flash fault",
            "Pages of the flash memory fail.",
            vec![
                p_enum("mode", "Fault", &[("erased", "Erased (0xFF)"), ("burst", "Bursts"), ("stuck_bit", "Stuck bit"), ("zero", "Zeros")], "erased"),
                p_int("count", "Pages", 1, 4096, 4),
                p_int("page_kb", "Page size (KB)", 2, 64, 16),
            ],
        ),
    ]
}
