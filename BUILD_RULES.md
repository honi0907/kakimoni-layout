# Build Rules (kakimoni-layout)

- 変更が入った作業は、完了報告前に毎回 `npm run build` を実行する。
- `dist` には最新の Setup のみを残す。
- 旧 Setup は `prebuild` (`scripts/cleanup-dist.js`) で自動削除する。
- リリース時は Setup のみを公開し、Portable は公開しない。
