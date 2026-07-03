extends Node2D
## P1b — Ninja Adventure 像素小镇 + 角色随 locationId 移动 + 想法/对话气泡 + 情绪 + 点角色看详情。
## 数据全部来自后端真实 WebSocket，节点在代码里程序化生成（不需要在编辑器摆场景）。
## 昼夜：按 formattedTime 的时段词给地图染色，夜里亮暖窗光。

const Town := preload("res://world/Town.gd")
const CharacterView := preload("res://world/CharacterView.gd")
const DetailPanel := preload("res://ui/DetailPanel.gd")

# 7 角色 → Ninja Adventure 精灵皮肤（assets/ninja_adventure/characters/）
const CHAR_SKINS := {
	"asuka":        "Village6",    # 红发少女
	"l_lawliet":    "Inspector",   # 侦探帽
	"lelouch":      "Noble",       # 黑衣贵族
	"light":        "Boy",         # 清爽优等生
	"rei":          "Spirit",      # 苍白幽灵系
	"senjougahara": "Princess",    # 紫长发
	"shinji":       "Villager2",   # 朴素少年
}
# 未知角色（换剧本时）从备用池按 id 哈希取皮肤
const FALLBACK_SKINS := ["Villager", "Villager3", "Villager4", "Woman", "OldMan"]

# 时段词 → [地图染色, 角色染色, 开灯]（来自后端 timeOfDayLabel：深夜/清晨/早上/上午/中午/下午/傍晚/晚上）
const TIME_TINTS := {
	"深夜": [Color(0.3, 0.36, 0.68), Color(0.62, 0.68, 0.92), true],
	"夜":   [Color(0.42, 0.48, 0.78), Color(0.74, 0.78, 0.98), true],
	"晚上": [Color(0.42, 0.48, 0.78), Color(0.74, 0.78, 0.98), true],
	"傍晚": [Color(1.0, 0.76, 0.58), Color(1.0, 0.9, 0.82), true],
	"清晨": [Color(0.86, 0.89, 1.0), Color(0.95, 0.96, 1.0), false],
	"day":  [Color.WHITE, Color.WHITE, false],
}

@onready var net: Node = $Net

var _town: Node2D
var _lights: Node2D
var _chars_root: Node2D
var _views := {}          # char_id -> CharacterView
var _clock: Label
var _detail: CanvasLayer
var _got_snapshot := false
var _time_key := ""

func _ready() -> void:
	get_viewport().physics_object_picking = true   # 让角色 Area2D 能收到点击
	RenderingServer.set_default_clear_color(Color("11162a"))

	_town = Town.new()
	add_child(_town)

	_lights = Node2D.new()   # 夜景灯光：不吃 _town 的夜色染色，负责"亮"
	_lights.name = "Lights"
	add_child(_lights)

	_chars_root = Node2D.new()
	_chars_root.name = "Characters"
	_chars_root.y_sort_enabled = true
	add_child(_chars_root)

	var cam := Camera2D.new()
	cam.position = Vector2(Town.MAP_W * Town.TILE / 2.0, Town.MAP_H * Town.TILE / 2.0)
	cam.zoom = Vector2(2.0, 2.0)
	add_child(cam)
	cam.make_current()

	var layer := CanvasLayer.new()
	add_child(layer)
	_clock = _make_clock(layer)

	_detail = DetailPanel.new()
	add_child(_detail)

	net.connected.connect(func(): print("[Main] ✅ 后端已连接"))
	net.disconnected.connect(func(): print("[Main] ⚠️  后端断开"))
	net.snapshot.connect(_on_snapshot)
	net.tick.connect(_on_tick)
	net.beat_ready.connect(func(d): print("[🎬 beat] ", d.get("description", "")))
	net.character_detail.connect(func(d): _detail.show_detail(d, _skin_for(str(d.get("id", "")))))
	print("[Main] P1b 像素小镇 — 等待后端 @ ws://localhost:3001 …")
	# 3 秒没连上后端 → 离线演示（假数据），不用起 LLM 也能看美术
	get_tree().create_timer(3.0).timeout.connect(_maybe_offline_demo)
	# 带 `-- --shot` 启动：等离线演示就位后截一张 PNG 再退出（给开发看效果用）
	if "--shot" in OS.get_cmdline_user_args():
		_capture_and_quit()

func _make_clock(layer: CanvasLayer) -> Label:
	# JRPG 风时钟牌：深蓝底 + 白边框 + 像素字
	var panel := PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.18, 0.92)
	sb.border_color = Color("f5f0e8")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3)
	sb.set_content_margin_all(8)
	panel.add_theme_stylebox_override("panel", sb)
	panel.position = Vector2(12, 12)
	layer.add_child(panel)
	var lbl := Label.new()
	lbl.add_theme_font_size_override("font_size", 16)
	lbl.add_theme_color_override("font_color", Color("f5f0e8"))
	panel.add_child(lbl)
	return lbl

func _capture_and_quit() -> void:
	await get_tree().create_timer(4.6).timeout   # 等离线演示 + 昼夜染色 tween 完成
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("res://shot.png")
	print("[shot] saved res://shot.png")
	get_tree().quit()

