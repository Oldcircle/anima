/**
 * Anima 管理面板 — Preact + htm，零构建。
 *
 * 路由（hash）：
 *   #/live        实时观察（嵌入旧 legacy.html）
 *   #/characters  角色 CRUD
 *   #/locations   地点 CRUD
 *   #/settings    LLM 设置
 */

import { h, render, Fragment } from "https://esm.sh/preact@10.22.0";
import { useState, useEffect, useMemo, useCallback } from "https://esm.sh/preact@10.22.0/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { LLM_PROVIDERS, getProvider } from "./providers.js";

const html = htm.bind(h);

// ===== 全局状态（最简 pub/sub） =====

function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; subs.forEach((fn) => fn(state)); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}

const store = createStore({
  connected: false,
  tick: 0,
  formattedTime: "—",
  weather: "",
  speed: 1,
  characters: [],
  toast: null,
});

function useStore() {
  const [s, setS] = useState(store.get());
  useEffect(() => store.subscribe(setS), []);
  return s;
}

function toast(msg, kind = "ok") {
  store.set({ toast: { msg, kind, id: Date.now() } });
  setTimeout(() => {
    if (store.get().toast?.msg === msg) store.set({ toast: null });
  }, 3500);
}

// ===== WebSocket =====

let ws;
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => store.set({ connected: true });
  ws.onclose = () => {
    store.set({ connected: false });
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "snapshot" || msg.type === "tick") {
        const d = msg.data;
        store.set({
          tick: d.tick,
          formattedTime: d.formattedTime ?? "—",
          weather: d.weather ?? "",
          characters: d.characters ?? [],
        });
      } else if (msg.type === "speed_changed") {
        store.set({ speed: msg.data.speed });
      }
    } catch {}
  };
}
function sendWS(type, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

// ===== API helpers =====

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  });
  const isJson = r.headers.get("content-type")?.includes("json");
  const body = isJson ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = (body && body.error) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

// ===== Router =====

function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/live");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/live");
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "");
}

// ===== App shell =====

function App() {
  const route = useRoute();
  const s = useStore();

  return html`
    <div class="shell">
      <div class="topbar">
        <div class="brand">🌙 Anima</div>
        <div class="time">${s.formattedTime}</div>
        <div class="meta">tick ${s.tick} · ${s.weather || "—"}</div>
        <div class="speed">
          ${[0, 1, 2, 5].map((v) => html`
            <button class=${s.speed === v ? "active" : ""} onClick=${() => sendWS("set_speed", { speed: v })}>
              ${v === 0 ? "⏸" : `${v}x`}
            </button>
          `)}
        </div>
        <div class=${"conn " + (s.connected ? "ok" : "bad")}>${s.connected ? "● 已连接" : "○ 断开"}</div>
      </div>
      <div class="body">
        <nav class="sidebar">
          <div class="group-title">观察</div>
          <${NavLink} href="/live" route=${route}>实时</${NavLink}>
          <div class="group-title">配置</div>
          <${NavLink} href="/characters" route=${route}>角色</${NavLink}>
          <${NavLink} href="/locations" route=${route}>地点</${NavLink}>
          <${NavLink} href="/settings" route=${route}>设置</${NavLink}>
          <div class="group-title">其他</div>
          <a href="/legacy.html" target="_blank">旧观察面板 ↗</a>
        </nav>
        <main class="main">
          <${LiveShell} active=${route === "/live" || route === "/"} />
          ${route !== "/live" && route !== "/" && renderRoute(route)}
        </main>
      </div>
      ${s.toast && html`<div class=${"toast " + s.toast.kind}>${s.toast.msg}</div>`}
    </div>
  `;
}

function NavLink({ href, route, children }) {
  const active = route === href || route.startsWith(href + "/");
  return html`<a class=${active ? "active" : ""} href=${"#" + href}>${children}</a>`;
}

// 常驻 Live iframe，避免切页时被卸载导致旧观察面板的聊天记录丢失
function LiveShell({ active }) {
  const s = useStore();
  return html`
    <div style=${active ? "" : "display:none;"}>
      <h1>实时观察</h1>
      <div class="subtitle">完整观察面板（角色 / 对话 / 印象 / 关系）保留在旧版页面中。</div>
      <iframe class="live" src="/legacy.html"></iframe>
      <div style="margin-top:16px;color:#8b949e;font-size:11px;">
        共 ${s.characters.length} 个角色 · 当前 tick ${s.tick}
      </div>
    </div>
  `;
}

