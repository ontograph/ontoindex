use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};

pub mod heritage;

fn write_line(out: &mut impl Write, line: &str) -> std::io::Result<()> {
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")
}

fn write_csv_lines_impl(csv_path: &str, header: &str, rows: &[String]) -> std::io::Result<u32> {
    let file = File::create(csv_path)?;
    let mut out = BufWriter::new(file);
    write_line(&mut out, header)?;
    for row in rows {
        write_line(&mut out, row)?;
    }
    out.flush()?;
    Ok(rows.len() as u32)
}

fn escape_csv_field(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn write_csv_records_impl(
    csv_path: &str,
    headers: &[String],
    records: &[Vec<String>],
) -> std::io::Result<u32> {
    let file = File::create(csv_path)?;
    let mut out = BufWriter::new(file);
    write_line(&mut out, &headers.join(","))?;
    for record in records {
        let row = record
            .iter()
            .map(|field| escape_csv_field(field))
            .collect::<Vec<_>>()
            .join(",");
        write_line(&mut out, &row)?;
    }
    out.flush()?;
    Ok(records.len() as u32)
}

#[napi(js_name = "writeCsvLines")]
pub fn write_csv_lines(csv_path: String, header: String, rows: Vec<String>) -> Result<u32> {
    write_csv_lines_impl(&csv_path, &header, &rows)
        .map_err(|err| Error::from_reason(format!("failed to write native CSV {csv_path}: {err}")))
}

#[napi(js_name = "writeCsvRecords")]
pub fn write_csv_records(
    csv_path: String,
    headers: Vec<String>,
    records: Vec<Vec<String>>,
) -> Result<u32> {
    write_csv_records_impl(&csv_path, &headers, &records)
        .map_err(|err| Error::from_reason(format!("failed to write native CSV {csv_path}: {err}")))
}

#[napi(object)]
pub struct RankedKey {
    pub key: String,
    pub score: f64,
}

#[napi(js_name = "mergeRrfKeys")]
pub fn merge_rrf_keys(
    bm25_keys: Vec<String>,
    semantic_keys: Vec<String>,
    limit: u32,
) -> Vec<RankedKey> {
    let mut scores: HashMap<String, f64> = HashMap::new();
    for (index, key) in bm25_keys.into_iter().enumerate() {
        *scores.entry(key).or_insert(0.0) += 1.0 / (60.0 + index as f64 + 1.0);
    }
    for (index, key) in semantic_keys.into_iter().enumerate() {
        *scores.entry(key).or_insert(0.0) += 1.0 / (60.0 + index as f64 + 1.0);
    }

    let mut ranked = scores
        .into_iter()
        .map(|(key, score)| RankedKey { key, score })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.key.cmp(&right.key))
    });
    ranked.truncate(limit as usize);
    ranked
}

fn split_identifier(token: &str) -> Option<String> {
    if token.contains('_') {
        let parts = token
            .split('_')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if parts.len() > 1 {
            return Some(parts.join(" "));
        }
    }
    if token.contains('-') {
        let parts = token
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if parts.len() > 1 {
            return Some(parts.join(" "));
        }
    }

    let chars = token.chars().collect::<Vec<_>>();
    let mut out = String::new();
    let mut changed = false;
    for i in 0..chars.len() {
        if i > 0 {
            let prev = chars[i - 1];
            let current = chars[i];
            let next = chars.get(i + 1).copied();
            let lower_to_upper = prev.is_ascii_lowercase() && current.is_ascii_uppercase();
            let acronym_boundary = prev.is_ascii_uppercase()
                && current.is_ascii_uppercase()
                && next.is_some_and(|c| c.is_ascii_lowercase());
            if lower_to_upper || acronym_boundary {
                out.push(' ');
                changed = true;
            }
        }
        out.push(chars[i]);
    }
    changed.then_some(out)
}

#[napi(js_name = "expandQueryTokens")]
pub fn expand_query_tokens(query: String) -> String {
    if query.is_empty() {
        return query;
    }
    let tokens = query.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return query;
    }
    let mut expanded = Vec::new();
    for token in tokens {
        expanded.push(token.to_string());
        if let Some(split) = split_identifier(token) {
            expanded.push(split);
        }
    }
    expanded.join(" ")
}

#[napi(object)]
pub struct GraphEntry {
    pub node: String,
    pub children: Vec<String>,
}

