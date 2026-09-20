#!/usr/bin/env bash
#
# 同步本地已跟踪文件到 GitHub 仓库 —— 一次性单 commit。
#
# 为什么不用 git push：本沙箱代理只放行 api.github.com，拦截 github.com，
# git 协议永远超时，故走 GitHub API。
#
# 为什么不再逐文件 PUT：Contents API 每个文件单独 PUT 就各成一个 commit，
# 一次同步触发 N 次 CI（日志刷屏 + 重复部署）。现在统一走 push-one-commit.mjs，
# 把所有文件塞进同一个 tree/commit，push 事件只发生一次 → CI 只跑一次。
#
# 用法：
#   export GH_TOKEN="ghp_xxx"                            # 需要 repo scope
#   bash scripts/push-gh.sh                              # 同步全部已跟踪文件
#   bash scripts/push-gh.sh src/index.ts public/app.js   # 只同步指定文件
#
# 说明：
#   - 未列出的远端文件由 base_tree 自动继承，不会被删除
#   - 只同步 git 已跟踪的文件，.gitignore 排除的（.dev.vars 等）天然不会上传
#
set -u
cd "$(dirname "$0")/.."

if [ -z "${GH_TOKEN:-}" ]; then
  echo "✗ 请先设置环境变量 GH_TOKEN（GitHub PAT，需 repo scope）"
  exit 1
fi

if [ "$#" -gt 0 ]; then
  exec node scripts/push-one-commit.mjs "$@"
fi

files=()
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] && files+=("$f")
done < <(git ls-files)

if [ "${#files[@]}" -eq 0 ]; then
  echo "✗ 没有可同步的文件"
  exit 1
fi

echo "同步 ${#files[@]} 个已跟踪文件（单 commit，CI 只触发 1 次）…"
exec node scripts/push-one-commit.mjs "${files[@]}"
