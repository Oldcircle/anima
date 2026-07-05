extends Node2D
## 像素角色（Ninja Adventure 16px 四方向精灵）：
## 行走动画 + 影子 + 名牌 + JRPG 对话/想法气泡 + 情绪 emote + 动作标签 + 可点击。
## 原点在脚底（配合 Characters 根节点的 y-sort）。

signal clicked(char_id: String)

const CHAR_DIR := "res://assets/ninja_adventure/characters/"
const EMOTE_DIR := "res://assets/ninja_adventure/emotes/"

# 后端 moodlets.emotion -> emote 图（对照 Ui/Emote 图集：e2 开心、e7 生气、e29 乌云…）
const MOOD_EMOTE := {
	"happy": "emote2", "sad": "emote13", "angry": "emote7", "embarrassed": "emote19",
	"anxious": "emote15", "confident": "emote8", "lonely": "emote29", "grateful": "emote27",
}
# Walk.png / Idle.png 的列顺序（列 = 朝向，行 = 帧）
const DIRS := ["down", "up", "left", "right"]

var char_id: String = ""
var location_id: String = ""
var _sprite: AnimatedSprite2D
var _dir := "down"
var _tween: Tween
var _bubble: Control
var _mood: Sprite2D
var _flash: Sprite2D          # 行为瞬时 emote（睡觉/吵架/收礼/发呆…），与持续情绪分开
var _flash_seq := 0
var _need_badge: PanelContainer   # 生存告警徽章（饿/困/寂…），头顶常驻直到需求缓解
var _need_lbl: Label
var _need_sb: StyleBoxFlat
var _need_text := ""
var _need_urgent := false
var _need_tween: Tween
var _action_lbl: Label
var _name_lbl: Label
var _name_y := 0.0
var _transitioning := false      # 正在跨空间过渡（走到门→淡出→现身→走进）——期间外部别再指派移动
# 场景内自动闲逛（站着不动太假）：锚点 + 半径 + 落点可行性校验
var _wander_anchor := Vector2.INF
var _wander_radius := 0.0
var _wander_check: Callable = Callable()
var _wander_cd := 0.0

func setup(id: String, display_name: String, skin: String) -> void:
	char_id = id

	var shadow := Sprite2D.new()
	shadow.texture = load(CHAR_DIR + "Shadow.png")
	shadow.position = Vector2(0, -1)
	shadow.modulate = Color(1, 1, 1, 0.6)
	add_child(shadow)

	_sprite = AnimatedSprite2D.new()
	_sprite.sprite_frames = _build_frames(skin)
	_sprite.position = Vector2(0, -8)   # 原点在脚底，精灵中心上移半格
	_sprite.play("idle_down")
	add_child(_sprite)

	_name_lbl = Label.new()
	_name_lbl.text = display_name
	_name_lbl.add_theme_font_size_override("font_size", 12)
	_name_lbl.add_theme_color_override("font_color", Color("ffffff"))
	_name_lbl.add_theme_color_override("font_outline_color", Color("1a1626"))
	_name_lbl.add_theme_constant_override("outline_size", 4)
	add_child(_name_lbl)
	_name_lbl.reset_size()
	_name_y = -20 - _name_lbl.size.y
	_name_lbl.position = Vector2(-_name_lbl.size.x / 2.0, _name_y)

	var area := Area2D.new()
	var cs := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = Vector2(18, 22)
	cs.shape = shape
	cs.position = Vector2(0, -9)
	area.add_child(cs)
	area.input_event.connect(_on_area_input)
	add_child(area)

func _build_frames(skin: String) -> SpriteFrames:
	var dir := CHAR_DIR + skin + "/"
	var idle: Texture2D = load(dir + "Idle.png")
	var walk: Texture2D = load(dir + "Walk.png")
	var frames := SpriteFrames.new()
	for i in DIRS.size():
		var d: String = DIRS[i]
		frames.add_animation("idle_" + d)
		frames.set_animation_loop("idle_" + d, true)
		var it := AtlasTexture.new()
		it.atlas = idle
		it.region = Rect2(i * 16, 0, 16, 16)
		frames.add_frame("idle_" + d, it)
		frames.add_animation("walk_" + d)
		frames.set_animation_loop("walk_" + d, true)
		frames.set_animation_speed("walk_" + d, 8.0)
		for f in 4:
			var wt := AtlasTexture.new()
			wt.atlas = walk
			wt.region = Rect2(i * 16, f * 16, 16, 16)
			frames.add_frame("walk_" + d, wt)
	frames.remove_animation("default")
	return frames

## 同一地点挤多人时，奇数槽位名牌抬高一档，避免相邻名字连成一串
func set_name_stagger(odd: bool) -> void:
	if _name_lbl:
		_name_lbl.position.y = _name_y - (13.0 if odd else 0.0)

