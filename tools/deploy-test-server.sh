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

# 重复副本门禁（2026-10-27）：同一远端 wp_id 被多篇 WP 文章指向时，
#   ① 拉取（覆盖）不能挑中回收站那份
#   ② 清空回收站不能把保留篇的 D1 行一起删掉
# 库里没有重复副本时脚本自报 SKIP、退出码 0，不阻断部署。
echo "=== ⑥b 重复副本保护 ==="
dup_out=$(plink -ssh -pw vr50we root@$HOST \
  "docker exec $CONTAINER php $CONTAINER_DIR/test/verify-dup-safety.php 2>&1" 2>/dev/null \
  | grep -vE "opcache|Warning: PHP Startup" || true)
printf "%s\n" "$dup_out" | tail -4
case "$dup_out" in
  *"✗"*) echo "  ✗ 重复副本保护断言失败"; exit 1 ;;
esac

# 单篇同步面板（2026-10-27）：按归属显示对应动作，且不再把「什么都没写」报成成功。
#   ① 发布框不再挂「重新同步」按钮  ② CMS 掌管篇只给版本检查  ③ WP 掌管篇只给重新同步
#   ④ CMS 掌管篇同步必须返回 'skipped'，且不刷新 _cfse_synced_d1
echo "=== ⑥c 单篇同步面板 ==="
panel_out=$(plink -ssh -pw vr50we root@$HOST \
  "docker exec $CONTAINER php $CONTAINER_DIR/test/verify-sync-panel.php 2>&1" 2>/dev/null \
  | grep -vE "opcache|Warning: PHP Startup" || true)
printf "%s\n" "$panel_out" | tail -14
case "$panel_out" in
  *"全部通过"*) : ;;
  *) echo "  ✗ 单篇同步面板断言失败"; exit 1 ;;
esac

echo "=== ⑦ 真实登录态渲染 ==="
plink -ssh -pw vr50we root@$HOST \
  "docker exec $CONTAINER php $CONTAINER_DIR/test/render-settings.php 2>&1" \
  2>/dev/null | grep -vE "opcache|Warning: PHP Startup" | grep -E "渲染|错误|状态|连接"

echo "=== ⑧ 渲染产物 HTML 结构体检 ==="
# 取回服务器上真实渲染出的 HTML，离线做标签配平 / 嵌套 form / 属性截断检查。
# 这两项是 2026-10-25 「设置页冲破」事故的回归门禁：
#   · 标签不配平 ⇒ 布局错位、右栏被折叠块吞掉
#   · 嵌套 form ⇒ 主表单被提前关闭，基础配置字段全部落在表单外（保存不生效）
RENDERED="$SRC/tmp/cfse-settings.rendered.html"
mkdir -p "$SRC/tmp"
plink -ssh -pw vr50we root@$HOST \
  "docker exec $CONTAINER cat /tmp/cfse-settings.html" 2>/dev/null > "$RENDERED"
if [ ! -s "$RENDERED" ]; then
  echo "  ✗ 没能取回渲染产物（/tmp/cfse-settings.html 为空）"; exit 1
fi
node tools/check-html-structure.mjs "$RENDERED"

# form owner / 布局检查需要 html5lib；装了就跑，没装只提示、不阻断
PY="${CFSE_PYTHON:-python}"
if "$PY" -c "import html5lib" >/dev/null 2>&1; then
  "$PY" tools/check-rendered-page.py "$RENDERED" || exit 1
else
  echo "  ⚠ 跳过 form owner / 布局检查（当前 python 缺 html5lib；设 CFSE_PYTHON 指向装好它的解释器）"
fi

echo
echo "✓ 部署完成"
echo "  插件目录: $REMOTE_DIR"
echo "  旧版本备份: $PLUGDIR/cfse-sync.bak-prev"
echo "  激活状态请用 test/switch-plugin.php 切换（直接 UPDATE 会被 alloptions 缓存挡住）"
