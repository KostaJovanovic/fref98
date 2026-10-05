//! Developer CLI for testing the codec against reference decoders.
//!   refrag decode <in.jpg> <out.rgb> [personality] [fill]   -> raw RGB + prints "w h" and events
//!   refrag encode <in.rgb> <w> <h> <out.jpg> <quality> <sub> [progressive] [restart]
//!   refrag step <id> <params-json> <in.jpg> <out.jpg> [seed] [pool.jpg ...]
//!   refrag inspect <in.jpg>
//!   refrag bench <in.jpg>

use refragmenter_codec::*;
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(|s| s.as_str()) {
        Some("decode") => {
            let data = std::fs::read(&a[2]).unwrap();
            let mut o = render::DecodeOpts::default();
            if let Some(p) = a.get(4) {
                o = render::DecodeOpts::from_json(&serde_json::json!({ "personality": p, "fill": a.get(5).map(|s| s.as_str()).unwrap_or("grey") }));
            }
            match render::decode(&data, &o) {
                Ok(d) => {
                    let mut rgb = Vec::with_capacity(d.width * d.height * 3);
                    for px in d.rgba.chunks(4) {
                        rgb.extend_from_slice(&px[..3]);
                    }
                    std::fs::write(&a[3], rgb).unwrap();
                    println!("{} {}", d.width, d.height);
                    let max_ev: usize = std::env::var("REFRAG_EVENTS").ok().and_then(|s| s.parse().ok()).unwrap_or(40);
                    for e in d.events.iter().take(max_ev) {
                        eprintln!("{:?}", e);
                    }
                }
                Err(e) => {
                    println!("ERR {}", e);
                }
            }
        }
        Some("encode") => {
            let rgb = std::fs::read(&a[2]).unwrap();
            let w: usize = a[3].parse().unwrap();
            let h: usize = a[4].parse().unwrap();
            let mut rgba = Vec::with_capacity(w * h * 4);
            for px in rgb.chunks(3) {
                rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            let mut s = encoder::EncodeSettings::standard(a[6].parse().unwrap(), &a[7]);
            s.progressive = a.get(8).map(|x| x == "1").unwrap_or(false);
            s.restart_interval = a.get(9).map(|x| x.parse().unwrap()).unwrap_or(0);
            let out = encoder::encode_rgba(w, h, &rgba, &s);
            std::fs::write(&a[5], out).unwrap();
        }
        Some("step") => {
            let params: serde_json::Value = serde_json::from_str(&a[3]).unwrap();
            let data = std::fs::read(&a[4]).unwrap();
            let seed: u32 = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(1);
            let pool: Vec<Vec<u8>> = a.iter().skip(7).map(|p| std::fs::read(p).unwrap()).collect();
            let ctx = StepCtx { seed, pool: &pool };
            let t = Instant::now();
            match apply_step(&a[2], &params, &data, &ctx) {
                Some(Ok(out)) => {
                    std::fs::write(&a[5], out).unwrap();
                    eprintln!("ok in {:?}", t.elapsed());
                }
                Some(Err(e)) => println!("ERR {}", e),
                None => println!("unknown step"),
            }
        }
        Some("arith") => {
            // arith <in.jpg> <out.jpg> [progressive 0/1] [restart]: lossless transcode to arithmetic coding
            // (like jpegtran -arithmetic).
            let data = std::fs::read(&a[2]).unwrap();
            let p = decoder::parse(&data, false);
            let mut s = encoder::EncodeSettings::from_parsed(&p).unwrap();
            s.progressive = a.get(4).map(|x| x == "1").unwrap_or(false);
            s.restart_interval = a.get(5).map(|x| x.parse().unwrap()).unwrap_or(0);
            std::fs::write(&a[3], encoder::write_arith(p.img.as_ref().unwrap(), &s)).unwrap();
        }
        Some("catalog") => println!("{}", serde_json::to_string(&catalog()).unwrap()),
        Some("inspect") => {
            let data = std::fs::read(&a[2]).unwrap();
            println!("{}", inspect::inspect_json(&data));
        }
        Some("bench") => {
            let data = std::fs::read(&a[2]).unwrap();
            let t = Instant::now();
            let d = render::decode(&data, &render::DecodeOpts::default()).unwrap();
            let td = t.elapsed();
            let t = Instant::now();
            let s = encoder::EncodeSettings::like(&data).unwrap();
            let out = encoder::encode_rgba(d.width, d.height, &d.rgba, &s);
            println!("{}x{} decode {:?} encode {:?} ({} bytes)", d.width, d.height, td, t.elapsed(), out.len());
        }
        Some("gif") => {
            let frames: Vec<render::Decoded> = a[3..].iter().map(|p| render::decode(&std::fs::read(p).unwrap(), &render::DecodeOpts::default()).unwrap()).collect();
            let (w, h) = (frames[0].width, frames[0].height);
            let px: Vec<Vec<u8>> = frames.into_iter().map(|f| f.rgba).collect();
            std::fs::write(&a[2], gif::encode(w, h, &px, 20)).unwrap();
        }
        Some("aviread") => {
            let d = std::fs::read(&a[2]).unwrap();
            let i = avi::read(&d);
            println!("{}x{} fps {} frames {}", i.width, i.height, i.fps, i.frames.len());
            if let Some(idx) = a.get(3) {
                std::fs::write(&a[4], avi::frame(&d, idx.parse().unwrap()).unwrap()).unwrap();
            }
        }
        Some("smoothprobe") => {
            // smoothprobe <mode: dc|ac9> <impulse block x> <y> <value> <out.jpg>: 5x5-block grey image.
            let (bx, by, val): (usize, usize, i16) = (a[3].parse().unwrap(), a[4].parse().unwrap(), a[5].parse().unwrap());
            let mut img = coeffs::CoeffImage::new(40, 40, &[coeffs::CompSpec { id: 1, h: 1, v: 1, tq: 0 }], coeffs::ColorSpace::Gray);
            img.comps[0].q = [1; 64];
            img.comps[0].q[0] = a.get(7).map(|s| s.parse().unwrap()).unwrap_or(1);
            img.comps[0].block_mut(bx, by)[0] = val;
            let mut s = encoder::EncodeSettings::standard(90, "444");
            s.progressive = true;
            let sc = |ss, se| decoder::ScanSpec { comps: vec![0], td: vec![0], ta: vec![0], ss, se, ah: 0, al: 0 };
            s.scans = Some(if a[2] == "dc" { vec![sc(0, 0)] } else { vec![sc(0, 0), sc(9, 9)] });
            std::fs::write(&a[6], encoder::write(&img, &s)).unwrap();
        }
        Some("planes") => {
            // planes <file> <out.raw>: upsampled component planes, interleaved (YCbCr before conversion).
            let d = std::fs::read(&a[2]).unwrap();
            let p = decoder::parse(&d, false);
            let img = p.img.as_ref().unwrap();
            let pl = render::render_planes(img, &p, &render::DecodeOpts::default());
            let mut out = Vec::new();
            for i in 0..pl.width * pl.height {
                for c in &pl.planes {
                    out.push(c.data[i]);
                }
            }
            std::fs::write(&a[3], out).unwrap();
            println!("{} {} {}", pl.width, pl.height, pl.planes.len());
        }
        Some("block") => {
            // block <file> <comp> <bx> <by>: coefficients (natural order) + both IDCT variants.
            let d = std::fs::read(&a[2]).unwrap();
            let p = decoder::parse(&d, false);
            let img = p.img.unwrap();
            let c = &img.comps[a[3].parse::<usize>().unwrap()];
            let b = c.block(a[4].parse().unwrap(), a[5].parse().unwrap());
            println!("coef {:?}\nq {:?}", b, c.q);
            let (mut o1, mut o2) = ([0u8; 64], [0u8; 64]);
            dct::idct_islow(b, &c.q, &mut o1, 8);
            dct::idct_islow_simd(b, &c.q, &mut o2, 8);
            println!("c    {:?}\nsimd {:?}", o1, o2);
        }
        Some("fuzz") => {
            let data = std::fs::read(&a[2]).unwrap();
            let rounds: usize = a[3].parse().unwrap();
            let mut rng = step::Pcg32::new(a.get(4).map(|s| s.parse().unwrap()).unwrap_or(5), 3);
            let mut worst = std::time::Duration::ZERO;
            for r in 0..rounds {
                let mut d = data.clone();
                for _ in 0..1 + rng.below(20) {
                    let i = rng.below(d.len().max(1) as u32) as usize;
                    match rng.below(5) {
                        0 => d[i] ^= 1 << rng.below(8),
                        1 => {
                            d.drain(i..(i + rng.below(5000) as usize).min(d.len()));
                        }
                        2 => d.splice(i..i, (0..rng.below(300)).map(|_| rng.next_u32() as u8)).for_each(drop),
                        3 => d[i] = 0xFF,
                        _ => d.truncate(i.max(2)),
                    }
                    if d.len() < 4 {
                        break;
                    }
                }
                let t = Instant::now();
                let _ = render::decode(&d, &render::DecodeOpts::default());
                let el = t.elapsed();
                if el > worst {
                    worst = el;
                    eprintln!("round {r}: {:?}", el);
                }
            }
            println!("fuzz ok, worst {:?}", worst);
        }
        _ => eprintln!("usage: see source"),
    }
}
