# Project packs

Project packs keep project-specific planning on a project branch without committing Team Loop runtime data.

They include task titles, scope, completion criteria, schedules, assignee/reviewer names, referenced harnesses, and referenced skills. They intentionally exclude passwords, audit logs, command output, verification results, failure events, and other runtime state.

## Export

```powershell
npm run project:pack -- export --id unknown-auction --title "미지의 경매장" --repository "C:/NHN Project/unknown-auction" --output project-packs/unknown-auction.json
```

## Import

Import maps assignees and reviewers by their local user names and resets tasks to `READY`. The first invocation is a preview.

```powershell
npm run project:pack -- import --input project-packs/unknown-auction.json
npm run project:pack -- import --input project-packs/unknown-auction.json --apply
```

Applying creates a timestamped backup of `data/tasks.json`. Existing tasks from other project packs are preserved.
