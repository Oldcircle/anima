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
var _action_lbl: Label
var _name_lbl: Label
var _name_y := 0.0

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
	create_tween().tween_property(b, "modulate:a", 1.0, 0.18)
	var timer := get_tree().create_timer(4.5)
	timer.timeout.connect(func() -> void:
		if is_instance_valid(b):
			var out := create_tween()
			out.tween_property(b, "modulate:a", 0.0, 0.25)
			out.tween_callback(b.queue_free)
	)

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
	sb.set_corner_radius_all(3)
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
