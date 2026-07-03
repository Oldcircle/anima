extends Node2D
## 世界 2.0 入口 —— 大地图像素小镇 + 室内场景 + 寻路 + 相机操控。
## 数据全部来自后端真实 WebSocket，节点在代码里程序化生成（不需要在编辑器摆场景）。
##
## 操作：左键拖拽平移 / 滚轮缩放 / 点角色跟随+看详情 / 点建筑进室内 / ESC 或按钮返回小镇

const Town := preload("res://world/Town.gd")
const CharacterView := preload("res://world/CharacterView.gd")
const DetailPanel := preload("res://ui/DetailPanel.gd")
const NarrativePanel := preload("res://ui/NarrativePanel.gd")

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
const FALLBACK_SKINS := ["Villager", "Villager3", "Villager4", "Woman", "OldMan"]

# 时段词 → [地图染色, 角色染色, 开灯]
const TIME_TINTS := {
	"深夜": [Color(0.3, 0.36, 0.68), Color(0.62, 0.68, 0.92), true],
	"夜":   [Color(0.42, 0.48, 0.78), Color(0.74, 0.78, 0.98), true],
	"晚上": [Color(0.42, 0.48, 0.78), Color(0.74, 0.78, 0.98), true],
	"傍晚": [Color(1.0, 0.76, 0.58), Color(1.0, 0.9, 0.82), true],
	"清晨": [Color(0.86, 0.89, 1.0), Color(0.95, 0.96, 1.0), false],
	"day":  [Color.WHITE, Color.WHITE, false],
}

const ZOOM_MIN := 1.2
const ZOOM_MAX := 4.0

# 天气英文枚举（后端 Weather 类型）→ 中文显示 / 特效
const WEATHER_CN := {
	"sunny": "晴", "cloudy": "多云", "rainy": "雨", "stormy": "暴雨", "snowy": "雪",
}
const WEATHER_DIM := {
	"sunny": 0.0, "cloudy": 0.12, "rainy": 0.18, "stormy": 0.3, "snowy": 0.06,
}
const BGM_DAY := "res://assets/ninja_adventure/music/calm_village.ogg"
const BGM_NIGHT := "res://assets/ninja_adventure/music/chill.ogg"

@onready var net: Node = $Net

var _town: Node2D
var _lights: Node2D
var _rooms: Node2D
var _chars_root: Node2D
var _views := {}           # char_id -> CharacterView
var _last_chars := {}      # char_id -> 最近一次 tick 的原始数据（离线详情用）
var _clock: Label
var _hint: Label
var _back_btn: Button
var _banner: PanelContainer
var _banner_lbl: Label
var _detail: CanvasLayer
var _cam: Camera2D
var _space := "town"       # "town" 或室内地点 id
var _town_cam := Vector2.ZERO
var _town_zoom := 2.2
var _follow: Node2D = null
var _dragging := false
var _drag_moved := false
var _got_snapshot := false
var _net_open := false
var _time_key := ""
var _bgm: AudioStreamPlayer
var _bgm_path := ""
var _rain: CPUParticles2D
var _snow: CPUParticles2D
var _dim: ColorRect
var _weather := ""
var _dialog: PanelContainer
var _dialog_face: TextureRect
var _dialog_name: Label
var _dialog_text: Label
var _dialog_timer: SceneTreeTimer
var _speed_btns := {}      # speed(float) -> Button
var _narrative: CanvasLayer

