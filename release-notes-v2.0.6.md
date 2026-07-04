# OntoIndex v2.0.6

## Highlights
- **Universal Pre/Post Tool Hooks**: `ontoindex setup` now natively configures PreToolUse and PostToolUse integration hooks across Claude Code, Codex, and Ontocode. This guarantees that all platforms automatically benefit from index graph augmentation on `Bash` searches, and receive index-staleness warnings instantly following any `git commit` mutation.
- **Improved LLM Schema Parsing**: Safely stripped validation bounds (`minimum`, `maximum`, `default`, `minLength`) out of the advertised MCP JSON schema in `list_tools`, while preserving strict runtime checking on the server. This prevents strict model integrations (like Gemini) from silently rejecting or hallucinating rich tool bounds.
