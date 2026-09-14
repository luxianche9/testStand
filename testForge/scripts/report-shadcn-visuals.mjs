import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(workspace, "reports/shadcn/visual");
const groups = (await readdir(join(root, "reference"))).sort();
const scenes = ["welcome", "devices", "wiring", "orchestration", "logs", "settings-appearance", "settings-model", "settings-agent", "agent-sidebar", "dirty-dialog"];
assert.equal(groups.length, 9);
const records = [];
for (const group of groups) {
  for (const scene of scenes) {
    const paths = ["reference", "after"].map((phase) => join(root, phase, group, scene));
    const controls = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path + ".json", "utf8"))));
    assert.deepEqual(controls[1], controls[0], `${group}/${scene}: changed controls`);
    const pngs = await Promise.all(paths.map((path) => readFile(path + ".png")));
    const dimensions = pngs.map((png) => [png.readUInt32BE(16), png.readUInt32BE(20)]);
    assert.deepEqual(dimensions[1], dimensions[0]);
    records.push({ group, scene, controls: controls[0].length, dimensions: dimensions[0],
      reference: createHash("sha256").update(pngs[0]).digest("hex"),
      after: createHash("sha256").update(pngs[1]).digest("hex") });
  }
}
await writeFile(join(root, "comparison.json"), JSON.stringify({ comparisons: records.length, records }, null, 2) + "\n");
const sections = groups.map((group, index) => `<section data-group="${group}" ${index ? "hidden" : ""}>${scenes.map((scene) => `<article><h2>${scene}</h2><div class="pair"><figure><figcaption>改前 · Git 原 renderer</figcaption><a href="reference/${group}/${scene}.png"><img loading="lazy" src="reference/${group}/${scene}.png" alt="改前 ${group} ${scene}"></a></figure><figure><figcaption>改后 · shadcn neutral</figcaption><a href="after/${group}/${scene}.png"><img loading="lazy" src="after/${group}/${scene}.png" alt="改后 ${group} ${scene}"></a></figure></div></article>`).join("")}</section>`).join("");
await writeFile(join(root, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestForge 界面对照</title><style>body{margin:24px;font:14px system-ui;color:#171717;background:#fafafa}h1{font-size:24px}p{max-width:1000px;line-height:1.7}label{display:flex;gap:12px;align-items:center;position:sticky;top:0;padding:12px;background:#fafafa}select{padding:8px;border:1px solid #aaa;border-radius:8px}article{margin:28px 0}h2{font-size:16px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;min-width:0}figcaption{margin-bottom:8px;color:#555}img{width:100%;border:1px solid #ddd;border-radius:8px}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><h1>TestForge · shadcn 中性主题对照</h1><p>9 个主题／窗口组合，10 个场景，共 90 对截图。控件类型、名称、数量、禁用状态和原生选项清单逐项一致。改前 renderer 从 Git 0b90bfc1b1c4cccc6ebba29666343ec84c494824 的原始文件重建，搭配当前平台层；Agent 已等待配置提示加载完成。最初安装包的 90 张截图仍保存在 before/，供追溯。点击图片查看原尺寸。</p><p>本对照覆盖未配置模型时的 Agent 侧栏。运行态输入、取消、附件及权限通过组件交互测试验证；未使用真实外部模型会话截图代替这些测试。</p><label for="group">主题与窗口<select id="group">${groups.map((group) => `<option>${group}</option>`).join("")}</select></label>${sections}<script>document.getElementById('group').addEventListener('change',event=>{for(const section of document.querySelectorAll('[data-group]'))section.hidden=section.dataset.group!==event.target.value})</script></html>`);
console.log(`${records.length} screenshot pairs have identical controls and viewport dimensions.`);