func _ready() -> void:
	get_viewport().physics_object_picking = true
	RenderingServer.set_default_clear_color(Color("11162a"))

	_town = Town.new()
	add_child(_town)
	_town.building_clicked.connect(_enter_room)

	_lights = Node2D.new()
	_lights.name = "Lights"
	add_child(_lights)

	_rooms = Node2D.new()   # 室内区：不吃夜色染色（屋里始终亮）
	_rooms.name = "Rooms"
	add_child(_rooms)

	_chars_root = Node2D.new()
	_chars_root.name = "Characters"
	_chars_root.y_sort_enabled = true
	add_child(_chars_root)

	_cam = Camera2D.new()
	_cam.position = Vector2(34 * Town.TILE, 16 * Town.TILE)   # 广场
	_cam.zoom = Vector2(_town_zoom, _town_zoom)
	add_child(_cam)
	_cam.make_current()

	_build_hud()

	_detail = DetailPanel.new()
	add_child(_detail)

	_bgm = AudioStreamPlayer.new()
	_bgm.volume_db = -14.0
	_bgm.bus = "Master"
	add_child(_bgm)

	_narrative = NarrativePanel.new()
	add_child(_narrative)
	net.connected.connect(func() -> void: _narrative.set_online(true))
	net.disconnected.connect(func() -> void: _narrative.set_online(false))

	net.connected.connect(func():
		_net_open = true
		print("[Main] ✅ 后端已连接"))
	net.disconnected.connect(func(): _net_open = false)
	net.snapshot.connect(_on_snapshot)
	net.tick.connect(_on_tick)
	net.beat_ready.connect(func(d): _show_banner("🎬 " + str(d.get("description", ""))))
	net.character_detail.connect(func(d): _detail.show_detail(d, _skin_for(str(d.get("id", "")))))
	print("[Main] 世界 2.0 — 等待后端 @ ws://localhost:3001 …")
	get_tree().create_timer(3.0).timeout.connect(_maybe_offline_demo)
	if "--shot" in OS.get_cmdline_user_args():
		_capture_and_quit()
	elif "--probe" in OS.get_cmdline_user_args():
		_run_probe()

## live 回归探针：连真后端跑 ~3 分钟，每 30 秒存一张截图后退出
func _run_probe() -> void:
	for i in 6:
		await get_tree().create_timer(30.0).timeout
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png("res://shot_live_%d.png" % i)
		print("[probe] saved shot_live_%d.png (space=%s)" % [i, _space])
	get_tree().quit()

# ---------------- HUD ----------------

func _build_hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)

	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override("panel", _jrpg_box())
	panel.position = Vector2(12, 12)
	layer.add_child(panel)
	_clock = Label.new()
	_clock.add_theme_font_size_override("font_size", 16)
	_clock.add_theme_color_override("font_color", Color("f5f0e8"))
	panel.add_child(_clock)

	_hint = Label.new()
	_hint.text = "拖拽平移 · 滚轮缩放 · 点角色跟随 · 点建筑进室内 · M 音乐 · N 叙事"
	_hint.add_theme_font_size_override("font_size", 12)
	_hint.add_theme_color_override("font_color", Color(0.9, 0.88, 0.8, 0.75))
	_hint.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.6))
	_hint.add_theme_constant_override("outline_size", 3)
	_hint.anchor_top = 1.0
	_hint.anchor_bottom = 1.0
	_hint.offset_left = 12
	_hint.offset_top = -30
	layer.add_child(_hint)

	_back_btn = Button.new()
	_back_btn.text = "← 返回小镇 (ESC)"
	_back_btn.add_theme_font_size_override("font_size", 14)
	_back_btn.anchor_left = 0.5
	_back_btn.anchor_right = 0.5
	_back_btn.offset_left = -80
	_back_btn.offset_top = 12
	_back_btn.visible = false
	_back_btn.pressed.connect(_exit_room)
	layer.add_child(_back_btn)

	_banner = PanelContainer.new()
	_banner.add_theme_stylebox_override("panel", _jrpg_box())
	_banner.anchor_left = 0.5
	_banner.anchor_right = 0.5
	_banner.offset_top = 48
	_banner.visible = false
	layer.add_child(_banner)
	_banner_lbl = Label.new()
	_banner_lbl.add_theme_font_size_override("font_size", 14)
	_banner_lbl.add_theme_color_override("font_color", Color("ffe9a8"))
	_banner.add_child(_banner_lbl)

	_build_weather(layer)
	_build_dialog(layer)
	_build_speed_panel(layer)

