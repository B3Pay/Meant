//! TOK, the token of the example: balances and exactly-once sends. No system API here, so `cargo test` runs it on the
//! host; `lib.rs` wires it to the canister's methods.
//!
//! A send that carries `created_at` is deduplicated for 24 hours on what it sends (caller, recipient, amount, memo and
//! stamp), the ICRC-1 rule. What the canister remembers for that is bounded (review on B3Pay/Meant#321): expired
//! entries are dropped before every stamped send, a send of nothing is refused, and while [`MAX_SEEN`] unexpired
//! stamped sends are held, a new stamped send is refused with `Other` until the oldest expire. An unstamped send is not
//! remembered, so it still goes through.

use std::collections::BTreeMap;

use candid::{CandidType, Deserialize, Nat, Principal};

/// What the installer starts with: 1,000 TOK (8 decimals).
pub const INITIAL_E8S: u64 = 1_000 * 100_000_000;
/// How long a stamped send is deduplicated, and how far ahead of the canister's clock a stamp may be.
pub const WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
pub const DRIFT_NS: u64 = 2 * 60 * 1_000_000_000;
pub const MAX_MEMO: usize = 32;
/// The most stamped sends remembered at once: under 200 bytes each with the map's overhead, so about 2 MB at most.
pub const MAX_SEEN: usize = 10_000;

#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tokens {
    pub e8s: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct SendArgs {
    pub to: Principal,
    pub amount: Tokens,
    pub memo: Option<Vec<u8>>,
    pub created_at: Option<u64>,
}

#[derive(CandidType, Debug, PartialEq, Eq)]
pub enum SendError {
    Insufficient { balance: Tokens },
    Duplicate { block: Nat },
    TooOld,
    CreatedInFuture { canister_time: u64 },
    Other(String),
}

/// What a stamped send is deduplicated on. Bounded: a principal is at most 29 bytes and the memo at most [`MAX_MEMO`].
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Sent {
    from: Principal,
    to: Principal,
    e8s: u64,
    memo: Option<Vec<u8>>,
    created_at: u64,
}

#[derive(Default)]
pub struct State {
    balances: BTreeMap<Principal, u64>,
    blocks: u64,
    /// Every unexpired stamped send, with its block.
    seen: BTreeMap<Sent, u64>,
}

impl State {
    pub fn mint(&mut self, to: Principal, e8s: u64) {
        *self.balances.entry(to).or_insert(0) += e8s;
    }

    pub fn balance(&self, of: &Principal) -> u64 {
        self.balances.get(of).copied().unwrap_or(0)
    }

    #[cfg(test)]
    pub fn remembered(&self) -> usize {
        self.seen.len()
    }

    pub fn send(&mut self, from: Principal, args: &SendArgs, now: u64) -> Result<Nat, SendError> {
        if args.memo.as_ref().is_some_and(|m| m.len() > MAX_MEMO) {
            return Err(SendError::Other(format!("the memo is over {MAX_MEMO} bytes")));
        }
        if args.amount.e8s == 0 {
            return Err(SendError::Other("the amount is zero".into()));
        }
        let sent = match args.created_at {
            None => None,
            Some(stamp) => {
                if stamp.saturating_add(WINDOW_NS) < now {
                    return Err(SendError::TooOld);
                }
                if stamp > now.saturating_add(DRIFT_NS) {
                    return Err(SendError::CreatedInFuture { canister_time: now });
                }
                self.seen.retain(|s, _| s.created_at.saturating_add(WINDOW_NS) >= now);
                let sent = Sent { from, to: args.to, e8s: args.amount.e8s, memo: args.memo.clone(), created_at: stamp };
                if let Some(&block) = self.seen.get(&sent) {
                    return Err(SendError::Duplicate { block: Nat::from(block) });
                }
                if self.seen.len() >= MAX_SEEN {
                    return Err(SendError::Other(format!(
                        "{MAX_SEEN} stamped sends in the last 24 hours; try again when the oldest expire"
                    )));
                }
                Some(sent)
            }
        };
        let balance = self.balance(&from);
        if balance < args.amount.e8s {
            return Err(SendError::Insufficient { balance: Tokens { e8s: balance } });
        }
        self.balances.insert(from, balance - args.amount.e8s);
        self.mint(args.to, args.amount.e8s);
        let block = self.blocks;
        self.blocks += 1;
        if let Some(sent) = sent {
            self.seen.insert(sent, block);
        }
        Ok(Nat::from(block))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600_000_000_000;
    fn p(n: u8) -> Principal {
        Principal::from_slice(&[n; 10])
    }
    fn args(e8s: u64, stamp: Option<u64>) -> SendArgs {
        SendArgs { to: p(2), amount: Tokens { e8s }, memo: None, created_at: stamp }
    }
    fn funded() -> State {
        let mut s = State::default();
        s.mint(p(1), INITIAL_E8S);
        s
    }

    #[test]
    fn a_stamped_send_is_executed_once() {
        let mut s = funded();
        let now = 100 * HOUR;
        assert_eq!(s.send(p(1), &args(5, Some(now)), now), Ok(Nat::from(0u64)));
        assert_eq!(s.send(p(1), &args(5, Some(now)), now + 1), Err(SendError::Duplicate { block: Nat::from(0u64) }));
        assert_eq!(s.balance(&p(2)), 5);
        // another memo is another send
        let mut other = args(5, Some(now));
        other.memo = Some(b"x".to_vec());
        assert_eq!(s.send(p(1), &other, now), Ok(Nat::from(1u64)));
    }

    #[test]
    fn a_send_of_nothing_is_refused_and_not_remembered() {
        let mut s = funded();
        for i in 0..100 {
            assert!(matches!(s.send(p(1), &args(0, Some(HOUR + i)), HOUR), Err(SendError::Other(_))));
        }
        assert_eq!(s.remembered(), 0);
    }

    #[test]
    fn what_is_remembered_is_bounded_and_expires() {
        let mut s = funded();
        let now = 100 * HOUR;
        for i in 0..MAX_SEEN as u64 {
            assert!(s.send(p(1), &args(1, Some(now - i)), now).is_ok());
        }
        assert_eq!(s.remembered(), MAX_SEEN);
        let refused = s.send(p(1), &args(1, Some(now + 1)), now);
        assert!(matches!(refused, Err(SendError::Other(ref m)) if m.contains("try again")), "{refused:?}");
        assert!(s.send(p(1), &args(1, None), now).is_ok(), "an unstamped send is not remembered, so it goes through");
        // a day later every entry has expired, and is dropped before the next stamped send
        let later = now + WINDOW_NS + 1;
        assert!(s.send(p(1), &args(1, Some(later)), later).is_ok());
        assert_eq!(s.remembered(), 1);
    }

    #[test]
    fn refusals_move_nothing() {
        let mut s = funded();
        let now = 100 * HOUR;
        assert_eq!(s.send(p(1), &args(1, Some(now - 25 * HOUR)), now), Err(SendError::TooOld));
        assert!(matches!(s.send(p(1), &args(1, Some(now + HOUR)), now), Err(SendError::CreatedInFuture { .. })));
        assert_eq!(s.send(p(2), &args(1, None), now), Err(SendError::Insufficient { balance: Tokens { e8s: 0 } }));
        let mut long = args(1, None);
        long.memo = Some(vec![0; MAX_MEMO + 1]);
        assert!(matches!(s.send(p(1), &long, now), Err(SendError::Other(_))));
        assert_eq!(s.balance(&p(1)), INITIAL_E8S);
        assert_eq!(s.remembered(), 0);
    }
}
