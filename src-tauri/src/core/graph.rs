//! Lane layout for the commit graph. Column 0 belongs to the integration
//! branch's first-parent chain; everything else is placed from column 1.
//!
//! The layout is streaming: `Lanes` carries its state from one row to the next, so history can be
//! loaded page by page and each page only lays out its own rows.

use std::collections::HashSet;

pub const PASS: u16 = 0;
pub const IN: u16 = 1;
pub const OUT: u16 = 2;

/// Colours 1..=PALETTE cycle for side lanes; 0 is the trunk.
const PALETTE: u8 = 6;

#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    pub col: u16,
    pub color: u8,
    pub segs: Vec<[u16; 4]>,
}

#[derive(Clone, Debug)]
struct Lane {
    target: String,
    color: u8,
}

#[derive(Clone, Debug)]
pub struct Lanes {
    lanes: Vec<Option<Lane>>,
    next_color: u8,
    /// The next commit expected on the trunk's first-parent chain.
    next_trunk: Option<String>,
}

impl Lanes {
    pub fn new(trunk_tip: Option<&str>) -> Self {
        Self { lanes: vec![None], next_color: 1, next_trunk: trunk_tip.map(str::to_string) }
    }

    /// The trunk commit the next rows are waiting for (the uncommitted-work row uses it).
    pub fn expects_trunk(&self, id: &str) -> bool {
        self.next_trunk.as_deref() == Some(id)
    }

    /// No trunk line runs through column 0 at this point (true above the trunk tip).
    pub fn trunk_lane_free(&self) -> bool {
        self.lanes.first().is_none_or(|l| l.is_none())
    }

    fn free_from(&self, from: usize) -> usize {
        (from..self.lanes.len()).find(|&k| self.lanes[k].is_none()).unwrap_or(self.lanes.len().max(from))
    }

    fn ensure(&mut self, k: usize) {
        while self.lanes.len() <= k {
            self.lanes.push(None);
        }
    }

    fn alloc_color(&mut self, reserve: Option<u8>) -> u8 {
        let mut used: HashSet<u8> = self.lanes.iter().flatten().map(|l| l.color).collect();
        if let Some(c) = reserve {
            used.insert(c);
        }
        for step in 0..PALETTE {
            let candidate = (self.next_color - 1 + step) % PALETTE + 1;
            if !used.contains(&candidate) {
                self.next_color = candidate % PALETTE + 1;
                return candidate;
            }
        }
        let candidate = self.next_color;
        self.next_color = self.next_color % PALETTE + 1;
        candidate
    }