#[napi(object)]
pub struct SccEntry {
    pub nodes: Vec<String>,
    pub is_cycle: bool,
}

#[napi(object)]
pub struct SourceFileInput {
    pub file_path: String,
    pub content: String,
}

#[napi(object)]
pub struct NativeContractRecord {
    pub contract_id: String,
    pub kind: String,
    pub role: String,
    pub file_path: String,
    pub method: Option<String>,
    pub path: Option<String>,
}

fn normalize_http_path(path: &str) -> String {
    let mut normalized = path
        .split('?')
        .next()
        .unwrap_or(path)
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    if normalized.is_empty() {
        normalized = "/".to_string();
    }
    let segments = normalized
        .split('/')
        .map(|segment| {
            if segment.starts_with(':') || (segment.starts_with('{') && segment.ends_with('}')) {
                "{param}"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>();
    segments.join("/")
}

fn read_quoted_after<'a>(content: &'a str, marker: &str) -> Option<&'a str> {
    let start = content.find(marker)? + marker.len();
    let rest = content[start..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '\'' && quote != '"' && quote != '`' {
        return None;
    }
    let body = &rest[quote.len_utf8()..];
    let end = body.find(quote)?;
    Some(&body[..end])
}

fn scan_source_http_contracts(file_path: &str, content: &str) -> Vec<NativeContractRecord> {
    let mut out = Vec::new();
    let provider_markers = [
        ("router.get(", "GET"),
        ("router.post(", "POST"),
        ("router.put(", "PUT"),
        ("router.delete(", "DELETE"),
        ("router.patch(", "PATCH"),
    ];
    for (marker, method) in provider_markers {
        let mut offset = 0;
        while let Some(found) = content[offset..].find(marker) {
            let absolute = offset + found;
            if let Some(raw_path) = read_quoted_after(&content[absolute..], marker) {
                let path = normalize_http_path(raw_path);
                out.push(NativeContractRecord {
                    contract_id: format!("http::{method}::{path}"),
                    kind: "http".to_string(),
                    role: "provider".to_string(),
                    file_path: file_path.to_string(),
                    method: Some(method.to_string()),
                    path: Some(path),
                });
            }
            offset = absolute + marker.len();
        }
    }

    let mut offset = 0;
    while let Some(found) = content[offset..].find("fetch(") {
        let absolute = offset + found;
        if let Some(raw_path) = read_quoted_after(&content[absolute..], "fetch(") {
            let call_end = content[absolute..]
                .find(')')
                .unwrap_or(content.len() - absolute);
            let call = &content[absolute..absolute + call_end];
            let method = if call.contains("method: 'POST'") || call.contains("method: \"POST\"") {
                "POST"
            } else if call.contains("method: 'PUT'") || call.contains("method: \"PUT\"") {
                "PUT"
            } else if call.contains("method: 'DELETE'") || call.contains("method: \"DELETE\"") {
                "DELETE"
            } else if call.contains("method: 'PATCH'") || call.contains("method: \"PATCH\"") {
                "PATCH"
            } else {
                "GET"
            };
            let path = normalize_http_path(raw_path);
            out.push(NativeContractRecord {
                contract_id: format!("http::{method}::{path}"),
                kind: "http".to_string(),
                role: "consumer".to_string(),
                file_path: file_path.to_string(),
                method: Some(method.to_string()),
                path: Some(path),
            });
        }
        offset = absolute + "fetch(".len();
    }

    out
}

#[napi(js_name = "scanHttpContracts")]
pub fn scan_http_contracts(files: Vec<SourceFileInput>) -> Vec<NativeContractRecord> {
    files
        .iter()
        .flat_map(|file| scan_source_http_contracts(&file.file_path, &file.content))
        .collect()
}

#[napi(js_name = "tarjanSccs")]
pub fn tarjan_sccs(entries: Vec<GraphEntry>) -> Vec<SccEntry> {
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    for entry in entries {
        let mut children = entry.children;
        children.sort();
        graph.insert(entry.node, children);
    }

    let mut index: HashMap<String, usize> = HashMap::new();
    let mut lowlink: HashMap<String, usize> = HashMap::new();
    let mut on_stack: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = Vec::new();
    let mut sccs = Vec::new();
    let mut idx = 0usize;

    let mut roots = graph.keys().cloned().collect::<Vec<_>>();
    roots.sort();
    for root in roots {
        if index.contains_key(&root) {
            continue;
        }
        strongconnect(
            &root,
            &graph,
            &mut index,
            &mut lowlink,
            &mut on_stack,
            &mut stack,
            &mut sccs,
            &mut idx,
        );
    }
    sccs
}

#[allow(clippy::too_many_arguments)]
fn strongconnect(
    node: &str,
    graph: &HashMap<String, Vec<String>>,
    index: &mut HashMap<String, usize>,
    lowlink: &mut HashMap<String, usize>,
    on_stack: &mut HashSet<String>,
    stack: &mut Vec<String>,
    sccs: &mut Vec<SccEntry>,
    idx: &mut usize,
) {
    index.insert(node.to_string(), *idx);
    lowlink.insert(node.to_string(), *idx);
    *idx += 1;
    stack.push(node.to_string());
    on_stack.insert(node.to_string());

    for child in graph.get(node).into_iter().flatten() {
        if !index.contains_key(child) {
            strongconnect(child, graph, index, lowlink, on_stack, stack, sccs, idx);
            let current = lowlink[node];
            let child_low = lowlink[child];
            lowlink.insert(node.to_string(), current.min(child_low));
        } else if on_stack.contains(child) {
            let current = lowlink[node];
            let child_index = index[child];
            lowlink.insert(node.to_string(), current.min(child_index));
        }
    }

    if lowlink[node] == index[node] {
        let mut component = Vec::new();
        loop {
            let item = stack.pop().expect("tarjan stack underflow");
            on_stack.remove(&item);
            let done = item == node;
            component.push(item);
            if done {
                break;
            }
        }
        let is_self_cycle = component.len() == 1
            && graph
                .get(&component[0])
                .is_some_and(|children| children.iter().any(|child| child == &component[0]));
        let is_cycle = component.len() > 1 || is_self_cycle;
        sccs.push(SccEntry {
            nodes: component,
            is_cycle,
        });
    }
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeGraphNode {
    pub id: String,
    pub label: String,
    pub properties: HashMap<String, String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeGraphRelationship {
    pub fromId: String,
    pub toId: String,
    pub relType: String,
    pub fromLabel: String,
    pub toLabel: String,
    pub properties: HashMap<String, String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NativeImport {
    pub file_path: String,
    pub raw_import_path: String,
    pub language: String,
}

fn get_node_header(label: &str) -> Vec<&'static str> {
    match label {
        "File" => vec!["id", "name", "filePath", "content"],
        "Folder" => vec!["id", "name", "filePath"],
        "Method" => vec!["id", "name", "filePath", "startLine", "endLine", "isExported", "content", "description", "parameterCount", "returnType"],
        "Community" => vec!["id", "label", "heuristicLabel", "keywords", "description", "enrichedBy", "cohesion", "symbolCount"],
        "Process" => vec!["id", "label", "heuristicLabel", "processType", "stepCount", "communities", "entryPointId", "terminalId"],
        "Section" => vec!["id", "name", "filePath", "startLine", "endLine", "level", "content", "description"],
        "Route" => vec!["id", "name", "filePath", "responseKeys", "errorKeys", "middleware"],
        "Tool" => vec!["id", "name", "filePath", "description"],
        "Function" | "Class" | "Interface" | "CodeElement" | "Const" => vec!["id", "name", "filePath", "startLine", "endLine", "isExported", "content", "description"],
        _ => vec!["id", "name", "filePath", "startLine", "endLine", "content", "description"],
    }
}

fn get_rel_header() -> Vec<&'static str> {
    vec!["fromId", "toId", "relType", "confidence", "reason", "step"]
}

#[napi]
pub fn write_graph_batch_native(
    csv_dir: String,
    nodes: Vec<NativeGraphNode>,
    relationships: Vec<NativeGraphRelationship>,
) -> Result<()> {
    let base_path = std::path::Path::new(&csv_dir);
    
    // 1. Process Nodes
    for node in nodes {
        let file_name = format!("nodes_{}.csv", node.label);
        let path = base_path.join(&file_name);
        let file_exists = path.exists();
        
        let file = File::options().append(true).create(true).open(&path)
            .map_err(|e| Error::from_reason(format!("Failed to open node CSV {}: {}", path.display(), e)))?;
        let mut out = BufWriter::new(file);

        let header_fields = get_node_header(&node.label);
        if !file_exists {
            write_line(&mut out, &header_fields.join(","))?;
        }

        let mut row = Vec::new();
        for field in header_fields {
            let val = if field == "id" {
                node.id.as_str()
            } else {
                node.properties.get(field).map(|s| s.as_str()).unwrap_or("")
            };
            row.push(escape_csv_field(val));
        }
        write_line(&mut out, &row.join(","))?;
    }

    // 2. Process Relationships (Direct Splitting)
    for rel in relationships {
        let pair_key = format!("{}|{}", rel.fromLabel, rel.toLabel);
        let file_name = format!("rels_{}.csv", pair_key.replace('|', "_to_"));
        let path = base_path.join(&file_name);
        let file_exists = path.exists();

        let file = File::options().append(true).create(true).open(&path)
            .map_err(|e| Error::from_reason(format!("Failed to open rel CSV {}: {}", path.display(), e)))?;
        let mut out = BufWriter::new(file);

        let header_fields = get_rel_header();
        if !file_exists {
            write_line(&mut out, &header_fields.join(","))?;
        }

        let mut row = Vec::new();
        row.push(escape_csv_field(&rel.fromId));
        row.push(escape_csv_field(&rel.toId));
        row.push(escape_csv_field(&rel.relType));
        row.push(escape_csv_field(rel.properties.get("confidence").map(|s| s.as_str()).unwrap_or("1.0")));
        row.push(escape_csv_field(rel.properties.get("reason").map(|s| s.as_str()).unwrap_or("")));
        row.push(escape_csv_field(rel.properties.get("step").map(|s| s.as_str()).unwrap_or("0")));
        
        write_line(&mut out, &row.join(","))?;
    }

    Ok(())
}

#[napi]
pub fn extract_imports_native(file_path: String, content: String, language_id: String) -> Vec<NativeImport> {
    let mut parser = tree_sitter::Parser::new();
    let language = match language_id.as_str() {
        "javascript" => tree_sitter_javascript::language(),
        "typescript" => tree_sitter_typescript::language_typescript(),
        _ => return vec![],
    };
    parser.set_language(&language).expect("Error loading language");

    let tree = parser.parse(&content, None).expect("Error parsing");
    let mut imports = Vec::new();

    let query_str = match language_id.as_str() {
        "javascript" | "typescript" => {
            r#"
            (import_statement (string (string_fragment) @path))
            (import_statement (string) @path)
            (export_statement (string (string_fragment) @path))
            (export_statement (string) @path)
            "#
        }
        _ => return vec![],
    };

    let query = tree_sitter::Query::new(&language, query_str).expect("Error loading query");
    let mut cursor = tree_sitter::QueryCursor::new();
    let matches = cursor.matches(&query, tree.root_node(), content.as_bytes());

    for m in matches {
        for capture in m.captures {
            let mut path = capture.node.utf8_text(content.as_bytes()).unwrap_or("").to_string();
            // Strip quotes if they were captured
            if path.starts_with('"') || path.starts_with('\'') {
                path = path[1..path.len() - 1].to_string();
            }
            imports.push(NativeImport {
                file_path: file_path.clone(),
                raw_import_path: path,
                language: language_id.clone(),
            });
        }
    }

    imports
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn writes_header_rows_and_trailing_newlines_byte_for_byte() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ontoindex-native-csv-{suffix}.csv"));
        let rows = vec![
            "\"1\",\"plain\"".to_string(),
            "\"2\",\"say \"\"hello\"\"\"".to_string(),
            "\"3\",\"line1\nline2\"".to_string(),
        ];

        let written = write_csv_lines_impl(path.to_str().unwrap(), "id,name", &rows).unwrap();

        assert_eq!(written, 3);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "id,name\n\"1\",\"plain\"\n\"2\",\"say \"\"hello\"\"\"\n\"3\",\"line1\nline2\"\n"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn writes_normalized_field_records_with_rfc4180_escaping() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ontoindex-native-csv-records-{suffix}.csv"));
        let headers = vec!["id".to_string(), "name".to_string(), "content".to_string()];
        let records = vec![
            vec!["1".to_string(), "alpha".to_string(), "plain".to_string()],
            vec![
                "2".to_string(),
                "quote".to_string(),
                "say \"hello\"".to_string(),
            ],
            vec![
                "3".to_string(),
                "multiline".to_string(),
                "line1\nline2".to_string(),
            ],
        ];

        let written = write_csv_records_impl(path.to_str().unwrap(), &headers, &records).unwrap();

        assert_eq!(written, 3);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "id,name,content\n\"1\",\"alpha\",\"plain\"\n\"2\",\"quote\",\"say \"\"hello\"\"\"\n\"3\",\"multiline\",\"line1\nline2\"\n"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn merges_rrf_keys_deterministically() {
        let ranked = merge_rrf_keys(
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["c".to_string(), "b".to_string(), "d".to_string()],
            3,
        );

        assert_eq!(ranked[0].key, "c");
        assert_eq!(ranked[1].key, "b");
        assert_eq!(ranked.len(), 3);
    }

    #[test]
    fn expands_identifier_query_tokens() {
        assert_eq!(
            expand_query_tokens("mergeWithRRF".to_string()),
            "mergeWithRRF merge With RRF"
        );
        assert_eq!(
            expand_query_tokens("pool_adapter".to_string()),
            "pool_adapter pool adapter"
        );
        assert_eq!(
            expand_query_tokens("URLParser".to_string()),
            "URLParser URL Parser"
        );
        assert_eq!(
            expand_query_tokens("merge with rrf".to_string()),
            "merge with rrf"
        );
    }

    #[test]
    fn computes_deterministic_sccs() {
        let sccs = tarjan_sccs(vec![
            GraphEntry {
                node: "a".to_string(),
                children: vec!["b".to_string()],
            },
            GraphEntry {
                node: "b".to_string(),
                children: vec!["a".to_string(), "c".to_string()],
            },
            GraphEntry {
                node: "c".to_string(),
                children: vec![],
            },
            GraphEntry {
                node: "d".to_string(),
                children: vec!["d".to_string()],
            },
        ]);

        assert_eq!(sccs[0].nodes, vec!["c"]);
        assert!(!sccs[0].is_cycle);
        assert_eq!(sccs[1].nodes, vec!["b", "a"]);
        assert!(sccs[1].is_cycle);
        assert_eq!(sccs[2].nodes, vec!["d"]);
        assert!(sccs[2].is_cycle);
    }

    #[test]
    fn scans_http_contract_subset_to_normalized_records() {
        let records = scan_http_contracts(vec![SourceFileInput {
            file_path: "src/routes.ts".to_string(),
            content: r#"
const router = Router();
router.get("/api/users/:id", handler);
await fetch("/api/orders/123", { method: "POST" });
"#
            .to_string(),
        }]);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].contract_id, "http::GET::/api/users/{param}");
        assert_eq!(records[0].role, "provider");
        assert_eq!(records[1].contract_id, "http::POST::/api/orders/123");
        assert_eq!(records[1].role, "consumer");
    }

    #[test]
    fn extracts_imports_from_javascript() {
        let imports = extract_imports_native(
            "test.js".to_string(),
            r#"import { a } from "./a"; import b from "./b";"#.to_string(),
            "javascript".to_string(),
        );
        assert_eq!(imports.len(), 2);
        assert_eq!(imports[0].raw_import_path, "./a");
        assert_eq!(imports[1].raw_import_path, "./b");
    }

    #[test]
    fn writes_native_graph_batches_to_split_files() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let csv_dir = std::env::temp_dir().join(format!("ontoindex-native-batch-{suffix}"));
        fs::create_dir_all(&csv_dir).unwrap();

        let nodes = vec![
            NativeGraphNode {
                id: "File:src/a.ts".to_string(),
                label: "File".to_string(),
                properties: HashMap::from([
                    ("name".to_string(), "a.ts".to_string()),
                    ("filePath".to_string(), "src/a.ts".to_string()),
                    ("content".to_string(), "console.log('a')".to_string()),
                ]),
            },
        ];

        let relationships = vec![
            NativeGraphRelationship {
                fromId: "File:src/a.ts".to_string(),
                toId: "File:src/b.ts".to_string(),
                relType: "DEPENDS_ON".to_string(),
                fromLabel: "File".to_string(),
                toLabel: "File".to_string(),
                properties: HashMap::new(),
            },
        ];

        write_graph_batch_native(csv_dir.to_str().unwrap().to_string(), nodes, relationships).unwrap();

        assert!(csv_dir.join("nodes_File.csv").exists());
        assert!(csv_dir.join("rels_File_to_File.csv").exists());
        
        let _ = fs::remove_dir_all(csv_dir);
    }
}
