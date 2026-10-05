//! Decode JPEGs with File Refragmenter's forgiving decoder and write binary PPMs (for viewing broken files).
//! cargo run --release -p refragmenter-card --example render_local -- <out_dir> <file.jpg>...

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = std::path::PathBuf::from(&args[1]);
    std::fs::create_dir_all(&out).unwrap();
    for f in &args[2..] {
        let data = std::fs::read(f).unwrap();
        match refragmenter_codec::decode_rgba(&data) {
            Ok(img) => {
                let mut ppm = format!("P6\n{} {}\n255\n", img.width, img.height).into_bytes();
                for px in img.rgba.chunks(4) {
                    ppm.extend_from_slice(&px[..3]);
                }
                let name = std::path::Path::new(f).file_stem().unwrap().to_string_lossy().to_string();
                std::fs::write(out.join(format!("{name}.ppm")), ppm).unwrap();
                println!("{name}: {}x{}", img.width, img.height);
            }
            Err(e) => println!("{f}: {e}"),
        }
    }
}