func _on_area_input(_vp: Node, event: InputEvent, _idx: int) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		clicked.emit(char_id)

## 瞬移（初始化 / 跨空间：进出室内不走路）
func place_at(target: Vector2) -> void:
	if _tween and _tween.is_running():
		_tween.kill()
	position = target
	if _sprite:
		_sprite.play("idle_" + _dir)

## 沿寻路途径点走过去；总时长压在 budget 秒内（模拟加速时不落后）。
## face_pos 给定时，走完后面向该点（对话凑近用）。
func walk_path(points: PackedVector2Array, budget: float = 3.2, face_pos: Vector2 = Vector2.INF) -> void:
	if points.is_empty():
		return
	if _tween and _tween.is_running():
		_tween.kill()
	var total := 0.0
	var prev := position
	for p in points:
		total += prev.distance_to(p)
		prev = p
	if total < 2.0:
		position = points[-1]
		if face_pos != Vector2.INF:
			face_towards(face_pos)
		return
	var speed := maxf(80.0, total / budget)
	_tween = create_tween()
	prev = position
	for p in points:
		var seg := prev.distance_to(p)
		if seg < 1.0:
			prev = p
			continue
		var dir := _dir_of(p - prev)
		_tween.tween_callback(func() -> void:
			_dir = dir
			_sprite.play("walk_" + _dir)
		)
		_tween.tween_property(self, "position", p, seg / speed)
		prev = p
	_tween.tween_callback(func() -> void:
		if face_pos != Vector2.INF:
			face_towards(face_pos)
		else:
			_sprite.play("idle_" + _dir)
	)

func is_walking() -> bool:
	return _tween != null and _tween.is_running()

func is_transitioning() -> bool:
	return _transitioning

## 走一段路并等它走完（供跨空间过渡串联使用）。
## 用计时器兜底而非 await _tween.finished——tween 若被外部 kill 不会发 finished，
## 那样会让整段过渡永久卡在 transitioning。walk_path 实际时长 ≤ budget，故 budget+ 余量必然覆盖。
func _walk_await(points: PackedVector2Array, budget: float, face_pos: Vector2 = Vector2.INF) -> void:
	if points.is_empty():
		return
	walk_path(points, budget, face_pos)
	if _tween != null and _tween.is_running():
		await get_tree().create_timer(budget + 0.2).timeout

func _fade_to(a: float, t: float) -> void:
	var tw := create_tween()
	tw.tween_property(self, "modulate:a", a, t)
	await tw.finished

## 跨空间过渡：一串「走 / 淡出换位」步骤串起来——
## 小镇↔室内是空间不连续的，用「走到门口 → 淡出 → 在另一侧门口现身 → 走进去」代替生硬瞬移。
## steps: [["walk", PackedVector2Array, budget, face], ["warp", Vector2 pos, String new_space], ...]
func run_move_plan(steps: Array) -> void:
	if _transitioning:
		return
	_transitioning = true
	_wander_cd = 3.0   # 过渡后别马上闲逛
	for step in steps:
		if not is_instance_valid(self):
			return
		match step[0]:
			"walk":
				var face: Vector2 = step[3] if step.size() > 3 else Vector2.INF
				await _walk_await(step[1], step[2], face)
			"warp":
				await _fade_to(0.0, 0.16)
				position = step[1]
				if step.size() > 2:
					set_meta("space", step[2])
				_dir = "down"
				if _sprite:
					_sprite.play("idle_down")
				await _fade_to(1.0, 0.16)
		if not _transitioning:   # 被外部打断（罕见）
			return
	_transitioning = false

# ---------------- 场景内自动闲逛 ----------------

## 每 tick 由 Main 更新：anchor=当前站点、radius=闲逛半径、check(px)->bool 落点可行性
func configure_wander(anchor: Vector2, radius: float, check: Callable) -> void:
	_wander_anchor = anchor
	_wander_radius = radius
	_wander_check = check

func _process(delta: float) -> void:
	if _transitioning or is_walking() or _wander_radius <= 0.0 or _wander_anchor == Vector2.INF:
		return
	_wander_cd -= delta
	if _wander_cd > 0.0:
		return
	_wander_cd = randf_range(2.8, 6.5)
	# 在锚点附近随机挑个落点
	var ang := randf() * TAU
	var dist := randf_range(7.0, _wander_radius)
	var target := _wander_anchor + Vector2(cos(ang), sin(ang)) * dist
	# 沿直线段采样校验（闲逛不走寻路），任一点不可走就这轮不走——
	# 防户外穿墙/穿树/穿水；室内用凸的房间 rect 判定，端点在内则整段在内，天然通过
	if _wander_check.is_valid():
		for t in [0.34, 0.67, 1.0]:
			if not bool(_wander_check.call(position.lerp(target, t))):
				return
	walk_path(PackedVector2Array([target]), 1.8)

