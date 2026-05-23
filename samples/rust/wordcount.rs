use std::collections::HashMap;
use std::io::{self, Read};

fn main() {
    let min: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();

    let mut counts: HashMap<String, usize> = HashMap::new();
    for word in input.split_whitespace() {
        let key: String = word
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect();
        if key.is_empty() {
            continue;
        }
        *counts.entry(key).or_insert(0) += 1;
    }

    let mut sorted: Vec<_> = counts.into_iter().filter(|(_, n)| *n >= min).collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    for (word, n) in sorted {
        println!("{:>6}  {}", n, word);
    }
}
