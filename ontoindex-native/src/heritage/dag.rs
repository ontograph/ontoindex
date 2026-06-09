use std::collections::{HashMap, HashSet};
use napi_derive::napi;

#[napi]
pub struct NativeHeritageMap {
    // child_id -> Vec<parent_id>
    parents: HashMap<String, Vec<String>>,
    // parent_id -> Vec<child_id>
    children: HashMap<String, Vec<String>>,
}

#[napi]
impl NativeHeritageMap {
    #[napi(constructor)]
    pub fn new() -> Self {
        NativeHeritageMap {
            parents: HashMap::new(),
            children: HashMap::new(),
        }
    }

    #[napi]
    pub fn add_relation(&mut self, child_id: String, parent_id: String) {
        self.parents.entry(child_id.clone()).or_default().push(parent_id.clone());
        self.children.entry(parent_id).or_default().push(child_id);
    }

    #[napi]
    pub fn get_parents(&self, child_id: String) -> Vec<String> {
        self.parents.get(&child_id).cloned().unwrap_or_default()
    }

    #[napi]
    pub fn get_ancestors(&self, child_id: String) -> Vec<String> {
        let mut ancestors = Vec::new();
        let mut stack = vec![child_id];
        let mut visited = HashSet::new();

        while let Some(current) = stack.pop() {
            if !visited.insert(current.clone()) {
                continue;
            }
            if let Some(parents) = self.parents.get(&current) {
                for parent in parents {
                    ancestors.push(parent.clone());
                    stack.push(parent.clone());
                }
            }
        }
        ancestors
    }

    #[napi]
    pub fn is_subclass_of(&self, child_id: String, parent_id: String) -> bool {
        let mut stack = vec![child_id];
        let mut visited = HashSet::new();

        while let Some(current) = stack.pop() {
            if current == parent_id {
                return true;
            }
            if !visited.insert(current.clone()) {
                continue;
            }
            if let Some(parents) = self.parents.get(&current) {
                for p in parents {
                    stack.push(p.clone());
                }
            }
        }
        false
    }
}