func _maybe_offline_demo() -> void:
	if _got_snapshot:
		return
	print("[Main] 未连后端 → 离线演示（假数据，仅预览美术）")
	var demo_time := "上午 10:00" if "--day" in OS.get_cmdline_user_args() else "晚上 21:30"
	_on_snapshot({
		"locations": _town.demo_locations(),
		"characters": _demo_characters(),
		"formattedTime": demo_time,
		"weather": "晴",
	})
	# 演示气泡/情绪，让静态预览也能看到 P2 效果
	if _views.has("asuka"): _views["asuka"].say("该收摊回家了…", "thought")
	if _views.has("lelouch"): _views["lelouch"].say("「今晚的海风真舒服」", "talk")
	if _views.has("rei"): _views["rei"].set_mood("happy")
	if _views.has("shinji"): _views["shinji"].set_mood("lonely")
	# 1.4 秒后来一个假 tick：让两人走动，验证行走动画/换向
	get_tree().create_timer(1.4).timeout.connect(func() -> void:
		var chars := _demo_characters()
		for c in chars:
			if c["id"] == "light": c["locationId"] = "cafe"
			if c["id"] == "senjougahara": c["locationId"] = "plaza"
		_on_tick({"tick": "demo", "formattedTime": _clock.text.split("   ")[0],
			"weather": "晴", "characters": chars, "events": []})
	)

func _demo_characters() -> Array:
	var spots := {
		"asuka": ["明日香", "cafe"], "l_lawliet": ["L", "library"],
		"lelouch": ["鲁鲁修", "plaza"], "light": ["夜神月", "plaza"],
		"rei": ["绫波丽", "beach"], "senjougahara": ["战场原", "bar"],
		"shinji": ["真嗣", "dock"],
	}
	var out := []
	for cid in spots:
		out.append({"id": cid, "name": spots[cid][0], "locationId": spots[cid][1], "moodlets": []})
	return out

func _skin_for(id: String) -> String:
	if CHAR_SKINS.has(id):
		return CHAR_SKINS[id]
	return FALLBACK_SKINS[abs(id.hash()) % FALLBACK_SKINS.size()]

func _on_snapshot(data: Dictionary) -> void:
	_got_snapshot = true
	_town.build(data.get("locations", []), _lights)
	var chars: Array = data.get("characters", [])
	for c in chars:
		_ensure_view(str(c.get("id", "")), str(c.get("name", "")))
	_place_all(chars, false)
	_apply_expressions(chars)
	_update_clock(data)
	print("[Main] snapshot：已生成 %d 个角色并就位" % _views.size())

func _on_tick(data: Dictionary) -> void:
	var chars: Array = data.get("characters", [])
	for c in chars:
		_ensure_view(str(c.get("id", "")), str(c.get("name", "")))
	_place_all(chars, true)
	_apply_expressions(chars)
	var counts := _apply_bubbles(data.get("events", []))
	_update_clock(data)
	print("[tick %s] %s %s | 想法=%d 对话=%d" % [
		data.get("tick", "?"), data.get("formattedTime", "?"),
		data.get("weather", "?"), counts.x, counts.y,
	])

func _ensure_view(id: String, display_name: String) -> void:
	if id == "" or _views.has(id):
		return
	var v := CharacterView.new()
	_chars_root.add_child(v)
	v.setup(id, display_name, _skin_for(id))
	v.clicked.connect(_on_char_clicked)
	_views[id] = v

func _on_char_clicked(id: String) -> void:
	net.request_character(id)

func _place_all(chars: Array, animated: bool) -> void:
	var counts := {}
	for c in chars:
		var id: String = str(c.get("id", ""))
		var loc: String = str(c.get("locationId", ""))
		if not _views.has(id):
			continue
		var idx: int = counts.get(loc, 0)
		counts[loc] = idx + 1
		var v = _views[id]
		v.location_id = loc
		v.set_name_stagger(idx % 2 == 1)
		v.move_to(_town.slot(loc, idx), animated)

func _apply_expressions(chars: Array) -> void:
	# 情绪 emote + 动作标签（来自 characters[].moodlets / observableState / currentAction）
	for c in chars:
		var v = _views.get(str(c.get("id", "")), null)
		if v == null:
			continue
		var moods = c.get("moodlets", [])
		v.set_mood(str(moods[0].get("emotion", "")) if moods is Array and not moods.is_empty() else "")
		var act := ""
		var obs = c.get("observableState", null)
		var ca = c.get("currentAction", null)
		if obs is Dictionary:
			act = str(obs.get("summary", ""))
		elif ca is Dictionary:
			act = str(ca.get("name", ""))
		v.set_action(act)

func _apply_bubbles(events: Array) -> Vector2i:
	# 优先对话台词，其次内心独白。返回 (想法数, 对话数)
	var thoughts := 0
	var talks := 0
	for e in events:
		var v = _views.get(str(e.get("characterId", "")), null)
		if v == null:
			continue
		if str(e.get("action", "")) == "talk":
			var args = e.get("args", null)
			var msg := str(args.get("message", "")) if args is Dictionary else ""
			if msg != "":
				v.say("「%s」" % msg, "talk")
				talks += 1
				continue
		var thought = e.get("thought", null)
		if thought != null and str(thought) != "":
			v.say(str(thought), "thought")
			thoughts += 1
	return Vector2i(thoughts, talks)

func _update_clock(data: Dictionary) -> void:
	var formatted := str(data.get("formattedTime", "?"))
	_clock.text = "%s   %s" % [formatted, data.get("weather", "?")]
	_apply_time_of_day(formatted)

func _apply_time_of_day(formatted: String) -> void:
	var key := "day"
	for k in ["深夜", "晚上", "夜", "傍晚", "清晨"]:
		if formatted.contains(k):
			key = k
			break
	if key == _time_key:
		return
	_time_key = key
	var tint: Array = TIME_TINTS[key]
	var tw := create_tween().set_parallel(true)
	tw.tween_property(_town, "modulate", tint[0], 1.2)
	tw.tween_property(_chars_root, "modulate", tint[1], 1.2)
	_lights.visible = tint[2]
