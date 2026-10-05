//! Timing check for the card presets (no files written).
//! cargo run --release -p refragmenter-card --example card_bench -- <photo_dir> [count] [preset_id]
//! Mirrors what the web worker does: Card.simulate with the preset story, then every carving tool.

use refragmenter_card::card::CameraKind;
use refragmenter_card::carve;
use refragmenter_card::fs::Fs;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: card_bench <photo_dir> [count] [preset_id]");
        std::process::exit(2);
    }
    let dir = &args[1];
    let count: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(16);
    let only = args.get(3).cloned();
    let mut paths: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    let photos: Vec<Vec<u8>> = paths
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg")))
        .take(count)
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    println!("{} photos, {} KB total", photos.len(), photos.iter().map(|p| p.len()).sum::<usize>() / 1024);
    for p in refragmenter_card::presets().as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        if only.as_deref().is_some_and(|o| o != id) {
            continue;
        }
        let t = Instant::now();
        let mut card = refragmenter_card::Card::new(
            Fs::parse(p["fs"].as_str().unwrap()),
            p["size_mb"].as_u64().unwrap(),
            p["cluster_kb"].as_u64(),
            CameraKind::parse(p["camera"].as_str().unwrap()),
            photos.clone(),
            1234,
        );
        card.camera_thumbs = true;
        card.run_events(p["events"].as_array().unwrap());
        let sim = t.elapsed();
        let mut line = format!("{id:<10} simulate {:>7.1?}", sim);
        for tool in ["fat", "recuva", "photorec", "graft", "thumbnails"] {
            let t = Instant::now();
            let rec = carve::carve(&card, tool, &serde_json::json!({}));
            line += &format!("  {tool} {}:{:.1?}", rec.len(), t.elapsed());
        }
        println!("{line}");
        for l in &card.log {
            println!("    {l}");
        }
    }
}
