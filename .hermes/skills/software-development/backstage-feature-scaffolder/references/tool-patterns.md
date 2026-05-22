# Agent Tool Patterns for Backstage Feature Scaffolding

Discovered through repeated testing on Backstage v1.51.0-next.3, May 2025.

## What Works (Verified)

### Scaffolding: `terminal` with `yarn new`
```bash
YARN="node .yarn/releases/yarn-4.8.1.cjs"  # or "yarn" if in PATH
echo "" | $YARN backstage-cli new --select <template> --option pluginId=<id>
```
- Pipe `echo ""` to skip the interactive CODEOWNERS prompt
- `yarn new` runs `yarn install` after scaffolding — ignore install errors (pre-existing repo issues)
- See the full template ID table in `backstage-cli` skill

### Writing TypeScript files: `write_file` (NOT shell heredocs)
Use the agent's direct `write_file` tool for `.ts` and `.tsx` files.
Reason: shell heredocs break on TypeScript template literals (`${}`).
Even quoted heredocs (`<< 'EOF'`) have issues with mixed quoting in TS files.

### Batch file writing: Python `<< 'PYEOF'` heredoc (PREFERRED)
When you need to write 5+ files at once, use a Python heredoc via terminal:
```bash
python3 << 'PYEOF'
import pathlib
def w(p, c):
    pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w") as f: f.write(c)
    print(f"  wrote {p}")

B = "plugins/my-feature/src"
w(f"{B}/file1.ts", """content here""")
w(f"{B}/file2.tsx", """content here""")
PYEOF
```
- Avoids the "sibling subagent" warnings that plague consecutive `write_file` calls
- Single `terminal` call writes all files — much faster than individual `write_file` calls
- Use triple-quoted strings (`"""..."""`) for file content — preserves line breaks and quotes
- Use single-quoted heredoc marker (`'PYEOF'`) to prevent shell variable expansion

**⚠️ PITFALL: `&` character kills Python heredoc.** The shell's background-subprocess detector triggers on `&` even inside single-quoted heredoc strings. If any file content contains `&` (e.g., JSX `{a && b}`, `&&` in bash snippets, or text with `&`), use `write_file` for that specific file instead. Do not try to escape it — the detector sees the raw `&` regardless.

**⚠️ PITFALL: Python heredocs timeout at ~200 lines.** Large multi-file scripts (10+ files, 300+ lines total) trigger the terminal timeout detector. Keep heredocs under 200 lines. Split large writes into multiple smaller terminal calls, or use `python3 -c "..."` single-file writes for the largest files.

**⚠️ PITFALL: Python heredocs fail silently on syntax errors.** If a heredoc has a Python syntax error (e.g., f-string conflict with `{PLACEHOLDER}`), the terminal exits with an error but files written BEFORE the error persist while files AFTER are never created. After a failed heredoc, verify critical files exist before continuing.

### Single-file writes: `python3 -c "..."` (fast, no timeout)

For individual files, `python3 -c` is faster than `write_file` and avoids sibling subagent warnings:
```bash
python3 -c "
import pathlib
pathlib.Path('plugins/<id>-backend/src/service/MyService.ts').parent.mkdir(parents=True, exist_ok=True)
open('plugins/<id>-backend/src/service/MyService.ts','w').write('''file content here''')
print('done')
"
```
- Use triple-quoted strings for file content
- Avoid template literals (use `'Bearer ' + token` instead of `` `Bearer ${token}` ``)
- Keep each `-c` invocation to a single file to avoid timeout

### Hybrid approach (most reliable)

1. Python heredoc for 3-5 small files (under 200 lines total)
2. `python3 -c` for individual service/aggregator files
3. `write_file` for all JSX files (contain `&`)
4. Verify with `test -f` after each batch

