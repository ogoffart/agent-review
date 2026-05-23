use std::collections::HashMap;
use std::hash::Hash;

pub struct Lru<K, V> {
    cap: usize,
    map: HashMap<K, (V, u64)>,
    tick: u64,
}

impl<K: Hash + Eq + Clone, V: Clone> Lru<K, V> {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "capacity must be positive");
        Self { cap, map: HashMap::with_capacity(cap), tick: 0 }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn get(&mut self, k: &K) -> Option<V> {
        let entry = self.map.get_mut(k)?;
        self.tick += 1;
        entry.1 = self.tick;
        Some(entry.0.clone())
    }

    pub fn put(&mut self, k: K, v: V) {
        if !self.map.contains_key(&k) && self.map.len() >= self.cap {
            self.evict_oldest();
        }
        self.tick += 1;
        self.map.insert(k, (v, self.tick));
    }

    fn evict_oldest(&mut self) {
        let victim = self
            .map
            .iter()
            .min_by_key(|(_, (_, t))| *t)
            .map(|(k, _)| k.clone());
        if let Some(k) = victim {
            self.map.remove(&k);
        }
    }
}

fn main() {
    let mut cache: Lru<&str, u32> = Lru::new(3);
    cache.put("a", 1);
    cache.put("b", 2);
    cache.put("c", 3);
    println!("get a = {:?}", cache.get(&"a"));
    cache.put("d", 4);
    println!("after inserting d, get b = {:?}", cache.get(&"b"));
    println!("get c = {:?}", cache.get(&"c"));
    println!("get d = {:?}", cache.get(&"d"));
    println!("len = {}", cache.len());
}