func _build_speed_panel(layer: CanvasLayer) -> void:
	# P4：调速（右上角，连上后端才可用）
	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override("panel", _jrpg_box())
	panel.anchor_left = 1.0
	panel.anchor_right = 1.0
	panel.offset_left = -262
	panel.offset_right = -12
	panel.offset_top = 12
	layer.add_child(panel)
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 4)
	panel.add_child(hb)
	for entry in [[0.0, "⏸"], [1.0, "1x"], [2.0, "2x"], [5.0, "5x"]]:
		var b := Button.new()
		b.text = entry[1]
		b.add_theme_font_size_override("font_size", 13)
		b.disabled = true
		b.pressed.connect(func() -> void: net.set_speed(entry[0]))
		hb.add_child(b)
		_speed_btns[entry[0]] = b
	var nb := Button.new()
	nb.text = "叙事"
	nb.add_theme_font_size_override("font_size", 13)
	nb.pressed.connect(func() -> void: _narrative.toggle())
	hb.add_child(nb)
	net.speed_changed.connect(_on_speed_changed)
	net.connected.connect(func() -> void:
		for s in _speed_btns:
			_speed_btns[s].disabled = false)
	net.disconnected.connect(func() -> void:
		for s in _speed_btns:
			_speed_btns[s].disabled = true)

func _on_speed_changed(speed: float) -> void:
	for s in _speed_btns:
		var b: Button = _speed_btns[s]
		b.modulate = Color("ffd27a") if is_equal_approx(s, speed) else Color.WHITE
	_show_banner("倍速 → %s" % ("暂停" if speed == 0.0 else str(speed) + "x"))

func _build_weather(layer: CanvasLayer) -> void:
	# 全屏遮罩：阴天/雨天压暗
	_dim = ColorRect.new()
	_dim.color = Color(0.02, 0.03, 0.1, 0.0)
	_dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	_dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
	layer.add_child(_dim)
	# 雨（屏幕空间粒子，斜落）
	_rain = CPUParticles2D.new()
	_rain.position = Vector2(600, -24)
	_rain.amount = 260
	_rain.lifetime = 1.1
	_rain.emission_shape = CPUParticles2D.EMISSION_SHAPE_RECTANGLE
	_rain.emission_rect_extents = Vector2(760, 8)
	_rain.direction = Vector2(0.18, 1)
	_rain.spread = 2.0
	_rain.gravity = Vector2(0, 0)
	_rain.initial_velocity_min = 720.0
	_rain.initial_velocity_max = 900.0
	_rain.scale_amount_min = 2.2
	_rain.scale_amount_max = 3.2
	_rain.color = Color(0.66, 0.78, 1.0, 0.72)
	_rain.emitting = false
	layer.add_child(_rain)
	# 雪（慢飘）
	_snow = CPUParticles2D.new()
	_snow.position = Vector2(640, -16)
	_snow.amount = 140
	_snow.lifetime = 7.0
	_snow.emission_shape = CPUParticles2D.EMISSION_SHAPE_RECTANGLE
	_snow.emission_rect_extents = Vector2(700, 8)
	_snow.direction = Vector2(0.05, 1)
	_snow.spread = 12.0
	_snow.gravity = Vector2(0, 6)
	_snow.initial_velocity_min = 80.0
	_snow.initial_velocity_max = 130.0
	_snow.scale_amount_min = 2.0
	_snow.scale_amount_max = 3.0
	_snow.color = Color(1, 1, 1, 0.8)
	_snow.emitting = false
	layer.add_child(_snow)

func _build_dialog(layer: CanvasLayer) -> void:
	# JRPG 底部对话框：头像 + 名字 + 台词（最近一条 talk）
	_dialog = PanelContainer.new()
	_dialog.add_theme_stylebox_override("panel", _jrpg_box())
	_dialog.anchor_left = 0.5
	_dialog.anchor_right = 0.5
	_dialog.anchor_top = 1.0
	_dialog.anchor_bottom = 1.0
	_dialog.offset_left = -330
	_dialog.offset_right = 330
	_dialog.offset_top = -118
	_dialog.offset_bottom = -40
	_dialog.visible = false
	layer.add_child(_dialog)
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 12)
	_dialog.add_child(hb)
	_dialog_face = TextureRect.new()
	_dialog_face.custom_minimum_size = Vector2(76, 76)
	_dialog_face.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_dialog_face.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	hb.add_child(_dialog_face)
	var vb := VBoxContainer.new()
	vb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hb.add_child(vb)
	_dialog_name = Label.new()
	_dialog_name.add_theme_font_size_override("font_size", 14)
	_dialog_name.add_theme_color_override("font_color", Color("ffd27a"))
	vb.add_child(_dialog_name)
	_dialog_text = Label.new()
	_dialog_text.add_theme_font_size_override("font_size", 14)
	_dialog_text.add_theme_color_override("font_color", Color("f5f0e8"))
	_dialog_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dialog_text.size_flags_vertical = Control.SIZE_EXPAND_FILL
	vb.add_child(_dialog_text)