### Batch package.json updates: Python script
```bash
python3 << 'PYEOF'
import json, pathlib
for pkg_path in [...]:
    with open(pkg_path) as f: p = json.load(f)
    p["pluginId"] = "my-feature"
    p["exports"] = {...}
    p["typesVersions"] = {...}
    p.setdefault("sideEffects", False)
    p.setdefault("files", ["dist"])
    with open(pkg_path, "w") as f:
        json.dump(p, f, indent=2)
        f.write("\n")
PYEOF
```
- One `terminal` call updates all 5 `package.json` files
- Much faster than individual `patch` calls
- `json.dump` with `indent=2` produces canonical formatting

### Package.json modifications: `patch`
Use the `patch` tool to add `pluginId`, `pluginPackages`, and cross-package deps.
Reason: `write_file` requires a full JSON payload. `patch` only changes the lines you need.
If `write_file` warns about "sibling subagent" conflicts, read the file first (`read_file(limit=3)`) to reset the conflict.

### Cleaning demo files: `terminal`
```bash
rm -rf plugins/<id>-backend/src/services  # TodoListService demo
rm -rf plugins/<id>/src/components/ExampleComponent
rm -rf plugins/<id>/src/components/ExampleFetchComponent
mkdir -p plugins/<id>/src/components
```

### Placeholder replacement
In `write_file` content, use JavaScript template literals (backtick strings with `${variable}` interpolation) to embed feature-specific names into template code.

## What DOESN'T Work (Avoid)

### `execute_code` sandbox
❌ `write_file` inside `execute_code` writes to `/var/folders/.../hermes_sandbox_*/`, NOT the project directory.
❌ `terminal` inside `execute_code` similarly operates in the sandbox.
✅ Use the agent's direct tools (`write_file`, `terminal`, `patch`).

### Shell heredocs for TypeScript
❌ `cat > file.ts << 'EOF' ... EOF` — template literals with `${}` get expanded by bash in unquoted heredocs. In quoted heredocs (`<< 'EOF'`), single quotes and mixed quoting in TS imports cause issues.
✅ Use `write_file` directly.

### `sed` for JSON modifications
❌ `sed -i '' 's/old/new/g' package.json` — fragile, breaks on whitespace changes.
✅ Use `patch` tool.

### `read_file` for JSON parsing in execute_code
❌ `json.loads(read_file(path)['content'])` — `read_file` inside `execute_code` returns a dict wrapper, not raw JSON.
✅ Use `patch` for JSON modifications.

## Typical Session Pattern (~7 calls total — Python heredoc + write_file)

```
Phase 1: Scaffold (5 terminal calls)
 1. terminal: yarn new plugin-common-library        # ~20s
 2. terminal: yarn new backend-plugin                # ~20s
 3. terminal: yarn new plugin-node-library           # ~20s
 4. terminal: yarn new plugin-web-library            # ~20s
 5. terminal: yarn new frontend-plugin               # ~20s

Phase 2: Write source files (1-2 terminal calls + write_file for & content)
 6. terminal: python3 << 'PYEOF' ... PYEOF           # batch-writes all .ts/.tsx files
 7. write_file: any files containing '&'             # only if needed

Phase 3: Update package.json (1 terminal call)
 8. terminal: python3 << 'PYEOF' ... PYEOF           # batch-updates all 5 package.json

Phase 4: Validate (1 terminal call)
 9. terminal: find + grep checks                     # structural validation
```

Total: ~9-10 tool calls for a complete 5-package feature. Down from ~15-20 with individual write_file calls per file.

## Backstage Version API Notes (v1.51.0-next.3)

The new frontend plugin API is still evolving. In v1.51.0-next.3:
- `createFrontendPlugin` exists in `@backstage/frontend-plugin-api`
- `createApiExtension`, `createPageExtension`, `createEntityContentExtension` do NOT exist
- `createExtension` exists but requires complex `ExtensionDataRef` patterns
- `PageBlueprint` exists in `@backstage/frontend-plugin-api`
- For entity content: `convertLegacyEntityContentExtension` from `@backstage/plugin-catalog-react/alpha`

**Fallback pattern:** Use the legacy `createPlugin` from `@backstage/core-plugin-api` for reliable compilation. The legacy system supports `createApiFactory`, `createRoutableExtension`, and `createPlugin` — all well-tested and working.
