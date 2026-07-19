# External agent connection through MCP

External agents use MCP as the only Team Loop connection. They do not mount or refer to the server's `C:\NHN Project` paths and do not need a local clone of either project.

## Requirements and login

- Node.js 20 or newer
- HTTP access to the Team Loop server
- A Team Loop member account
- An MCP-capable client such as Claude Code or Codex

```powershell
npx --yes --package=github:zheng0000000000000-art/NHN-Project team-loop --server http://desktop-4flj7lg.tail20618c.ts.net:4173 login --name YOUR_NAME
```

## MCP configuration

```json
{
  "mcpServers": {
    "team-loop": {
      "command": "npx",
      "args": ["--yes", "--package=github:zheng0000000000000-art/NHN-Project", "team-loop-mcp"],
      "env": { "TEAM_LOOP_URL": "http://desktop-4flj7lg.tail20618c.ts.net:4173" }
    }
  }
}
```

## Agent workflow

1. `get_project_context`
2. `list_tasks`, `show_task`, `list_skills`, and `list_harnesses`
3. `claim_task`
4. `read_task_files`
5. Prepare changed UTF-8 text files locally
6. `submit_task_result`
7. `verify_task`
8. Fix and resubmit on failure, or `request_review_task` on success

`submit_task_result` requires a work summary and learning disposition. State which existing skill or harness was reused, which failure was recorded, or why no reusable failure occurred.

## Limits

- Up to 50 files per request
- Up to 256 KiB per file and 512 KiB total
- UTF-8 text only; no binary files or symbolic links
- Every path must match the task's `allowedPaths`
- A stale `baseCommit` is rejected
- Harness and skill administration remains on the server side

Large assets remain a separate future transport concern. Do not encode images or build artifacts as base64 in MCP submissions.
