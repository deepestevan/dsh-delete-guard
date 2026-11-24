// 一条命令跑完本插件的验证：`node test/run-all.mjs`
//
//   ① 命令分类    guard.test.mjs        —— 纯函数：什么算删除、什么不算
//   ② 覆盖守卫    rewrite.test.mjs      —— 纯函数：没有删除动词的内容毁灭（读改写 / 未断言端点）
//   ③ 规则漏洞    holes.test.mjs        —— 干跑不倒转、回收站动词、provider、间接 shell
//   ④ 暂存删除    staging.test.mjs      —— 纯函数：无回收站的卷（UNC）先复制+校验+回收副本
//   ⑤ 操作数守卫  move-guard.test.mjs   —— 纯函数：file_trash 的目标边界
//   ⑥ 宿主注册    registration.test.mjs —— 桩 ctx 驱动 apply：钩子与两个工具
//   ⑦ 宿主 schema host-schema.test.mjs  —— 用宿主的 JSON-Schema 校验器卡注册面
//   ⑧ 端到端      e2e.test.mjs          —— 真移文件、核对回收站占用（含真 UNC 路径）
//
// 本插件没有客户端半体（不挂 UI 插槽），故无 client 层测试。
// 退出码非 0 表示有失败用例。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The plugin is Windows-only (`os: ["win32"]`): the bridge is SHFileOperationW, and
// layers ④ ⑤ ⑧ assert Windows path and volume semantics (`C:\` is a drive root,
// `\\host\share` is a UNC path, `path.resolve` is win32). On a POSIX runner those
// assertions fail for the right reason — the code is not wrong, the host is.
//
// Measured on the first CI run this repository ever had (run 45257920725, Ubuntu,
// Node 22): layer ④ went 4 pass / 11 fail, every failure a POSIX `path.resolve`.
// The previous 2.3.0 changelog claimed those layers "pass anywhere", based on
// forcing `process.platform='linux'` locally — which does not change how
// `node:path` was bound at load time, so the check proved nothing.
const WINDOWS_ONLY = process.platform === 'win32';

const suites = [
  ['① 命令分类', 'guard.test.mjs'],
  ['② 覆盖守卫', 'rewrite.test.mjs'],
  ['③ 规则漏洞', 'holes.test.mjs'],
  ['④ 暂存删除', 'staging.test.mjs', WINDOWS_ONLY],
  ['⑤ 操作数守卫', 'move-guard.test.mjs', WINDOWS_ONLY],
  ['⑥ 宿主注册', 'registration.test.mjs'],
  ['⑦ 宿主 schema', 'host-schema.test.mjs'],
  ['⑧ 端到端', 'e2e.test.mjs', WINDOWS_ONLY],
];

let failed = 0;
let skipped = 0;
for (const [label, file, runnable = true] of suites) {
  if (!runnable) {
    console.log(`\n${'='.repeat(60)}\n[${label}] ${file}\n  skipped: needs win32, running on ${process.platform}`);
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
console.log(`\nall tests passed${skipped > 0 ? ` (${skipped} suite skipped: not this platform)` : ''}`);
