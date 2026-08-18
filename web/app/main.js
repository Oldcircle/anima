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
  narrative: null,        // {tensionIndex, activePhase, unresolvedEventsCount, triggeredBeatsCount, rumorsCount, directorEnabled}
  recentBeats: [],        // [{tick, beatId, description}] 最多 20 条
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
        const patch = {
          tick: d.tick,
          formattedTime: d.formattedTime ?? "—",
          weather: d.weather ?? "",
          characters: d.characters ?? [],
        };
        if (d.narrative) patch.narrative = d.narrative;
        store.set(patch);
      } else if (msg.type === "speed_changed") {
        store.set({ speed: msg.data.speed });
      } else if (msg.type === "beat_ready") {
        // 累积最近 beat 触发，给叙事面板用
        const cur = store.get().recentBeats || [];
        const next = [{ ...msg.data, ts: Date.now() }, ...cur].slice(0, 20);
        store.set({ recentBeats: next });
        toast(`🎬 Beat: ${msg.data.beatId}`);
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
          <${NavLink} href="/chronicle" route=${route}>编年史</${NavLink}>
          <${NavLink} href="/narrative" route=${route}>叙事</${NavLink}>
          <${NavLink} href="/grounding" route=${route}>世界</${NavLink}>
          <${NavLink} href="/prompts" route=${route}>提示词</${NavLink}>
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
  if (route === "/narrative") return html`<${NarrativePage} />`;
  if (route === "/grounding") return html`<${GroundingPage} />`;
  if (route === "/prompts") return html`<${PromptsPage} />`;
  if (route === "/chronicle") return html`<${ChroniclePage} />`;
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
        <div class=${"card" + (l.disabled ? " disabled" : "")} onClick=${() => setEditing(l)}>
          <div class="title">${l.name} <span class="badge">${l.type}</span>${l.disabled && html`<span class="badge">停用</span>`}</div>
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

  const remove = async (hard) => {
    const tip = hard
      ? `永久删除 ${draft.name}？YAML 条目会被删除，无法恢复。`
      : `软停用 ${draft.name}？该地点不会再出现在仿真中，可以在 YAML 中改回 disabled: false 恢复。`;
    if (!confirm(tip)) return;
    try {
      await api("/api/admin/locations/" + draft.id + (hard ? "?hard=1" : ""), { method: "DELETE" });
      toast(hard ? "已永久删除" : "已停用");
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

// ===== Settings 页 =====

// ===== Narrative 页 (N5) =====

function NarrativePage() {
  const s = useStore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // 干预表单
  const [evtForm, setEvtForm] = useState({ id: "", summary: "", involved: "", visibleTo: "*" });
  const [rumorForm, setRumorForm] = useState({ content: "", sourceCharId: "", spreadTo: "" });
  const [obsForm, setObsForm] = useState({ observerId: "", summary: "" });

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api("/api/narrative")); }
    catch (e) { toast("加载失败：" + e.message, "error"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // 自动每 5 秒刷新一次完整 narrative 数据（snapshot 字段太大不上 WS）
  useEffect(() => {
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);

  const submitEvent = async () => {
    if (!evtForm.id || !evtForm.summary) return toast("id 和 summary 必填", "error");
    try {
      await api("/api/narrative/inject-event", {
        method: "POST",
        body: JSON.stringify({
          id: evtForm.id,
          summary: evtForm.summary,
          involved: evtForm.involved.split(",").map((s) => s.trim()).filter(Boolean),
          visibleTo: evtForm.visibleTo === "*" ? "*" : evtForm.visibleTo.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      toast("已注入未解决事件");
      setEvtForm({ id: "", summary: "", involved: "", visibleTo: "*" });
      reload();
    } catch (e) { toast("失败：" + e.message, "error"); }
  };

  const submitRumor = async () => {
    if (!rumorForm.content) return toast("流言内容必填", "error");
    try {
      await api("/api/narrative/inject-rumor", {
        method: "POST",
        body: JSON.stringify({
          content: rumorForm.content,
          sourceCharId: rumorForm.sourceCharId || undefined,
          spreadTo: rumorForm.spreadTo.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      toast("已注入流言");
      setRumorForm({ content: "", sourceCharId: "", spreadTo: "" });
      reload();
    } catch (e) { toast("失败：" + e.message, "error"); }
  };

  const submitObs = async () => {
    if (!obsForm.observerId || !obsForm.summary) return toast("两项必填", "error");
    try {
      await api("/api/narrative/inject-observation", { method: "POST", body: JSON.stringify(obsForm) });
      toast(`已塞纸条给 ${obsForm.observerId}`);
      setObsForm({ observerId: "", summary: "" });
    } catch (e) { toast("失败：" + e.message, "error"); }
  };

  const nudge = async () => {
    try {
      const r = await api("/api/narrative/nudge", { method: "POST" });
      toast(r.log ? `导演响应: ${r.log.toolCalls?.map((t) => t.name).join(",") || "(无)"}` : "已 nudge");
      reload();
    } catch (e) { toast("失败：" + e.message, "error"); }
  };

  const ns = data?.snapshot;
  const tension = s.narrative?.tensionIndex ?? ns?.world?.tensionIndex ?? 0;
  const phase = s.narrative?.activePhase ?? ns?.world?.activePhase;
  const directorEnabled = s.narrative?.directorEnabled ?? data?.director?.enabled ?? false;

  return html`
    <h1>叙事</h1>
    <div class="subtitle">叙事系统状态 + 玩家干预入口。规则导演 + LLM 导演由后端自动运行；这里你可以观察 + 直接塞东西进世界。</div>

    <div class="toolbar">
      <button onClick=${reload}>${loading ? "刷新中…" : "刷新"}</button>
      <div class="spacer"></div>
      <button class="primary" disabled=${!directorEnabled} onClick=${nudge}>触发导演节奏检查</button>
    </div>

    <!-- 总览 -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:18px;">
      <div class="card"><div class="title">张力 (tension)</div><div style="font-size:28px;font-weight:600;">${tension}/100</div></div>
      <div class="card"><div class="title">未解决事件</div><div style="font-size:28px;font-weight:600;">${ns?.world?.unresolvedEvents?.length ?? 0}</div></div>
      <div class="card"><div class="title">已触发 beats</div><div style="font-size:28px;font-weight:600;">${ns?.world?.triggeredBeats?.length ?? 0} / ${data?.beats?.loaded ?? 0}</div></div>
      <div class="card"><div class="title">流言数</div><div style="font-size:28px;font-weight:600;">${ns?.world?.rumors?.length ?? 0}</div></div>
      <div class="card"><div class="title">阶段</div><div style="font-size:18px;">${phase ?? "—"}</div></div>
      <div class="card"><div class="title">导演</div><div style="font-size:18px;">${directorEnabled ? "✓ 启用" : "✗ 禁用"}</div></div>
    </div>

    <!-- 左右布局 -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
      <!-- 左：状态详情 -->
      <div>
        <h2 style="font-size:16px;margin-top:0;">未解决事件</h2>
        ${(ns?.world?.unresolvedEvents ?? []).length === 0 && html`<div class="empty">（空）</div>`}
        ${(ns?.world?.unresolvedEvents ?? []).map((e) => html`
          <div class="card" style="margin-bottom:8px;">
            <div class="title">[${e.id}] tick ${e.createdTick}</div>
            <div>${e.summary}</div>
            <div class="muted" style="font-size:11px;margin-top:4px;">涉及: ${e.involved?.join(", ") || "—"} · 可见: ${Array.isArray(e.visibleTo) ? e.visibleTo.join(",") : e.visibleTo}</div>
          </div>
        `)}

        <h2 style="font-size:16px;margin-top:18px;">最近触发的 beats</h2>
        ${s.recentBeats.length === 0 && html`<div class="empty">（暂无，每天 22:00 自动扫描）</div>`}
        ${s.recentBeats.map((b) => html`
          <div class="card" style="margin-bottom:6px;">
            <div class="title">${b.beatId}</div>
            <div class="muted" style="font-size:11px;">tick ${b.tick} · ${b.description}</div>
          </div>
        `)}

        <h2 style="font-size:16px;margin-top:18px;">导演最近调用</h2>
        ${(data?.director?.recentCalls ?? []).length === 0 && html`<div class="empty">（导演还没调用过）</div>`}
        ${(data?.director?.recentCalls ?? []).slice().reverse().map((c) => html`
          <div class="card" style="margin-bottom:6px;">
            <div class="title">${c.trigger}${c.beatId ? ` · ${c.beatId}` : ""}</div>
            <div style="font-size:12px;margin:4px 0;">💭 ${c.thought || "(无想法)"}</div>
            <div class="muted" style="font-size:11px;">tools: ${c.toolCalls?.map((t) => `${t.name}${t.result?.ok ? "✓" : "✗"}`).join(", ") || "(无)"} · 余额 ${c.budgetRemaining}</div>
          </div>
        `)}
      </div>

      <!-- 右：干预表单 -->
      <div>
        <h2 style="font-size:16px;margin-top:0;">注入未解决事件</h2>
        <div class="card">
          <div class="field"><label>id</label>
            <input value=${evtForm.id} onInput=${(e) => setEvtForm({ ...evtForm, id: e.target.value })} placeholder="如 mystery_letter" />
          </div>
          <div class="field"><label>summary</label>
            <input value=${evtForm.summary} onInput=${(e) => setEvtForm({ ...evtForm, summary: e.target.value })} placeholder="一句话描述" />
          </div>
          <div class="field"><label>涉及角色 (id 逗号分隔)</label>
            <input value=${evtForm.involved} onInput=${(e) => setEvtForm({ ...evtForm, involved: e.target.value })} placeholder="alice,bob" />
          </div>
          <div class="field"><label>可见性 (* 或 id 逗号分隔)</label>
            <input value=${evtForm.visibleTo} onInput=${(e) => setEvtForm({ ...evtForm, visibleTo: e.target.value })} placeholder="*" />
          </div>
          <button class="primary" onClick=${submitEvent}>注入</button>
        </div>

        <h2 style="font-size:16px;margin-top:18px;">注入流言</h2>
        <div class="card">
          <div class="field"><label>内容</label>
            <input value=${rumorForm.content} onInput=${(e) => setRumorForm({ ...rumorForm, content: e.target.value })} placeholder="听说..." />
          </div>
          <div class="field"><label>源头角色 id (可选)</label>
            <input value=${rumorForm.sourceCharId} onInput=${(e) => setRumorForm({ ...rumorForm, sourceCharId: e.target.value })} placeholder="alice" />
          </div>
          <div class="field"><label>已传到的角色 (id 逗号分隔)</label>
            <input value=${rumorForm.spreadTo} onInput=${(e) => setRumorForm({ ...rumorForm, spreadTo: e.target.value })} placeholder="bob,carol" />
          </div>
          <button class="primary" onClick=${submitRumor}>注入</button>
        </div>

        <h2 style="font-size:16px;margin-top:18px;">塞纸条 (让某角色"想起"某事)</h2>
        <div class="card">
          <div class="field"><label>角色 id</label>
            <input value=${obsForm.observerId} onInput=${(e) => setObsForm({ ...obsForm, observerId: e.target.value })} placeholder="alice" />
          </div>
          <div class="field"><label>内容（第二人称）</label>
            <input value=${obsForm.summary} onInput=${(e) => setObsForm({ ...obsForm, summary: e.target.value })} placeholder="你想起昨天 bob 看你的眼神有点奇怪" />
          </div>
          <button class="primary" onClick=${submitObs}>投递</button>
        </div>
      </div>
    </div>
  `;
}

// ===== 世界（接地层）页：器物 / 正典 / 痕迹 / 断言账本 / 案件 / 线索执念 =====
// 这是观看者通道（对齐 🎭 motive）：真凶等剧透字段后端给得出来，前端默认折叠。

const VERDICT_LABEL = {
  canonized: "首述即正典", verified: "史料为真", false: "与世界不符",
  rumor: "推不出（传闻）", contradict: "顶撞正典", restate: "复述既成正典",
};

function GroundingPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [spoil, setSpoil] = useState(false);
  const [q, setQ] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api("/api/grounding")); }
    catch (e) { toast("加载失败：" + e.message, "error"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);

  const objects = data?.objects ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim();
    if (!needle) return objects;
    return objects.filter((o) =>
      [o.name, o.locationName, o.summary ?? "", ...o.canonFacts.map((f) => f.text), ...o.traces.map((t) => t.text)]
        .join(" ").includes(needle));
  }, [objects, q]);

  const byLocation = useMemo(() => {
    const m = new Map();
    for (const o of filtered) {
      if (!m.has(o.locationName)) m.set(o.locationName, []);
      m.get(o.locationName).push(o);
    }
    return [...m.entries()];
  }, [filtered]);

  const traced = objects.filter((o) => o.traces.length > 0);
  const claims = data?.claims ?? [];
  const cases = data?.cases ?? [];
  const leads = data?.leads ?? [];

  return html`
    <h1>世界（接地层）</h1>
    <div class="subtitle">器物是这个世界的本体：正典是"确证的事"，痕迹是"当下的物理状态"。角色用 examine 换真相、用 tamper 改痕迹，断言账本记着谁说过什么、世界怎么裁决的。</div>

    <div class="toolbar">
      <button style="flex:none;white-space:nowrap;" onClick=${reload}>${loading ? "刷新中…" : "刷新"}</button>
      <input placeholder="搜器物/正典/痕迹…" value=${q} onInput=${(e) => setQ(e.target.value)} style="min-width:220px;max-width:320px;" />
      <div class="spacer"></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;white-space:nowrap;flex:none;">
        <input type="checkbox" checked=${spoil} onChange=${(e) => setSpoil(e.target.checked)} />
        显示剧透（真凶）
      </label>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;">
      <div class="card"><div class="title">器物</div><div style="font-size:28px;font-weight:600;">${objects.length}</div></div>
      <div class="card"><div class="title">带痕迹的器物</div><div style="font-size:28px;font-weight:600;">${traced.length}</div></div>
      <div class="card"><div class="title">断言账本</div><div style="font-size:28px;font-weight:600;">${claims.length}</div></div>
      <div class="card"><div class="title">案件</div><div style="font-size:28px;font-weight:600;">${cases.length}</div></div>
      <div class="card"><div class="title">线索执念</div><div style="font-size:28px;font-weight:600;">${leads.length}</div></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
      <div>
        <h2 style="font-size:16px;margin-top:0;">器物层</h2>
        ${byLocation.length === 0 && html`<div class="empty">（没有器物——ANIMA_GROUNDING=0 或该剧本地点未声明 objects）</div>`}
        ${byLocation.map(([locName, objs]) => html`
          <div style="margin-bottom:14px;">
            <div class="muted" style="font-size:11px;margin-bottom:6px;">${locName}</div>
            ${objs.map((o) => html`
              <div class="card" style="margin-bottom:8px;">
                <div class="title">${o.name}${o.tamperable ? " · 可动手脚" : ""}</div>
                ${o.summary && html`<div class="muted" style="font-size:12px;">${o.summary}</div>`}
                ${o.canonFacts.map((f) => html`
                  <div style="font-size:12px;margin-top:4px;">📜 ${f.text}
                    <span class="muted" style="font-size:10px;"> (${f.source === "authored" ? "预埋" : f.source === "canonized" ? "对话生成" : "事件"})</span>
                  </div>
                `)}
                ${o.traces.map((t) => html`
                  <div style="font-size:12px;margin-top:4px;color:#d29922;">🩸 ${t.text}
                    <span class="muted" style="font-size:10px;"> (tick ${t.addedTick})</span>
                  </div>
                `)}
                ${o.seenBy.length > 0 && html`<div class="muted" style="font-size:10px;margin-top:4px;">查看过：${o.seenBy.join("、")}</div>`}
              </div>
            `)}
          </div>
        `)}
      </div>

      <div>
        <h2 style="font-size:16px;margin-top:0;">案件账本</h2>
        ${cases.length === 0 && html`<div class="empty">（没有立案）</div>`}
        ${cases.map((c) => html`
          <div class="card" style="margin-bottom:8px;">
            <div class="title">[${c.status}] ${c.victimId} 丢了 ${c.amount} 金币</div>
            <div class="muted" style="font-size:11px;margin-top:4px;">
              立案 tick ${c.createdTick} ·
              ${c.publicSinceTick !== undefined ? `已公开 @ ${c.publicSinceTick}` : "尚未公开（只有引擎知道）"}
              ${c.closedTick !== undefined ? ` · 结案 @ ${c.closedTick}` : ""}
            </div>
            <div style="font-size:12px;margin-top:4px;">
              指控：${Object.entries(c.accusations).length === 0
                ? "（无人指控）"
                : Object.entries(c.accusations).map(([a, b]) => `${a}→${b}`).join("、")}
            </div>
            <div style="font-size:12px;margin-top:4px;color:#f85149;">
              真凶：${spoil ? c.perpId : "（勾选「显示剧透」查看）"}
            </div>
          </div>
        `)}

        <h2 style="font-size:16px;margin-top:18px;">线索执念（谁心里还挂着）</h2>
        ${leads.length === 0 && html`<div class="empty">（没有活着的线索执念）</div>`}
        ${leads.map((l) => html`
          <div class="card" style="margin-bottom:6px;">
            <div class="title">${l.characterName}</div>
            <div style="font-size:12px;">${l.summary}</div>
            <div class="muted" style="font-size:10px;margin-top:4px;">第 ${l.createdDay} 天起 · 保温 ${l.decayDays} 天 · 关联 ${l.relatedId ?? "—"}</div>
          </div>
        `)}

        <h2 style="font-size:16px;margin-top:18px;">断言账本（谁说了什么，世界怎么判的）</h2>
        ${claims.length === 0 && html`<div class="empty">（还没有断言被裁决）</div>`}
        ${[...claims].reverse().slice(0, 30).map((c) => html`
          <div class="card" style="margin-bottom:6px;">
            <div class="title">${c.speakerId} · ${VERDICT_LABEL[c.verdict] ?? c.verdict}</div>
            <div style="font-size:12px;">${c.claim}</div>
            <div class="muted" style="font-size:10px;margin-top:4px;">
              ${c.objectKey} · tick ${c.tick}${c.witnesses?.length ? ` · 旁听：${c.witnesses.join("、")}` : ""}
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}

// ===== 编年史页：世界自己报上来的重大事件与涌现 =====
// 设计前提是"我不想盯着看"：默认只给 ≥7 分、按天分组、每天一条头条。
// 涌现条目一律带机械判据（点开看 evidence）——凭什么说它是涌现，得说得清。

const CHRON_KIND_LABEL = {
  case: "案件", crime: "罪行", emergence: "涌现", relationship: "关系",
  survival: "生存", economy: "经济", fate: "命运", beat: "节拍",
  canon: "正典", milestone: "里程碑",
};
const IMPORTANCE_COLOR = (n) => (n >= 10 ? "#f85149" : n >= 9 ? "#d29922" : n >= 8 ? "#58a6ff" : "#8b949e");

function ChroniclePage() {
  const [data, setData] = useState(null);
  const [minImportance, setMin] = useState(7);
  const [kind, setKind] = useState("");
  const [actor, setActor] = useState("");
  const [emergenceOnly, setEmergenceOnly] = useState(false);
  const [openId, setOpenId] = useState(null);

  const reload = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ minImportance: String(minImportance), limit: "300" });
      if (kind) qs.set("kind", kind);
      if (actor) qs.set("actor", actor);
      if (emergenceOnly) qs.set("emergenceOnly", "1");
      setData(await api(`/api/chronicle?${qs}`));
    } catch (e) { toast("加载失败：" + e.message, "error"); }
  }, [minImportance, kind, actor, emergenceOnly]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);

  const digests = data?.digests ?? [];
  const names = data?.names ?? {};
  const nameOf = (id) => names[id] ?? id;
  const total = data?.entries?.length ?? 0;
  const emergenceTotal = (data?.entries ?? []).filter((e) => e.kind === "emergence").length;
  const open = (data?.entries ?? []).find((e) => e.id === openId);

  return html`
    <h1>编年史</h1>
    <div class="subtitle">世界自己报上来的事，不用你盯着看。两类：机械可判的重大事件，和没人编排却发生了的涌现（绿边那些）——每条涌现都带机械判据，点一下能看到凭什么这么判。</div>

    <div class="toolbar">
      <button style="flex:none;white-space:nowrap;" onClick=${reload}>刷新</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;white-space:nowrap;flex:none;">
        重要性 ≥
        <select value=${String(minImportance)} onChange=${(e) => setMin(+e.target.value)} style="width:70px;">
          ${[9, 8, 7, 5, 1].map((v) => html`<option value=${String(v)}>${v}</option>`)}
        </select>
      </label>
      <select value=${kind} onChange=${(e) => setKind(e.target.value)} style="flex:none;width:120px;">
        <option value="">全部类型</option>
        ${(data?.kinds ?? []).map((k) => html`<option value=${k}>${CHRON_KIND_LABEL[k] ?? k}</option>`)}
      </select>
      <select value=${actor} onChange=${(e) => setActor(e.target.value)} style="flex:none;width:120px;">
        <option value="">全部角色</option>
        ${Object.entries(names).map(([id, n]) => html`<option value=${id}>${n}</option>`)}
      </select>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;white-space:nowrap;flex:none;">
        <input type="checkbox" checked=${emergenceOnly} onChange=${(e) => setEmergenceOnly(e.target.checked)} /> 只看涌现
      </label>
      <div class="spacer"></div>
      <span class="muted" style="font-size:11px;white-space:nowrap;">共 ${data?.size ?? 0} 条 · 第 ${data?.day ?? 0} 天</span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;">
      <div class="card"><div class="title">当前筛选</div><div style="font-size:28px;font-weight:600;">${total}</div></div>
      <div class="card"><div class="title">其中涌现</div><div style="font-size:28px;font-weight:600;color:#3fb950;">${emergenceTotal}</div></div>
      <div class="card"><div class="title">有记录的天数</div><div style="font-size:28px;font-weight:600;">${digests.length}</div></div>
    </div>

    ${digests.length === 0 && html`<div class="empty">（还没有够格的记录。模拟跑起来、或把重要性阈值拉低试试）</div>`}

    ${digests.map((d) => html`
      <div style="margin-bottom:22px;">
        <div style="display:flex;align-items:baseline;gap:10px;border-bottom:1px solid #21262d;padding-bottom:6px;margin-bottom:10px;">
          <h2 style="font-size:16px;margin:0;">第 ${d.day} 天</h2>
          <span class="muted" style="font-size:11px;">
            ${d.entries.length} 条${d.emergenceCount > 0 ? ` · 涌现 ${d.emergenceCount}` : ""}
            ${d.byKind.length ? " · " + d.byKind.map((b) => `${CHRON_KIND_LABEL[b.kind] ?? b.kind}${b.count}`).join(" ") : ""}
          </span>
        </div>
        ${d.headline && html`
          <div class="card" style="margin-bottom:10px;border-color:${IMPORTANCE_COLOR(d.headline.importance)};">
            <div class="title" style="color:${IMPORTANCE_COLOR(d.headline.importance)};">今日头条</div>
            <div style="font-size:14px;">${d.headline.emoji} ${d.headline.title}</div>
          </div>
        `}
        ${d.entries.map((e) => html`
          <div class="card" style="margin-bottom:6px;cursor:pointer;border-left:3px solid ${e.kind === "emergence" ? "#3fb950" : IMPORTANCE_COLOR(e.importance)};"
               onClick=${() => setOpenId(openId === e.id ? null : e.id)}>
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">
              <span style="font-size:14px;">${e.emoji}</span>
              <strong style="font-size:13px;flex:1;">${e.title}</strong>
              ${e.kind === "emergence" && html`<span style="font-size:10px;color:#3fb950;border:1px solid #3fb950;border-radius:3px;padding:0 4px;">涌现</span>`}
              <span class="muted" style="font-size:10px;">${e.kind === "emergence" ? "" : (CHRON_KIND_LABEL[e.kind] ?? e.kind) + " · "}${e.importance} 分 · tick ${e.tick}</span>
            </div>
            ${e.detail && html`<div style="font-size:12px;margin-top:4px;color:#c9d1d9;">${e.detail}</div>`}
            <div class="muted" style="font-size:10px;margin-top:3px;">${e.actors.map(nameOf).join("、") || "—"}</div>
            ${openId === e.id && e.evidence && html`
              <div style="margin-top:8px;padding:8px;background:#010409;border:1px solid #21262d;border-radius:6px;">
                <div class="title" style="font-size:10px;">机械判据</div>
                <div style="font-size:11px;color:#8b949e;font-family:ui-monospace,monospace;word-break:break-all;">${e.evidence}</div>
              </div>
            `}
          </div>
        `)}
      </div>
    `)}
  `;
}

// ===== 提示词页：每次 LLM 调用的完整输入输出 + 缓存纪律归因 =====
// 项目本身是 agent 系统，"这一次到底喂了什么进去"此前只能翻控制台或落盘手工 diff。
// 这里在线看：按 kind/角色筛，点开看 system/工具表/messages/响应，
// 以及**前缀断点**——DeepSeek 前缀缓存按字节匹配，命中率掉了就是有动态内容回流进了前缀。

const KIND_LABEL = {
  decision: "决策", conversation: "对话", reflection: "反思",
  "morning-plan": "晨间打算", impression: "印象", observation: "观察推理",
  "fact-extract": "正典抽取", "stance-extract": "立场抽取",
  "transaction-extract": "交易抽取", director: "导演", unknown: "未标注",
};
const kindLabel = (k) => KIND_LABEL[k] ?? k;
const pct = (v) => (v === undefined || v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function PromptsPage() {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [kind, setKind] = useState("");
  const [tag, setTag] = useState("");
  const [auto, setAuto] = useState(true);
  const [openId, setOpenId] = useState(null);

  const reload = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (kind) qs.set("kind", kind);
      if (tag) qs.set("tag", tag);
      qs.set("limit", "200");
      const [list, st] = await Promise.all([
        api(`/api/prompts?${qs}`),
        api("/api/prompts/stats"),
      ]);
      setData(list);
      setStats(st);
    } catch (e) { toast("加载失败：" + e.message, "error"); }
  }, [kind, tag]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [auto, reload]);

  const clearAll = async () => {
    try {
      await api("/api/prompts", { method: "DELETE" });
      toast("已清空追踪缓冲");
      setOpenId(null);
      reload();
    } catch (e) { toast("失败：" + e.message, "error"); }
  };

  const items = data?.items ?? [];
  const total = stats?.total;

  if (data && !data.enabled) {
    return html`
      <h1>提示词</h1>
      <div class="empty">追踪已关闭（ANIMA_PROMPT_TRACE_KEEP=0）。去掉这个环境变量重启即可开启。</div>
    `;
  }

  return html`
    <h1>提示词</h1>
    <div class="subtitle">每次 LLM 调用的完整输入输出。DeepSeek 前缀缓存按逐字节匹配——命中率掉了就是有动态内容回流进了前缀，「前缀断点」直接指出断在第几字节、在工具表还是 system。</div>

    <div class="toolbar">
      <button style="flex:none;white-space:nowrap;" onClick=${reload}>刷新</button>
      <select value=${kind} onChange=${(e) => setKind(e.target.value)} style="flex:none;width:130px;">
        <option value="">全部类型</option>
        ${(stats?.kinds ?? []).map((k) => html`<option value=${k}>${kindLabel(k)}</option>`)}
      </select>
      <select value=${tag} onChange=${(e) => setTag(e.target.value)} style="flex:none;width:130px;">
        <option value="">全部角色</option>
        ${(stats?.tags ?? []).map((t) => html`<option value=${t}>${t}</option>`)}
      </select>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;white-space:nowrap;flex:none;">
        <input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.target.checked)} /> 自动刷新
      </label>
      <div class="spacer"></div>
      <span class="muted" style="font-size:11px;white-space:nowrap;">缓冲 ${data?.size ?? 0} 条</span>
      <button style="flex:none;white-space:nowrap;" onClick=${clearAll}>清空</button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;">
      <div class="card"><div class="title">调用</div><div style="font-size:28px;font-weight:600;">${total?.calls ?? 0}</div></div>
      <div class="card"><div class="title">输入 token</div><div style="font-size:28px;font-weight:600;">${(total?.inputTokens ?? 0).toLocaleString()}</div></div>
      <div class="card"><div class="title">输出 token</div><div style="font-size:28px;font-weight:600;">${(total?.outputTokens ?? 0).toLocaleString()}</div></div>
      <div class="card"><div class="title">缓存命中</div><div style="font-size:28px;font-weight:600;color:${(total?.cacheHitRate ?? 0) >= 0.6 ? "#3fb950" : "#d29922"};">${pct(total?.cacheHitRate)}</div></div>
      <div class="card"><div class="title">前缀断点</div><div style="font-size:28px;font-weight:600;color:${(total?.prefixBreaks ?? 0) > 0 ? "#d29922" : "#3fb950"};">${total?.prefixBreaks ?? 0}</div></div>
      <div class="card"><div class="title">失败</div><div style="font-size:28px;font-weight:600;color:${(total?.errors ?? 0) > 0 ? "#f85149" : "#8b949e"};">${total?.errors ?? 0}</div></div>
    </div>

    <h2 style="font-size:16px;">按调用类型</h2>
    <div class="card" style="padding:0;overflow-x:auto;margin-bottom:18px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="color:#8b949e;text-align:left;">
          <th style="padding:8px 12px;">类型</th><th>调用</th><th>输入</th><th>输出</th>
          <th>缓存命中</th><th>断点</th><th>均耗时</th><th>失败</th>
        </tr></thead>
        <tbody>
          ${(stats?.byKind ?? []).map((b) => html`
            <tr style="border-top:1px solid #21262d;">
              <td style="padding:8px 12px;">${kindLabel(b.kind)}</td>
              <td>${b.calls}</td>
              <td>${b.inputTokens.toLocaleString()}</td>
              <td>${b.outputTokens.toLocaleString()}</td>
              <td style="color:${b.cacheHitRate >= 0.6 ? "#3fb950" : b.cacheHitRate > 0 ? "#d29922" : "#8b949e"};">${pct(b.cacheHitRate)}</td>
              <td style="color:${b.prefixBreaks > 0 ? "#d29922" : "#8b949e"};">${b.prefixBreaks}</td>
              <td>${b.avgDurationMs} ms</td>
              <td style="color:${b.errors > 0 ? "#f85149" : "#8b949e"};">${b.errors}</td>
            </tr>
          `)}
          ${(stats?.byKind ?? []).length === 0 && html`<tr><td colspan="8" style="padding:20px;text-align:center;color:#484f58;">（还没有调用被记录）</td></tr>`}
        </tbody>
      </table>
    </div>

    <h2 style="font-size:16px;">调用记录</h2>
    ${items.length === 0 && html`<div class="empty">（空。模拟跑起来后这里会实时进条目）</div>`}
    ${items.map((r) => html`
      <div class="card" style="margin-bottom:6px;cursor:pointer;" onClick=${() => setOpenId(r.id)}>
        <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">
          <span class="muted" style="font-size:11px;">#${r.seq}</span>
          <strong style="font-size:13px;">${kindLabel(r.kind)}</strong>
          ${r.tag && html`<span style="font-size:12px;color:#58a6ff;">${r.tag}</span>`}
          ${r.tick !== undefined && html`<span class="muted" style="font-size:11px;">tick ${r.tick}</span>`}
          <div style="flex:1;"></div>
          ${r.error
            ? html`<span style="font-size:11px;color:#f85149;">失败</span>`
            : html`<span style="font-size:11px;color:${(r.cacheHitRate ?? 0) >= 0.6 ? "#3fb950" : "#d29922"};">缓存 ${pct(r.cacheHitRate)}</span>`}
          ${r.prefixIdentical
            ? html`<span style="font-size:11px;color:#3fb950;" title="前缀与上一次同类调用逐字节一致">前缀稳定</span>`
            : html`<span style="font-size:11px;color:#d29922;" title=${"首个分歧字节 " + r.prefixBreakAt}>${r.prefixBreakAt > 0 ? `断点 @${r.prefixBreakAt}` : "首次"}</span>`}
          <span class="muted" style="font-size:11px;">${r.durationMs} ms</span>
        </div>
        <div style="font-size:12px;margin-top:4px;color:#c9d1d9;">${r.preview || "（空响应）"}</div>
        <div class="muted" style="font-size:10px;margin-top:2px;">
          ${r.model} · 工具 ${r.toolCount} · 消息 ${r.messageCount} · 前缀 ${kb(r.prefixBytes)}
          ${r.inputTokens !== undefined ? ` · in ${r.inputTokens} / out ${r.outputTokens}` : ""}
        </div>
      </div>
    `)}

    ${openId && html`<${PromptDrawer} id=${openId} onClose=${() => setOpenId(null)} />`}
  `;
}

function PromptDrawer({ id, onClose }) {
  const [rec, setRec] = useState(null);
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    let alive = true;
    api(`/api/prompts/${id}`)
      .then((r) => { if (alive) setRec(r); })
      .catch((e) => toast("加载失败：" + e.message, "error"));
    return () => { alive = false; };
  }, [id]);

  const tabs = [
    ["overview", "概览"],
    ["prefix", "前缀断点"],
    ["system", "System"],
    ["tools", "工具表"],
    ["messages", "消息"],
    ["response", "响应"],
  ];
  const pre = "background:#010409;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:11px;color:#c9d1d9;white-space:pre-wrap;word-break:break-word;max-height:none;";

  return html`
    <div class="drawer-mask" onClick=${onClose}>
      <div class="drawer" style="width:min(900px,100vw);" onClick=${(e) => e.stopPropagation()}>
        <div class="drawer-header">
          <h2>${rec ? `#${rec.seq} ${kindLabel(rec.kind)}${rec.tag ? " · " + rec.tag : ""}` : "加载中…"}</h2>
          <button onClick=${onClose}>关闭</button>
        </div>
        <div class="drawer-tabs">
          ${tabs.map(([k, label]) => html`<button class=${tab === k ? "active" : ""} onClick=${() => setTab(k)}>${label}</button>`)}
        </div>
        <div class="drawer-body">
          ${!rec && html`<div class="empty">加载中…</div>`}
          ${rec && tab === "overview" && html`
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px;">
              <div class="card"><div class="title">模型</div><div style="font-size:13px;">${rec.model}</div></div>
              <div class="card"><div class="title">耗时</div><div style="font-size:13px;">${rec.durationMs} ms</div></div>
              <div class="card"><div class="title">tick</div><div style="font-size:13px;">${rec.tick ?? "—"}</div></div>
              <div class="card"><div class="title">输入 token</div><div style="font-size:13px;">${rec.usage?.inputTokens ?? "—"}</div></div>
              <div class="card"><div class="title">输出 token</div><div style="font-size:13px;">${rec.usage?.outputTokens ?? "—"}</div></div>
              <div class="card"><div class="title">缓存命中</div><div style="font-size:13px;">${pct(rec.cacheHitRate)}</div></div>
            </div>
            ${rec.error && html`<div class="card" style="border-color:#f85149;color:#f85149;margin-bottom:12px;"><div class="title">调用失败</div>${rec.error}</div>`}
            <div class="card" style="margin-bottom:10px;">
              <div class="title">采样参数</div>
              <div style="font-size:12px;">max_tokens ${rec.maxTokens ?? "默认"} · temperature ${rec.temperature ?? "默认"} · finish ${rec.finishReason ?? "—"}</div>
              ${rec.prefill && html`<div style="font-size:12px;margin-top:4px;">prefill：${rec.prefill}</div>`}
            </div>
            <div class="card">
              <div class="title">工具表（${rec.toolNames.length}）</div>
              <div style="font-size:12px;">${rec.toolNames.join("、") || "（无）"}</div>
            </div>
          `}
          ${rec && tab === "prefix" && html`
            ${rec.prefixBreak.identical
              ? html`<div class="card" style="border-color:#3fb950;">
                  <div class="title" style="color:#3fb950;">前缀逐字节一致</div>
                  <div style="font-size:12px;">与 ${rec.prefixBreak.comparedToId} 相比，工具表 + system 共 ${kb(rec.prefixBytes)} 一字节没动——这一次能吃到完整前缀缓存。</div>
                </div>`
              : !rec.prefixBreak.comparedToId
                ? html`<div class="card"><div class="title">首次调用</div><div style="font-size:12px;">这是该「类型 × 角色 × 模型」组合的第一次调用，没有前驱可比。</div></div>`
                : html`
                  <div class="card" style="border-color:#d29922;margin-bottom:12px;">
                    <div class="title" style="color:#d29922;">前缀在第 ${rec.prefixBreak.atByte} 字节断开（共 ${kb(rec.prefixBytes)}）</div>
                    <div style="font-size:12px;">分歧落在 <strong>${rec.prefixBreak.section === "tools" ? "工具表" : "system"}</strong>，与 ${rec.prefixBreak.comparedToId} 相比。断点之后的内容全部拿不到缓存。</div>
                  </div>
                  <div class="title">上一次（${rec.prefixBreak.comparedToId}）</div>
                  <pre style=${pre}>${rec.prefixBreak.prevSnippet}</pre>
                  <div class="title" style="margin-top:10px;">这一次</div>
                  <pre style=${pre}>${rec.prefixBreak.nextSnippet}</pre>
                `}
          `}
          ${rec && tab === "system" && html`
            <div class="muted" style="font-size:11px;margin-bottom:6px;">${kb(new Blob([rec.system]).size)}${rec.systemTruncated ? " · 已截断" : ""}</div>
            <pre style=${pre}>${rec.system || "（空——酒馆模式把 system 块内联在 messages 里）"}</pre>
          `}
          ${rec && tab === "tools" && html`
            <div class="muted" style="font-size:11px;margin-bottom:6px;">${rec.toolNames.length} 个工具${rec.toolsTruncated ? " · 已截断" : ""}</div>
            <pre style=${pre}>${rec.toolsJson ? JSON.stringify(safeParse(rec.toolsJson), null, 2) : "（本次调用没带工具表）"}</pre>
          `}
          ${rec && tab === "messages" && html`
            ${rec.messages.map((m, i) => html`
              <div style="margin-bottom:12px;">
                <div class="title">${i + 1}. ${m.role}${m.toolCallNames?.length ? ` → ${m.toolCallNames.join("、")}` : ""}${m.truncated ? "（已截断）" : ""}</div>
                <pre style=${pre}>${m.content || "（无正文）"}</pre>
              </div>
            `)}
          `}
          ${rec && tab === "response" && html`
            <div class="title">正文${rec.contentTruncated ? "（已截断）" : ""}</div>
            <pre style=${pre}>${rec.content || "（空）"}</pre>
            <div class="title" style="margin-top:12px;">工具调用</div>
            <pre style=${pre}>${rec.toolCalls.length ? JSON.stringify(rec.toolCalls, null, 2) : "（无）"}</pre>
          `}
        </div>
      </div>
    </div>
  `;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

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