func _show_dialog(char_id: String, display_name: String, text: String) -> void:
	var face := "res://assets/ninja_adventure/characters/%s/Faceset.png" % _skin_for(char_id)
	_dialog_face.texture = load(face) if ResourceLoader.exists(face) else null
	_dialog_name.text = display_name
	_dialog_text.text = text
	_dialog.visible = true
	_dialog_timer = get_tree().create_timer(7.0)
	var this_timer := _dialog_timer
	this_timer.timeout.connect(func() -> void:
		if _dialog_timer == this_timer:   # 没被更新的对话顶掉才隐藏
			_dialog.visible = false
	)

func _jrpg_box() -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.18, 0.92)
	sb.border_color = Color("f5f0e8")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3)
	sb.set_content_margin_all(8)
	return sb

func _show_banner(text: String) -> void:
	_banner_lbl.text = text
	_banner.reset_size()
	_banner.offset_left = -_banner.size.x / 2.0
	_banner.visible = true
	get_tree().create_timer(5.0).timeout.connect(func() -> void: _banner.visible = false)

# ---------------- 相机 ----------------

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT:
			_dragging = event.pressed
			if event.pressed:
				_drag_moved = false
		elif event.pressed and event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_zoom_at(event.position, 1.15)
		elif event.pressed and event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_zoom_at(event.position, 1.0 / 1.15)
	elif event is InputEventMouseMotion and _dragging:
		if event.relative.length() > 1.5:
			_drag_moved = true
			_follow = null
		_cam.position -= event.relative / _cam.zoom.x
		_clamp_cam()
	elif event is InputEventKey and event.pressed:
		if event.keycode == KEY_ESCAPE:
			if _narrative.is_open():
				_narrative.close()
			elif _space != "town":
				_exit_room()
		elif event.keycode == KEY_M:
			_bgm.playing = not _bgm.playing   # M 键开关音乐
		elif event.keycode == KEY_N:
			_narrative.toggle()               # N 键开关叙事面板

func _zoom_at(screen_pos: Vector2, factor: float) -> void:
	var z: float = clampf(_cam.zoom.x * factor, ZOOM_MIN, ZOOM_MAX)
	var before := _cam.get_canvas_transform().affine_inverse() * screen_pos
	_cam.zoom = Vector2(z, z)
	var after := _cam.get_canvas_transform().affine_inverse() * screen_pos
	_cam.position += before - after
	_clamp_cam()

func _process(_dt: float) -> void:
	if _follow and is_instance_valid(_follow):
		# 跟随的角色进出室内时，镜头也跟着切换空间
		var char_space: String = _follow.get_meta("space", "town")
		if char_space != _space:
			var keep := _follow
			if char_space == "town":
				_exit_room()
			else:
				_enter_room(char_space)
			_follow = keep
			return
		_cam.position = _cam.position.lerp(_follow.position, 0.12)
		_clamp_cam()

func _clamp_cam() -> void:
	var view := Vector2(get_viewport_rect().size) / _cam.zoom.x
	var rect := Rect2(0, 0, Town.MAP_W * Town.TILE, Town.MAP_H * Town.TILE)
	if _space != "town":
		rect = _town.room_rect(_space).grow(48)
	if view.x >= rect.size.x:
		_cam.position.x = rect.get_center().x
	else:
		_cam.position.x = clampf(_cam.position.x, rect.position.x + view.x / 2.0, rect.end.x - view.x / 2.0)
	if view.y >= rect.size.y:
		_cam.position.y = rect.get_center().y
	else:
		_cam.position.y = clampf(_cam.position.y, rect.position.y + view.y / 2.0, rect.end.y - view.y / 2.0)

func _enter_room(id: String) -> void:
	if _space == id or not _town.is_interior(id):
		return
	if _space == "town":
		_town_cam = _cam.position
		_town_zoom = _cam.zoom.x
	_space = id
	_follow = null
	var r: Rect2 = _town.room_rect(id)
	var z: float = clampf(minf(get_viewport_rect().size.x / (r.size.x + 96), get_viewport_rect().size.y / (r.size.y + 96)), ZOOM_MIN, 3.2)
	var tw := create_tween().set_parallel(true).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_property(_cam, "position", r.get_center(), 0.35)
	tw.tween_property(_cam, "zoom", Vector2(z, z), 0.35)
	_back_btn.visible = true
	_hint.text = "%s · ESC 返回小镇" % _town.name_for(id)