## 面向某个世界坐标（对话/送礼时转身）
func face_towards(pos: Vector2) -> void:
	var delta := pos - position
	if delta.length() < 1.0:
		return
	_dir = _dir_of(delta)
	_sprite.play("idle_" + _dir)

## 行为瞬时 emote：头顶左侧闪现几秒（与右侧的持续情绪 emote 并存）
func flash_emote(emote: String, dur: float = 4.0) -> void:
	if _flash == null:
		_flash = Sprite2D.new()
		_flash.position = Vector2(-14, -42)
		_flash.z_index = 15
		add_child(_flash)
	_flash.texture = load(EMOTE_DIR + emote + ".png")
	_flash.visible = true
	_flash_seq += 1
	var seq := _flash_seq
	get_tree().create_timer(dur).timeout.connect(func() -> void:
		if _flash_seq == seq and is_instance_valid(_flash):
			_flash.visible = false
	)

## 生存告警徽章：需求跌破阈值时头顶挂一个「饿/困/寂…」小牌，urgent 时红底脉动。
## text 为空 → 隐藏。数据每 tick 从 needs 推导（见 Main._apply_need_alerts）。
func set_need_alert(text: String, urgent: bool) -> void:
	if text == "":
		_need_text = ""
		if _need_badge:
			_need_badge.visible = false
		if _need_tween:
			_need_tween.kill()
		return
	if _need_badge == null:
		_need_sb = StyleBoxFlat.new()
		_need_sb.set_border_width_all(1)
		_need_sb.border_color = Color("1a1626")
		_need_sb.set_corner_radius_all(3)
		_need_sb.set_content_margin_all(2)
		_need_badge = PanelContainer.new()
		_need_badge.add_theme_stylebox_override("panel", _need_sb)
		_need_badge.z_index = 16
		_need_lbl = Label.new()
		_need_lbl.add_theme_font_size_override("font_size", 11)
		_need_lbl.add_theme_color_override("font_color", Color("fff4e0"))
		_need_badge.add_child(_need_lbl)
		add_child(_need_badge)
	var changed := text != _need_text or urgent != _need_urgent
	_need_text = text
	_need_urgent = urgent
	_need_lbl.text = text
	_need_sb.bg_color = Color(0.82, 0.24, 0.24, 0.95) if urgent else Color(0.86, 0.6, 0.15, 0.95)
	_need_badge.visible = true
	if not changed:
		return   # 同一告警持续中：别每 tick 重置尺寸/脉动，免得抖动
	_need_badge.reset_size()
	_need_badge.position = Vector2(-_need_badge.size.x / 2.0, _name_y - 16.0)
	if _need_tween:
		_need_tween.kill()
	if urgent:
		_need_badge.modulate.a = 1.0
		_need_tween = create_tween().set_loops()
		_need_tween.tween_property(_need_badge, "modulate:a", 0.35, 0.5)
		_need_tween.tween_property(_need_badge, "modulate:a", 1.0, 0.5)
	else:
		_need_badge.modulate.a = 1.0

## 头顶飘字（挣钱/花钱的金币增减、以后也可复用）：升起淡出
func float_text(text: String, color: Color) -> void:
	var lbl := Label.new()
	lbl.text = text
	lbl.add_theme_font_size_override("font_size", 12)
	lbl.add_theme_color_override("font_color", color)
	lbl.add_theme_color_override("font_outline_color", Color(0.1, 0.08, 0.15, 0.9))
	lbl.add_theme_constant_override("outline_size", 3)
	lbl.z_index = 22
	add_child(lbl)
	lbl.reset_size()
	var start := Vector2(-lbl.size.x / 2.0, -30.0)
	lbl.position = start
	var tw := create_tween()
	tw.tween_property(lbl, "position:y", start.y - 22.0, 1.1).set_trans(Tween.TRANS_SINE)
	tw.parallel().tween_property(lbl, "modulate:a", 0.0, 1.1).set_ease(Tween.EASE_IN)
	tw.tween_callback(lbl.queue_free)

func _dir_of(delta: Vector2) -> String:
	if absf(delta.x) > absf(delta.y):
		return "right" if delta.x > 0 else "left"
	return "down" if delta.y > 0 else "up"