function renderRoute(route) {
  if (route === "/characters") return html`<${CharactersPage} />`;
  if (route === "/locations") return html`<${LocationsPage} />`;
  if (route === "/settings") return html`<${SettingsPage} />`;
  return html`<${LivePage} />`;
}

// ===== Characters 页 =====

function CharactersPage() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try { setList(await api("/api/admin/characters")); }
    catch (e) { toast("加载失败：" + e.message, "error"); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return html`
    <h1>角色</h1>
    <div class="subtitle">编辑角色卡。删除默认是软停用（YAML 加 disabled: true）。</div>
    <div class="toolbar">
      <button class="primary" onClick=${() => setCreating(true)}>+ 新建角色</button>
      <div class="spacer"></div>
      <button onClick=${reload}>刷新</button>
    </div>
    ${list.length === 0 && html`<div class="empty">还没有角色。点 "新建角色"。</div>`}
    <div class="grid">
      ${list.map((c) => html`
        <div class=${"card" + (c.disabled ? " disabled" : "")} onClick=${() => setEditing(c)}>
          <div class="title">${c.name} ${c.disabled && html`<span class="badge">停用</span>`}</div>
          <div class="meta">${c.id} · ${c.gender ?? "—"} · ${c.life?.occupation ?? c.occupation ?? "—"}</div>
          <div class="desc">${c.personality?.coreTraits ?? (c.personality?.traits ?? []).join("、") ?? ""}</div>
        </div>
      `)}
    </div>
    ${editing && html`<${CharacterDrawer} card=${editing} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reload(); }} />`}
    ${creating && html`<${CharacterDrawer} card=${blankCharacter()} isNew=${true} onClose=${() => setCreating(false)} onSaved=${() => { setCreating(false); reload(); }} />`}
  `;
}

function blankCharacter() {
  return {
    id: "",
    name: "",
    gender: "female",
    home: "",
    age: 20,
    occupation: "",
    appearance: "",
    background: "",
    personality: {
      traits: [],
      interests: [],
      dislikes: [],
      speechStyle: "",
      coreTraits: "",
      psychology: "",
    },
    life: { occupation: "", workplace: "", age: 20, income: 15, skills: {}, aspiration: "" },
    relationships: {},
  };
}

