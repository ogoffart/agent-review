use std::time::{SystemTime, UNIX_EPOCH};

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next(&mut self) -> u64 {
        // xorshift64
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

fn parse_notation(s: &str) -> Option<(u32, u32, i32)> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;

    fn read_num(chars: &[char], i: &mut usize) -> Option<u32> {
        let start = *i;
        while *i < chars.len() && chars[*i].is_ascii_digit() {
            *i += 1;
        }
        if *i == start {
            return None;
        }
        chars[start..*i].iter().collect::<String>().parse().ok()
    }

    let count = read_num(&chars, &mut i)?;
    if i >= chars.len() || chars[i] != 'd' {
        return None;
    }
    i += 1;
    let sides = read_num(&chars, &mut i)?;
    let modifier = match chars.get(i) {
        Some('+') => {
            i += 1;
            read_num(&chars, &mut i)? as i32
        }
        Some('-') => {
            i += 1;
            -(read_num(&chars, &mut i)? as i32)
        }
        Some(_) => return None,
        None => 0,
    };
    Some((count, sides, modifier))
}

fn main() {
    let notation = std::env::args().nth(1).unwrap_or_else(|| "3d6".into());
    let (count, sides, modifier) =
        parse_notation(&notation).expect("expected dice notation like 3d6+2");

    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    let mut rng = Rng::new(seed);

    let rolls: Vec<u64> = (0..count).map(|_| rng.range(1, sides as u64)).collect();
    let sum: i64 = rolls.iter().sum::<u64>() as i64 + modifier as i64;
    println!("{} -> {:?}  total {} ({:+})", notation, rolls, sum, modifier);
}