func _exit_room() -> void:
	if _space == "town":
		return
	_space = "town"
	_follow = null
	var tw := create_tween().set_parallel(true).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_property(_cam, "position", _town_cam, 0.35)
	tw.tween_property(_cam, "zoom", Vector2(_town_zoom, _town_zoom), 0.35)
	_back_btn.visible = false
	_hint.text = "拖拽平移 · 滚轮缩放 · 点角色跟随 · 点建筑进室内"

# ---------------- 截图 / 离线演示 ----------------

func _capture_and_quit() -> void:
	await get_tree().create_timer(4.6).timeout
	var args := OS.get_cmdline_user_args()
	var ri := args.find("--room")
	if "--panel" in args:
		_narrative.toggle()
	if ri != -1 and ri + 1 < args.size():
		_enter_room(args[ri + 1])
		await get_tree().create_timer(0.6).timeout
	elif "--wide" in args:
		_cam.zoom = Vector2(1.2, 1.2)
		_cam.position = Vector2(Town.MAP_W * Town.TILE / 2.0, Town.MAP_H * Town.TILE / 2.0)
		_clamp_cam()
		await get_tree().create_timer(0.2).timeout
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("res://shot.png")
	print("[shot] saved res://shot.png")
	get_tree().quit()

func _maybe_offline_demo() -> void:
	if _got_snapshot:
		return
	print("[Main] 未连后端 → 离线演示（假数据，仅预览美术）")
	var args := OS.get_cmdline_user_args()
	var demo_time := "Y1 spring D2 上午 10:00" if "--day" in args else "Y1 spring D1 晚上 21:30"
	var demo_weather := "rainy" if "--rain" in args else "sunny"
	_on_snapshot({
		"locations": _town.demo_locations(),
		"characters": _demo_characters(),
		"formattedTime": demo_time,
		"weather": demo_weather,
	})
	if _views.has("asuka"): _views["asuka"].say("客人真多，忙不过来了！", "thought")
	if _views.has("lelouch"): _views["lelouch"].say("「今晚的海风真舒服」", "talk")
	if _views.has("rei"): _views["rei"].set_mood("happy")
	if _views.has("shinji"): _views["shinji"].set_mood("lonely")
	# 1.4 秒后来一个假 tick：跨空间进店 + 沙滩寻路走动
	get_tree().create_timer(1.4).timeout.connect(func() -> void:
		var chars := _demo_characters()
		for c in chars:
			if c["id"] == "light": c["locationId"] = "cafe"        # 小镇 → 室内（瞬移进店）
			if c["id"] == "shinji": c["locationId"] = "beach"      # 码头 → 沙滩（栈桥寻路）
			if c["id"] == "senjougahara": c["locationId"] = "plaza" # 室内 → 小镇
		_on_tick({"tick": "demo", "formattedTime": _clock.text.split("   ")[0],
			"weather": _weather, "characters": chars,
			"events": [{"characterId": "lelouch", "action": "talk",
				"args": {"message": "今晚的海风真舒服，要不要去码头走走？"}}]})
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

# ---------------- 世界状态 ----------------

func _skin_for(id: String) -> String:
	if CHAR_SKINS.has(id):
		return CHAR_SKINS[id]
	return FALLBACK_SKINS[abs(id.hash()) % FALLBACK_SKINS.size()]

func _on_snapshot(data: Dictionary) -> void:
	_got_snapshot = true
	_town.build(data.get("locations", []), _lights, _rooms)
	var chars: Array = data.get("characters", [])
	for c in chars:
		_ensure_view(str(c.get("id", "")), str(c.get("name", "")))
	_place_all(chars, false)
	_apply_expressions(chars)
	_update_badges(chars)
	_update_clock(data)
	_narrative.set_characters(chars.map(func(c): return [str(c.get("id", "")), str(c.get("name", ""))]))
	print("[Main] snapshot：已生成 %d 个角色并就位" % _views.size())

func _on_tick(data: Dictionary) -> void:
	var chars: Array = data.get("characters", [])
	for c in chars:
		_ensure_view(str(c.get("id", "")), str(c.get("name", "")))
	_place_all(chars, true)
	_apply_expressions(chars)
	_update_badges(chars)
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
	if _drag_moved:
		return
	var v = _views.get(id, null)
	if v:
		_follow = v
	_detail.show_detail(_last_chars.get(id, {"id": id, "name": id}), _skin_for(id))
	if _net_open:
		net.request_character(id)

func _place_all(chars: Array, animated: bool) -> void:
	var counts := {}
	for c in chars:
		var id: String = str(c.get("id", ""))
		var loc: String = str(c.get("locationId", ""))
		if not _views.has(id):
			continue
		_last_chars[id] = c
		var idx: int = counts.get(loc, 0)
		counts[loc] = idx + 1
		var v = _views[id]
		var target: Vector2 = _town.slot(loc, idx)
		var new_space: String = _town.space_of(loc)
		var old_space: String = v.get_meta("space", "town")
		var moved: bool = v.location_id != loc
		v.location_id = loc
		v.set_name_stagger(idx % 2 == 1)
		v.set_meta("space", new_space)
		if not animated or (moved and new_space != old_space):
			v.place_at(target)          # 初始化 / 进出室内：瞬移
		elif moved and new_space == "town":
			v.walk_path(_town.path_points(v.position, target))
		elif v.position.distance_to(target) > 2.0:
			v.walk_path(PackedVector2Array([target]))   # 室内挪位 / 同地点换槽
	# 变化后的占位徽章会在 _update_badges 里刷新

func _update_badges(chars: Array) -> void:
	var by_loc := {}
	for c in chars:
		var loc: String = str(c.get("locationId", ""))
		if _town.is_interior(loc):
			if not by_loc.has(loc):
				by_loc[loc] = []
			by_loc[loc].append(_skin_for(str(c.get("id", ""))))
	for id in _town.ROOMS:
		_town.update_badge(id, by_loc.get(id, []))

func _apply_expressions(chars: Array) -> void:
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
				var cid := str(e.get("characterId", ""))
				var cname := str(_last_chars.get(cid, {}).get("name", cid))
				_show_dialog(cid, cname, msg)
				talks += 1
				continue
		var thought = e.get("thought", null)
		if thought != null and str(thought) != "":
			v.say(str(thought), "thought")
			thoughts += 1
	return Vector2i(thoughts, talks)

func _update_clock(data: Dictionary) -> void:
	var formatted := str(data.get("formattedTime", "?"))
	var weather := str(data.get("weather", ""))
	_clock.text = "%s   %s" % [_pretty_time(formatted), WEATHER_CN.get(weather, weather)]
	_apply_time_of_day(formatted)
	_apply_weather(weather)

## "Y1 spring D1 清晨 06:15" → "春 第1天 · 清晨 06:15"（后端 formatGameTime 的格式）
func _pretty_time(formatted: String) -> String:
	var re := RegEx.create_from_string("^Y(\\d+) (spring|summer|autumn|winter) D(\\d+) (.+)$")
	var m := re.search(formatted)
	if m == null:
		return formatted
	var season: String = {"spring": "春", "summer": "夏", "autumn": "秋", "winter": "冬"}[m.get_string(2)]
	return "%s 第%s天 · %s" % [season, m.get_string(3), m.get_string(4)]

func _apply_weather(weather: String) -> void:
	if weather == _weather:
		return
	_weather = weather
	_rain.emitting = weather in ["rainy", "stormy"]
	_rain.amount = 460 if weather == "stormy" else 260
	_snow.emitting = weather == "snowy"
	var dim: float = WEATHER_DIM.get(weather, 0.0)
	create_tween().tween_property(_dim, "color:a", dim, 1.0)

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
	_play_bgm(BGM_NIGHT if tint[2] else BGM_DAY)

func _play_bgm(path: String) -> void:
	if _bgm_path == path or "--shot" in OS.get_cmdline_user_args():
		return
	_bgm_path = path
	var stream: AudioStream = load(path)
	if stream is AudioStreamOggVorbis:
		stream.loop = true
	_bgm.stream = stream
	_bgm.play()