function CharacterDrawer({ card, isNew = false, onClose, onSaved }) {
  const [draft, setDraft] = useState(JSON.parse(JSON.stringify(card)));
  const [tab, setTab] = useState("basic");
  const [saving, setSaving] = useState(false);

  const patch = (path, value) => {
    setDraft((d) => {
      const next = { ...d };
      const keys = path.split(".");
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]] = { ...(cur[keys[i]] ?? {}) };
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        await api("/api/admin/characters", { method: "POST", body: JSON.stringify(draft) });
        toast("已创建：" + draft.name);
      } else {
        await api("/api/admin/characters/" + draft.id, { method: "PUT", body: JSON.stringify(draft) });
        toast("已保存：" + draft.name);
      }
      onSaved();
    } catch (e) {
      toast("保存失败：" + e.message, "error");
    } finally { setSaving(false); }
  };

  const remove = async (hard) => {
    const tip = hard
      ? `永久删除 ${draft.name}？YAML 文件会被删除，无法恢复。`
      : `软停用 ${draft.name}？该角色不会再出现在仿真中，YAML 保留。`;
    if (!confirm(tip)) return;
    try {
      await api("/api/admin/characters/" + draft.id + (hard ? "?hard=1" : ""), { method: "DELETE" });
      toast(hard ? "已永久删除" : "已停用");
      onSaved();
    } catch (e) { toast("删除失败：" + e.message, "error"); }
  };

  const tabs = [
    ["basic", "基本"],
    ["personality", "性格"],
    ["background", "背景"],
    ["life", "生活"],
    ["raw", "JSON"],
  ];

  return html`
    <div class="drawer-mask" onClick=${(e) => e.target.classList.contains("drawer-mask") && onClose()}>
      <div class="drawer">
        <div class="drawer-header">
          <h2>${isNew ? "新建角色" : "编辑：" + draft.name}</h2>
          <button onClick=${onClose}>✕</button>
        </div>
        <div class="drawer-tabs">
          ${tabs.map(([k, label]) => html`<button class=${tab === k ? "active" : ""} onClick=${() => setTab(k)}>${label}</button>`)}
        </div>
        <div class="drawer-body">
          ${tab === "basic" && html`
            <div class="field"><label>ID（小写字母数字下划线）</label>
              <input value=${draft.id} disabled=${!isNew} onInput=${(e) => patch("id", e.target.value)} />
            </div>
            <div class="row">
              <div class="field"><label>名字</label><input value=${draft.name} onInput=${(e) => patch("name", e.target.value)} /></div>
              <div class="field"><label>年龄</label><input type="number" value=${draft.age} onInput=${(e) => patch("age", +e.target.value)} /></div>
              <div class="field"><label>性别</label>
                <select value=${draft.gender ?? ""} onChange=${(e) => patch("gender", e.target.value || undefined)}>
                  <option value="">未填</option>
                  <option value="female">女</option>
                  <option value="male">男</option>
                  <option value="other">其他</option>
                </select>
              </div>
            </div>
            <div class="field"><label>家所在地点 ID</label><input value=${draft.home} onInput=${(e) => patch("home", e.target.value)} /></div>
            <div class="field"><label>外貌</label><textarea value=${draft.appearance ?? ""} onInput=${(e) => patch("appearance", e.target.value)}></textarea></div>
          `}
          ${tab === "personality" && html`
            <div class="field"><label>核心人格描写</label>
              <textarea rows="4" value=${draft.personality?.coreTraits ?? ""} onInput=${(e) => patch("personality.coreTraits", e.target.value)}></textarea>
            </div>
            <div class="field"><label>心理底色</label>
              <textarea rows="3" value=${draft.personality?.psychology ?? ""} onInput=${(e) => patch("personality.psychology", e.target.value)}></textarea>
            </div>
            <div class="field"><label>说话风格</label>
              <textarea rows="2" value=${draft.personality?.speechStyle ?? ""} onInput=${(e) => patch("personality.speechStyle", e.target.value)}></textarea>
            </div>
            <div class="field"><label>性格标签（逗号分隔）</label>
              <input value=${(draft.personality?.traits ?? []).join(", ")} onInput=${(e) => patch("personality.traits", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
            </div>
            <div class="field"><label>兴趣（逗号分隔）</label>
              <input value=${(draft.personality?.interests ?? []).join(", ")} onInput=${(e) => patch("personality.interests", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
            </div>
            <div class="field"><label>厌恶（逗号分隔）</label>
              <input value=${(draft.personality?.dislikes ?? []).join(", ")} onInput=${(e) => patch("personality.dislikes", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
            </div>
          `}
          ${tab === "background" && html`
            <div class="field"><label>背景故事</label>
              <textarea rows="10" value=${draft.background ?? ""} onInput=${(e) => patch("background", e.target.value)}></textarea>
            </div>
          `}
          ${tab === "life" && html`
            <div class="row">
              <div class="field"><label>职业</label><input value=${draft.life?.occupation ?? ""} onInput=${(e) => patch("life.occupation", e.target.value)} /></div>
              <div class="field"><label>工作地点 ID</label><input value=${draft.life?.workplace ?? ""} onInput=${(e) => patch("life.workplace", e.target.value)} /></div>
            </div>
            <div class="row">
              <div class="field"><label>每次工作收入</label><input type="number" value=${draft.life?.income ?? 15} onInput=${(e) => patch("life.income", +e.target.value)} /></div>
              <div class="field"><label>年龄</label><input type="number" value=${draft.life?.age ?? 20} onInput=${(e) => patch("life.age", +e.target.value)} /></div>
            </div>
            <div class="field"><label>抱负</label>
              <textarea rows="2" value=${draft.life?.aspiration ?? ""} onInput=${(e) => patch("life.aspiration", e.target.value)}></textarea>
            </div>
          `}
          ${tab === "raw" && html`
            <pre class="json">${JSON.stringify(draft, null, 2)}</pre>
            <div class="muted" style="margin-top:8px;font-size:11px;">只读预览。需要直接编辑 JSON 请改 YAML 文件。</div>
          `}
        </div>
        <div class="drawer-footer">
          ${!isNew && html`<button class="danger" onClick=${() => remove(false)}>停用</button>`}
          ${!isNew && html`<button class="danger" onClick=${() => remove(true)}>永久删除</button>`}
          <div class="spacer"></div>
          <button onClick=${onClose}>取消</button>
          <button class="primary" disabled=${saving} onClick=${save}>${saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </div>
  `;
}

// ===== Locations 页 =====

function LocationsPage() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try { setList(await api("/api/admin/locations")); }
    catch (e) { toast("加载失败：" + e.message, "error"); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  return html`
    <h1>地点</h1>
    <div class="subtitle">编辑地点 YAML。删除前会检查是否有角色在场。</div>
    <div class="toolbar">
      <button class="primary" onClick=${() => setCreating(true)}>+ 新建地点</button>
      <div class="spacer"></div>
      <button onClick=${reload}>刷新</button>
    </div>
    ${list.length === 0 && html`<div class="empty">还没有地点。</div>`}
    <div class="grid">
      ${list.map((l) => html`
        <div class="card" onClick=${() => setEditing(l)}>
          <div class="title">${l.name} <span class="badge">${l.type}</span></div>
          <div class="meta">${l.id}</div>
          <div class="desc">${l.summary ?? ""}</div>
        </div>
      `)}
    </div>
    ${editing && html`<${LocationDrawer} loc=${editing} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reload(); }} />`}
    ${creating && html`<${LocationDrawer} loc=${blankLocation()} isNew=${true} onClose=${() => setCreating(false)} onSaved=${() => { setCreating(false); reload(); }} />`}
  `;
}

function blankLocation() {
  return {
    id: "", name: "", type: "public", summary: "",
    atmosphere: { morning: "", afternoon: "", evening: "", night: "", rainy: "" },
  };
}

function LocationDrawer({ loc, isNew = false, onClose, onSaved }) {
  const [draft, setDraft] = useState(JSON.parse(JSON.stringify(loc)));
  const [saving, setSaving] = useState(false);

  const patch = (path, value) => {
    setDraft((d) => {
      const next = { ...d };
      const keys = path.split(".");
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]] = { ...(cur[keys[i]] ?? {}) };
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      // 清掉前端注入的 _file 字段
      const { _file, ...payload } = draft;
      if (isNew) await api("/api/admin/locations", { method: "POST", body: JSON.stringify(payload) });
      else await api("/api/admin/locations/" + draft.id, { method: "PUT", body: JSON.stringify(payload) });
      toast("已保存：" + draft.name);
      onSaved();
    } catch (e) { toast("保存失败：" + e.message, "error"); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirm(`删除地点 ${draft.name}？如果有角色在场会拒绝。`)) return;
    try {
      await api("/api/admin/locations/" + draft.id, { method: "DELETE" });
      toast("已删除");
      onSaved();
    } catch (e) { toast("删除失败：" + e.message, "error"); }
  };

  return html`
    <div class="drawer-mask" onClick=${(e) => e.target.classList.contains("drawer-mask") && onClose()}>
      <div class="drawer">
        <div class="drawer-header">
          <h2>${isNew ? "新建地点" : "编辑：" + draft.name}</h2>
          <button onClick=${onClose}>✕</button>
        </div>
        <div class="drawer-body">
          <div class="field"><label>ID</label>
            <input value=${draft.id} disabled=${!isNew} onInput=${(e) => patch("id", e.target.value)} />
          </div>
          <div class="row">
            <div class="field"><label>名字</label><input value=${draft.name} onInput=${(e) => patch("name", e.target.value)} /></div>
            <div class="field"><label>类型</label>
              <select value=${draft.type} onChange=${(e) => patch("type", e.target.value)}>
                ${["residential", "commercial", "public", "nature", "special"].map((t) => html`<option value=${t}>${t}</option>`)}
              </select>
            </div>
          </div>
          <div class="field"><label>摘要</label><input value=${draft.summary ?? ""} onInput=${(e) => patch("summary", e.target.value)} /></div>

          <h3 style="margin:16px 0 8px;color:#f0f6fc;font-size:13px;">氛围（按时段）</h3>
          ${["morning", "afternoon", "evening", "night", "rainy"].map((slot) => html`
            <div class="field"><label>${slot}</label>
              <textarea rows="2" value=${draft.atmosphere?.[slot] ?? ""} onInput=${(e) => patch("atmosphere." + slot, e.target.value)}></textarea>
            </div>
          `)}
        </div>
        <div class="drawer-footer">
          ${!isNew && html`<button class="danger" onClick=${remove}>删除</button>`}
          <div class="spacer"></div>
          <button onClick=${onClose}>取消</button>
          <button class="primary" disabled=${saving} onClick=${save}>${saving ? "保存中…" : "保存"}</button>
        </div>
      </div>
    </div>
  `;
}

// ===== Settings 页 =====

function SettingsPage() {
  const [form, setForm] = useState({ provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat" });
  const [maskedKey, setMaskedKey] = useState("");
  const [source, setSource] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api("/api/admin/settings/llm").then((r) => {
      setForm((f) => ({ ...f, provider: r.provider || f.provider, baseUrl: r.baseUrl || f.baseUrl, model: r.model || f.model }));
      setMaskedKey(r.apiKey || "");
      setSource(r.source || "");
    }).catch((e) => toast(e.message, "error"));
  }, []);

  const patch = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // 切 provider：自动填 endpoint + 第一个模型
  const pickProvider = (id) => {
    const p = getProvider(id);
    if (!p) return;
    setForm((f) => ({
      ...f,
      provider: id,
      baseUrl: p.defaultEndpoint || f.baseUrl,
      model: p.models[0] || f.model,
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api("/api/admin/settings/llm", { method: "PUT", body: JSON.stringify(form) });
      toast("已保存");
      setMaskedKey(r.apiKey);
      setForm((f) => ({ ...f, apiKey: "" })); // 清空输入框
    } catch (e) { toast("保存失败：" + e.message, "error"); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api("/api/admin/settings/llm/test", { method: "POST", body: JSON.stringify(form) });
      toast(`连接成功 ${r.latencyMs}ms：${r.sample?.slice(0, 40)}`);
    } catch (e) { toast("连接失败：" + e.message, "error"); }
    finally { setTesting(false); }
  };

  const currentProvider = getProvider(form.provider);
  const knownModels = currentProvider?.models ?? [];

  return html`
    <h1>设置</h1>
    <div class="subtitle">LLM Provider 配置（参考 fable 项目，全部走 OpenAI 兼容协议）。修改后会在下一个 tick 间隙生效。</div>
    <div style="max-width:620px;">
      <div class="field"><label>Provider</label>
        <select value=${form.provider} onChange=${(e) => pickProvider(e.target.value)}>
          ${LLM_PROVIDERS.map((p) => html`<option value=${p.id}>${p.name}${p.description ? ` — ${p.description}` : ""}</option>`)}
        </select>
      </div>
      <div class="field"><label>Base URL</label>
        <input value=${form.baseUrl} onInput=${(e) => patch("baseUrl", e.target.value)} placeholder="https://api.deepseek.com" />
      </div>
      <div class="field"><label>API Key ${maskedKey && html`<span class="muted">（当前：${maskedKey}）</span>`}</label>
        <input type="password" value=${form.apiKey} onInput=${(e) => patch("apiKey", e.target.value)} placeholder="sk-... 留空保留当前 key" />
      </div>
      <div class="field"><label>Model</label>
        ${knownModels.length > 0 && html`
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
            ${knownModels.map((m) => html`
              <button type="button" class=${form.model === m ? "primary" : ""} style="font-size:11px;padding:3px 8px;" onClick=${() => patch("model", m)}>${m}</button>
            `)}
          </div>
        `}
        <input value=${form.model} onInput=${(e) => patch("model", e.target.value)} placeholder="deepseek-chat" />
        <div class="muted" style="font-size:10px;margin-top:4px;">点上方按钮快速选择，也可以手动输入自定义模型名。</div>
      </div>
      <div class="row">
        <button class="primary" disabled=${saving} onClick=${save}>${saving ? "保存中…" : "保存"}</button>
        <button disabled=${testing} onClick=${test}>${testing ? "测试中…" : "测试连接"}</button>
      </div>
      <div class="muted" style="margin-top:18px;font-size:11px;">
        来源：${source || "(未保存)"}<br/>
        API key 永远不会以明文返回；保存后只显示末 4 位。<br/>
        当前后端只支持 OpenAI 兼容协议；Anthropic / Gemini 原生 API 需要后端再加适配器。
      </div>
    </div>
  `;
}

// ===== boot =====

connectWS();
render(html`<${App} />`, document.getElementById("root"));
