#!/usr/bin/env bash
#
# 部署 cfse-sync 到测试服务器（192.168.2.2）
#
# 做四件事：
#   ① 打包（排除 .git / cms-package / node_modules）
#   ② 上传并解压到插件目录（先备份旧版本）
#   ③ 服务器 php -l 语法检查
#   ④ 离线测试 + 真实登录态渲染验证
#
# 用法：bash tools/deploy-test-server.sh
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="192.168.2.2"
PLUGDIR="/mnt/optane/webstack/www/wp-content/plugins"
REMOTE_DIR="$PLUGDIR/cfse-sync"
CONTAINER="web-php"
CONTAINER_DIR="/var/www/html/wp-content/plugins/cfse-sync"

cd "$SRC"

echo "=== ① 打包 ==="
PKG="$(cd "$SRC/.." && pwd)/cfse-sync-deploy.tar.gz"
rm -f "$PKG"
tar -czf "$PKG" --exclude=.git --exclude=cms-package --exclude=node_modules .
echo "  $PKG ($(du -h "$PKG" | cut -f1))"

echo "=== ② 上传 ==="
pscp -pw vr50we -batch "$PKG" "root@$HOST:/tmp/cfse-sync-deploy.tar.gz" >/dev/null
echo "  ✓ 已上传"

echo "=== ③ 解压（先备份）==="
ssh_cmd="cd $PLUGDIR && rm -rf cfse-sync.bak-prev && (cp -a cfse-sync cfse-sync.bak-prev 2>/dev/null || true) && rm -rf cfse-sync && mkdir -p cfse-sync && tar -xzf /tmp/cfse-sync-deploy.tar.gz -C cfse-sync && chown -R www-data:www-data cfse-sync && rm -f /tmp/cfse-sync-deploy.tar.gz && echo OK"
plink -ssh -pw vr50we root@$HOST "$ssh_cmd" 2>/dev/null | tail -1
echo "  ✓ 已部署"

echo "=== ④ 语法检查 ==="
for f in cfse-sync.php includes/class-admin-ui.php includes/class-compat.php \
         includes/class-onboarding.php includes/class-release.php \
         includes/class-transports.php includes/class-worker-cms.php \
         test/verify-onboarding.php uninstall.php; do
  out=$(plink -ssh -pw vr50we root@$HOST \
    "docker exec $CONTAINER php -l $CONTAINER_DIR/$f 2>&1" 2>/dev/null | grep -vE "opcache|Warning: PHP Startup")
  case "$out" in
    *"No syntax errors"*) printf "  ✓ %s\n" "$f" ;;
    *) printf "  ✗ %s\n%s\n" "$f" "$out"; exit 1 ;;
  esac
done

echo "=== ⑤ PHP 模式断点检查 ==="
node tools/check-php-modes.mjs cfse-sync.php includes/*.php uninstall.php

echo "=== ⑥ 离线测试 ==="
plink -ssh -pw vr50we root@$HOST \
  "docker exec $CONTAINER php $CONTAINER_DIR/test/verify-onboarding.php 2>&1" \
  2>/dev/null | grep -vE "opcache|Warning: PHP Startup" | tail -3

echo "=== ⑦ 真实登录态渲染 ==="
plink -ssh -pw vr50we root@$HOST \
  "docker exec $CONTAINER php $CONTAINER_DIR/test/render-settings.php 2>&1" \
  2>/dev/null | grep -vE "opcache|Warning: PHP Startup" | grep -E "渲染|错误|状态|连接"

echo
echo "✓ 部署完成"
echo "  插件目录: $REMOTE_DIR"
echo "  旧版本备份: $PLUGDIR/cfse-sync.bak-prev"
echo "  激活状态请用 test/switch-plugin.php 切换（直接 UPDATE 会被 alloptions 缓存挡住）"
