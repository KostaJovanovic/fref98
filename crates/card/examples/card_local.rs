//! Local check: build a card from a folder of JPEGs, run a preset story, write the raw image and
//! every tool's recovered files to an output folder.
//! cargo run --release -p refragmenter-card --example card_local -- <photo_dir> <out_dir> [preset_id] [count]

use refragmenter_card::card::CameraKind;
use refragmenter_card::carve;
use refragmenter_card::fs::Fs;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = &args[1];
    let out = std::path::PathBuf::from(&args[2]);
    let preset_id = args.get(3).map(String::as_str).unwrap_or("ixus_512");
    let count: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(16);
    let mut paths: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    let photos: Vec<Vec<u8>> = paths.iter().filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg"))).take(count).map(|p| std::fs::read(p).unwrap()).collect();
    let presets = refragmenter_card::presets();
    let p = presets.as_array().unwrap().iter().find(|p| p["id"] == preset_id).expect("preset").clone();
    let t = std::time::Instant::now();
    // Optional override "fs:size_mb:cluster_kb" (small cards keep the written image file small).
    let ov: Vec<String> = args.get(5).map(|s| s.split(':').map(String::from).collect()).unwrap_or_default();
    let mut card = refragmenter_card::Card::new(
        Fs::parse(ov.first().map(String::as_str).unwrap_or(p["fs"].as_str().unwrap())),
        ov.get(1).and_then(|s| s.parse().ok()).unwrap_or(p["size_mb"].as_u64().unwrap()),
        ov.get(2).and_then(|s| s.parse().ok()).or(p["cluster_kb"].as_u64()),
        CameraKind::parse(p["camera"].as_str().unwrap()),
        photos,
        1234,
    );
    card.run_events(p["events"].as_array().unwrap());
    println!("simulated in {:?}", t.elapsed());
    for l in &card.log {
        println!("  {l}");
    }
    std::fs::create_dir_all(&out).unwrap();
    // Raw image (sparse -> full file, streamed in 4 MB chunks).
    let mut f = std::fs::File::create(out.join("card.img")).unwrap();
    let mut off = 0u64;
    while off < card.img.size {
        let n = (4u64 << 20).min(card.img.size - off) as usize;
        f.write_all(&card.img.read_vec(off, n)).unwrap();
        off += n as u64;
    }
    for tool in ["fat", "recuva", "photorec", "graft", "thumbnails"] {
        let t = std::time::Instant::now();
        let rec = carve::carve(&card, tool, &serde_json::json!({}));
        let d = out.join(tool);
        std::fs::create_dir_all(&d).unwrap();
        for r in &rec {
            let name = r.name.replace('/', "_");
            std::fs::write(d.join(&name), &r.data).unwrap();
        }
        println!("{tool}: {} files in {:?}", rec.len(), t.elapsed());
        for r in rec.iter().take(12) {
            println!("    {:<36} {:>9}  {}", r.name, r.size, r.note);
        }
    }
}
