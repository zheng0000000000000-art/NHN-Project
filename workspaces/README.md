# External workspaces

Each child directory is an independent Git repository containing one project's Team Loop context, project pack, plans, and handoff state. Child repositories are intentionally ignored by the Team Loop parent repository.

```powershell
npm run workspace -- init --id unknown-auction --title "미지의 경매장" --game-repository "C:/NHN Project/unknown-auction"
npm run workspace -- status --id unknown-auction
npm run workspace -- pull --id unknown-auction
npm run workspace -- push --id unknown-auction
```

The game source remains in its own repository. Workspace repositories must not contain secrets, raw execution logs, worktrees, or generated caches.
