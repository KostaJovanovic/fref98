//! Local check: run every card step on a real photo with pool neighbours and write the results.
//! cargo run --release -p refragmenter-card --example step_local -- <photo_dir> <out_dir>

use refragmenter_codec::step::StepCtx;
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: step_local <photo_dir> <out_dir>   (the first .jpg is the input, the next four its pool)");
        std::process::exit(2);
    }
    let out = std::path::PathBuf::from(&args[2]);
    std::fs::create_dir_all(&out).unwrap();
    let mut paths: Vec<_> = std::fs::read_dir(&args[1]).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    let jpgs: Vec<Vec<u8>> = paths.iter().filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg"))).take(5).map(|p| std::fs::read(p).unwrap()).collect();
    let Some(input) = jpgs.first() else {
        eprintln!("no .jpg files in {}", args[1]);
        std::process::exit(2);
    };
    let pool = jpgs[1..].to_vec();
    let ctx = StepCtx { seed: 42, pool: &pool };
    for scenario in ["junk_overwrite", "fragmented", "burst", "pc_reformat", "power_loss", "flash_failure", "fat32_undelete"] {
        for tool in ["graft", "photorec", "recuva"] {
            let t = std::time::Instant::now();
            let r = refragmenter_card::apply_step("pass_through_card", &json!({"scenario": scenario, "tool": tool, "severity": 6}), input, &ctx)
                .unwrap()
                .unwrap();
            println!("{scenario:>15} {tool:>8}: {:>8} bytes in {:?}", r.len(), t.elapsed());
            std::fs::write(out.join(format!("ptc_{scenario}_{tool}.jpg")), r).unwrap();
        }
    }
    for info in refragmenter_card::catalog() {
        if info.id == "pass_through_card" {
            continue;
        }
        let r = refragmenter_card::apply_step(info.id, &json!({}), input, &ctx).unwrap().unwrap();
        std::fs::write(out.join(format!("{}.jpg", info.id)), r).unwrap();
    }
}