    /// Place one row. Rows must come in topological order (children before parents).
    /// `pin_to_trunk` puts a row in column 0 without advancing the trunk chain (uncommitted work on
    /// top of the trunk tip).
    pub fn place(&mut self, id: &str, parents: &[String], pin_to_trunk: bool) -> Placed {
        let on_chain = !pin_to_trunk && self.expects_trunk(id);
        let on_trunk = on_chain || pin_to_trunk;
        if on_chain {
            self.next_trunk = parents.first().cloned();
        }
        let (col, color) = if on_trunk {
            (0usize, 0u8)
        } else {
            let existing = self
                .lanes
                .iter()
                .enumerate()
                .skip(1)
                .find_map(|(k, l)| l.as_ref().filter(|l| l.target == id).map(|l| (k, l.color)));
            match existing {
                Some(found) => found,
                None => {
                    let k = self.free_from(1);
                    self.ensure(k);
                    (k, self.alloc_color(None))
                }
            }
        };

        let mut segs: Vec<[u16; 4]> = Vec::new();
        for (k, lane) in self.lanes.iter().enumerate() {
            if let Some(lane) = lane {
                let kind = if lane.target == id { IN } else { PASS };
                let to = if kind == IN { col } else { k };
                segs.push([kind, k as u16, to as u16, lane.color as u16]);
            }
        }
        for lane in self.lanes.iter_mut() {
            if lane.as_ref().is_some_and(|l| l.target == id) {
                *lane = None;
            }
        }

        for (i, parent) in parents.iter().enumerate() {
            let (pc, pcolor) = if i == 0 {
                (col, color)
            } else {
                let k = self.free_from((col + 1).max(1));
                self.ensure(k);
                (k, self.alloc_color(Some(color)))
            };
            self.ensure(pc);
            self.lanes[pc] = Some(Lane { target: parent.clone(), color: pcolor });
            segs.push([OUT, col as u16, pc as u16, pcolor as u16]);
        }

        while self.lanes.len() > 1 && self.lanes.last().is_some_and(|l| l.is_none()) {
            self.lanes.pop();
        }
        Placed { col: col as u16, color, segs }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(spec: &[(&str, &[&str])], trunk_tip: &str) -> Vec<(String, Placed)> {
        let mut lanes = Lanes::new(Some(trunk_tip));
        spec.iter()
            .map(|(id, ps)| {
                let parents: Vec<String> = ps.iter().map(|s| s.to_string()).collect();
                (id.to_string(), lanes.place(id, &parents, false))
            })
            .collect()
    }

    fn col(placed: &[(String, Placed)], id: &str) -> u16 {
        placed.iter().find(|(k, _)| k == id).unwrap().1.col
    }

    #[test]
    fn trunk_stays_in_column_zero_with_branch_on_top() {
        let placed = run(&[("b2", &["b1"]), ("b1", &["m1"]), ("m2", &["m1"]), ("m1", &["m0"]), ("m0", &[])], "m2");
        assert_eq!(col(&placed, "b2"), 1);
        assert_eq!(col(&placed, "b1"), 1);
        for id in ["m2", "m1", "m0"] {
            assert_eq!(col(&placed, id), 0);
        }
        let m1 = &placed.iter().find(|(k, _)| k == "m1").unwrap().1;
        assert!(m1.segs.iter().any(|s| s[0] == IN && s[1] == 1 && s[2] == 0));
    }

    #[test]
    fn merged_branch_leaves_column_zero_free() {
        let placed = run(&[("m2", &["m1", "f2"]), ("f2", &["f1"]), ("m1", &["m0"]), ("f1", &["m0"]), ("m0", &[])], "m2");
        assert_eq!(col(&placed, "m2"), 0);
        assert_eq!(col(&placed, "f2"), 1);
        assert_eq!(col(&placed, "f1"), 1);
        assert_eq!(col(&placed, "m1"), 0);
        for (id, p) in &placed {
            if id.starts_with('f') {
                assert_ne!(p.color, 0, "side lanes never use the trunk colour");
            }
        }
    }

    #[test]
    fn branch_that_merged_main_in_keeps_trunk_left() {
        let placed = run(
            &[("m2", &["m1", "c3"]), ("c3", &["c2m"]), ("c2m", &["c2", "m1"]), ("m1", &["m0"]), ("c2", &["c1"]), ("c1", &["m0"]), ("m0", &[])],
            "m2",
        );
        for id in ["m2", "m1", "m0"] {
            assert_eq!(col(&placed, id), 0, "{id}");
        }
        for id in ["c3", "c2m", "c2", "c1"] {
            assert!(col(&placed, id) >= 1, "{id}");
        }
    }

    #[test]
    fn no_row_reuses_a_column_that_is_still_live() {
        let placed = run(
            &[("x2", &["x1"]), ("y1", &["m2"]), ("m3", &["m2", "z1"]), ("z1", &["m1"]), ("x1", &["m1"]), ("m2", &["m1"]), ("m1", &[])],
            "m3",
        );
        assert_ne!(col(&placed, "x1"), col(&placed, "z1"));
    }

    #[test]
    fn paging_gives_the_same_layout_as_one_pass() {
        let spec: &[(&str, &[&str])] =
            &[("m3", &["m2", "f2"]), ("f2", &["f1"]), ("m2", &["m1"]), ("f1", &["m1"]), ("m1", &["m0"]), ("m0", &[])];
        let whole = run(spec, "m3");
        // Same rows fed in two pages through one carried-over state.
        let mut lanes = Lanes::new(Some("m3"));
        let mut paged = Vec::new();
        for page in spec.chunks(2) {
            for (id, ps) in page {
                let parents: Vec<String> = ps.iter().map(|s| s.to_string()).collect();
                paged.push((id.to_string(), lanes.place(id, &parents, false)));
            }
        }
        assert_eq!(whole, paged);
    }

    #[test]
    fn uncommitted_row_on_the_trunk_tip_is_pinned_left() {
        let mut lanes = Lanes::new(Some("m1"));
        let wt = lanes.place("WORKTREE", &["m1".to_string()], true);
        let m1 = lanes.place("m1", &["m0".to_string()], false);
        assert_eq!((wt.col, m1.col), (0, 0));
        assert!(lanes.expects_trunk("m0"));
    }
}