func say(text: String, kind: String) -> void:
	if _bubble and is_instance_valid(_bubble):
		_bubble.queue_free()
	var b := _build_bubble(text, kind)
	add_child(b)
	_bubble = b
	b.modulate.a = 0.0
	# 等一帧让容器算出尺寸，再水平居中到头顶 + 贴 JRPG 小尾巴
	await get_tree().process_frame
	if not is_instance_valid(b):
		return
	b.position = Vector2(-b.size.x / 2.0, -34.0 - b.size.y)
	_attach_tail(b, kind)
	create_tween().tween_property(b, "modulate:a", 1.0, 0.18)
	var hold := 5.0 if kind == "talk" else 4.0
	var timer := get_tree().create_timer(hold)
	timer.timeout.connect(func() -> void:
		if is_instance_valid(b):
			var out := create_tween()
			out.tween_property(b, "modulate:a", 0.0, 0.25)
			out.tween_callback(b.queue_free)
	)

## 气泡小尾巴：台词=向下白描三角，想法=三个渐小的小圆点
func _attach_tail(panel: Control, kind: String) -> void:
	var cx: float = panel.size.x / 2.0
	if kind == "talk":
		var tail := Polygon2D.new()
		tail.polygon = PackedVector2Array([Vector2(-5, -1), Vector2(5, -1), Vector2(0, 8)])
		tail.color = Color(0.07, 0.08, 0.18, 0.94)
		tail.position = Vector2(cx, panel.size.y)
		panel.add_child(tail)
		var edge := Line2D.new()
		edge.points = PackedVector2Array([Vector2(-5, -1), Vector2(0, 8), Vector2(5, -1)])
		edge.width = 2.0
		edge.default_color = Color("f5f0e8")
		edge.position = Vector2(cx, panel.size.y)
		panel.add_child(edge)
	else:
		for i in 3:
			var dot := _dot(3.2 - i * 0.7, Color(0.95, 0.92, 0.83, 0.94), Color(0.45, 0.4, 0.32))
			dot.position = Vector2(cx - 5 + i * 3, panel.size.y + 3 + i * 6)
			panel.add_child(dot)

func _dot(radius: float, fill: Color, border: Color) -> Node2D:
	var n := Node2D.new()
	var pts := PackedVector2Array()
	for i in 10:
		var a := TAU * i / 10.0
		pts.append(Vector2(cos(a), sin(a)) * radius)
	var poly := Polygon2D.new()
	poly.polygon = pts
	poly.color = fill
	n.add_child(poly)
	var ln := Line2D.new()
	var loop := pts.duplicate()
	loop.append(pts[0])
	ln.points = loop
	ln.width = 1.0
	ln.default_color = border
	n.add_child(ln)
	return n

func _build_bubble(text: String, kind: String) -> Control:
	# JRPG 对话框：台词 = 深蓝底白字白框；想法 = 羊皮纸底深字
	var panel := PanelContainer.new()
	var sb := StyleBoxFlat.new()
	if kind == "talk":
		sb.bg_color = Color(0.07, 0.08, 0.18, 0.94)
		sb.border_color = Color("f5f0e8")
	else:
		sb.bg_color = Color(0.95, 0.92, 0.83, 0.94)
		sb.border_color = Color(0.45, 0.4, 0.32)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3 if kind == "talk" else 9)   # 想法更圆润像云朵
	sb.set_content_margin_all(7)
	panel.add_theme_stylebox_override("panel", sb)

	var lbl := Label.new()
	lbl.text = text
	lbl.add_theme_color_override("font_color",
		Color("f5f0e8") if kind == "talk" else Color("3a3226"))
	lbl.add_theme_font_size_override("font_size", 12)
	lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lbl.custom_minimum_size = Vector2(140, 0)
	panel.add_child(lbl)

	panel.position = Vector2(-75, -86)
	panel.z_index = 20
	return panel

func set_mood(emotion: String) -> void:
	if _mood == null:
		_mood = Sprite2D.new()
		_mood.position = Vector2(14, -42)   # 名牌右上方，避免互相遮挡
		_mood.z_index = 15
		add_child(_mood)
	var emote: String = MOOD_EMOTE.get(emotion, "")
	_mood.visible = emote != ""
	if emote != "":
		_mood.texture = load(EMOTE_DIR + emote + ".png")

func set_action(text: String) -> void:
	if _action_lbl == null:
		_action_lbl = Label.new()
		_action_lbl.add_theme_font_size_override("font_size", 12)
		_action_lbl.add_theme_color_override("font_color", Color("d8d2c4"))
		_action_lbl.add_theme_color_override("font_outline_color", Color(0.1, 0.08, 0.15, 0.9))
		_action_lbl.add_theme_constant_override("outline_size", 3)
		_action_lbl.scale = Vector2(0.75, 0.75)   # 12px 像素字缩到 9px 视觉
		add_child(_action_lbl)
	_action_lbl.text = text
	_action_lbl.reset_size()
	_action_lbl.position = Vector2(-_action_lbl.size.x * 0.75 / 2.0, 3)
