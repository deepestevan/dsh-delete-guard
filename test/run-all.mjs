// 一条命令跑完本插件的验证：`node test/run-all.mjs`
//
//   ① 命令分类    guard.test.mjs        —— 纯函数：什么算删除、什么不算
//   ② 覆盖守卫    rewrite.test.mjs      —— 纯函数：没有删除动词的内容毁灭（读改写 / 未断言端点）
//   ③ 暂存删除    staging.test.mjs      —— 纯函数：无回收站的卷（UNC）先复制+校验+回收副本
//   ④ 操作数守卫  move-guard.test.mjs   —— 纯函数：file_trash 的目标边界
//   ⑤ 宿主注册    registration.test.mjs —— 桩 ctx 驱动 apply：钩子与两个工具
//   ⑥ 宿主 schema host-schema.test.mjs  —— 用宿主的 JSON-Schema 校验器卡注册面
//   ⑦ 端到端      e2e.test.mjs          —— 真移文件、核对回收站占用（含真 UNC 路径）
//
// 本插件没有客户端半体（不挂 UI 插槽），故无 client 层测试。
// 退出码非 0 表示有失败用例。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
  ['① 命令分类', 'guard.test.mjs'],
  ['② 覆盖守卫', 'rewrite.test.mjs'],
  // The staging layer creates junctions and copies trees; on a non-Windows runner
  // the junction half cannot be built, so it stays on win32 like the e2e layer.
  ['③ 暂存删除', 'staging.test.mjs', 'win32'],
  ['④ 操作数守卫', 'move-guard.test.mjs'],
  ['⑤ 宿主注册', 'registration.test.mjs'],
  ['⑥ 宿主 schema', 'host-schema.test.mjs'],
  // The e2e layer moves real files into the Windows Recycle Bin, so it cannot run
  // off Windows — including on the Linux CI runner that publishes the package.
  // Layers ① ② ④ ⑥ pass anywhere; ⑤ runs its hook cases and skips its two schema
  // cases when no DSH install is present.
  ['⑦ 端到端', 'e2e.test.mjs', 'win32'],
];

let failed = 0;
let skipped = 0;
for (const [label, file, platform] of suites) {
  if (platform !== undefined && process.platform !== platform) {
    console.log(`\n${'='.repeat(60)}\n[${label}] ${file}\n  skipped: needs ${platform}, running on ${process.platform}`);
    skipped += 1;
    continue;
  }
  console.log(`\n${'='.repeat(60)}\n[${label}] ${file}`);
  const r = spawnSync(process.execPath, ['--test', join(here, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
console.log(`\nall tests passed${skipped > 0 ? ` (${skipped} suite skipped: wrong platform)` : ''}`);
