use std::collections::HashMap;
use std::fmt;

fn fibonacci(n: u32) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}

fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    if n < 4 {
        return true;
    }
    if n % 2 == 0 {
        return false;
    }
    let mut i = 3u64;
    while i * i <= n {
        if n % i == 0 {
            return false;
        }
        i += 2;
    }
    true
}

fn word_counts(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        let key: String = word
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect();
        if !key.is_empty() {
            *counts.entry(key).or_insert(0) += 1;
        }
    }
    counts
}

#[derive(Debug, Clone)]
enum Shape {
    Circle { radius: f64 },
    Square { side: f64 },
    Rect { w: f64, h: f64 },
}

impl Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle { radius } => std::f64::consts::PI * radius * radius,
            Shape::Square { side } => side * side,
            Shape::Rect { w, h } => w * h,
        }
    }

    fn perimeter(&self) -> f64 {
        match self {
            Shape::Circle { radius } => 2.0 * std::f64::consts::PI * radius,
            Shape::Square { side } => 4.0 * side,
            Shape::Rect { w, h } => 2.0 * (w + h),
        }
    }
}

impl fmt::Display for Shape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Shape::Circle { radius } => write!(f, "Circle(r={})", radius),
            Shape::Square { side } => write!(f, "Square(s={})", side),
            Shape::Rect { w, h } => write!(f, "Rect({}x{})", w, h),
        }
    }
}

trait Greet {
    fn greet(&self) -> String;
}

struct Person {
    name: String,
    age: u8,
}

impl Greet for Person {
    fn greet(&self) -> String {
        format!("Hi, I'm {}, age {}", self.name, self.age)
    }
}

fn sum_squares_below(limit: u64) -> u64 {
    (1..limit).map(|x| x * x).sum()
}

fn collatz(mut n: u64) -> Vec<u64> {
    let mut seq = vec![n];
    while n != 1 {
        n = if n % 2 == 0 { n / 2 } else { 3 * n + 1 };
        seq.push(n);
    }
    seq
}

#[derive(Debug)]
enum ParseError {
    Empty,
    BadDigit(char),
    Overflow,
}

fn parse_u32(s: &str) -> Result<u32, ParseError> {
    if s.is_empty() {
        return Err(ParseError::Empty);
    }
    let mut acc: u32 = 0;
    for c in s.chars() {
        let d = c.to_digit(10).ok_or(ParseError::BadDigit(c))?;
        acc = acc.checked_mul(10).ok_or(ParseError::Overflow)?;
        acc = acc.checked_add(d).ok_or(ParseError::Overflow)?;
    }
    Ok(acc)
}

fn apply<T, F: Fn(T) -> T>(x: T, f: F) -> T {
    f(x)
}

fn longest_run<T: PartialEq>(xs: &[T]) -> usize {
    let mut best = 0;
    let mut cur = 0;
    let mut prev: Option<&T> = None;
    for x in xs {
        if Some(x) == prev {
            cur += 1;
        } else {
            cur = 1;
            prev = Some(x);
        }
        if cur > best {
            best = cur;
        }
    }
    best
}

fn main() {
    for i in 0..10 {
        println!("fib({}) = {}", i, fibonacci(i));
    }

    let primes: Vec<u64> = (2..50).filter(|&n| is_prime(n)).collect();
    println!("primes < 50: {:?}", primes);

    let counts = word_counts("the quick brown fox jumps over the lazy dog The Fox");
    let mut sorted: Vec<_> = counts.iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    println!("word counts: {:?}", sorted);

    let shapes = [
        Shape::Circle { radius: 1.5 },
        Shape::Square { side: 3.0 },
        Shape::Rect { w: 2.0, h: 4.0 },
    ];
    for s in &shapes {
        println!("{}: area={:.3} perim={:.3}", s, s.area(), s.perimeter());
    }

    let people: Vec<Box<dyn Greet>> = vec![
        Box::new(Person { name: "Ada".into(), age: 30 }),
        Box::new(Person { name: "Linus".into(), age: 55 }),
    ];
    for p in &people {
        println!("{}", p.greet());
    }

    println!("sum of squares < 10 = {}", sum_squares_below(10));
    println!("collatz(7) = {:?}", collatz(7));

    let doubled = apply(21, |x| x * 2);
    println!("doubled = {}", doubled);

    for input in ["123", "", "1a", "9999999999"] {
        match parse_u32(input) {
            Ok(n) => println!("parsed {:?} -> {}", input, n),
            Err(e) => println!("parsed {:?} -> err {:?}", input, e),
        }
    }

    let runs = [1, 1, 2, 2, 2, 3, 3, 2, 2, 2, 2];
    println!("longest run in {:?} = {}", runs, longest_run(&runs));
}
