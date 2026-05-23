use std::collections::HashMap;
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for word in input.split_whitespace() {
        let key = word.to_lowercase();
        *counts.entry(key).or_insert(0) += 1;
    }
    for (word, n) in counts {
        println!("{}\t{}", n, word);
    }
}
