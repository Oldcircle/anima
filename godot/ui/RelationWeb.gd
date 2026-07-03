extends CanvasLayer
## 关系网可视化（R 键 / HUD「关系」按钮）：一眼看全镇社交脉络。
## 角色沿圆环排布，两两之间的关系画成连线——颜色=关系类型、粗细=亲密/敌对强度。
## 纯前端，消费 tick/snapshot 已下发的 relationships[]（{a,b,level,type,bond}）+ characters[]。

const CHAR_DIR := "res://assets/ninja_adventure/characters/"

# 关系类型 → 连线颜色（后端 RelationType）
const TYPE_COLOR := {
	"best_friend": Color(0.32, 0.86, 0.42),
	"close_friend": Color(0.46, 0.8, 0.5),
	"friend": Color(0.62, 0.78, 0.55),
	"acquaintance": Color(0.62, 0.64, 0.68),
	"rival": Color(0.92, 0.36, 0.34),
	"romantic": Color(0.96, 0.5, 0.72),
	"stranger": Color(0.4, 0.42, 0.48),
}
# 图例
const LEGEND := [
	["挚友/好友", Color(0.4, 0.83, 0.46)],
	["点头之交", Color(0.62, 0.64, 0.68)],
	["宿敌", Color(0.92, 0.36, 0.34)],
	["暧昧/恋人", Color(0.96, 0.5, 0.72)],
]

var _panel: Control
var _graph: Control
var _skin_of: Callable
var _chars: Array = []
var _rels: Array = []

func _ready() -> void:
	_panel = Control.new()
	_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	_panel.visible = false
	add_child(_panel)

	var dim := ColorRect.new()
	dim.color = Color(0.04, 0.05, 0.1, 0.82)
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP   # 吃掉点击，别穿透到小镇
	_panel.add_child(dim)

	var title := Label.new()
	title.text = "◆ 小镇关系网"
	title.add_theme_font_size_override("font_size", 18)
	title.add_theme_color_override("font_color", Color("ffd27a"))
	title.position = Vector2(24, 18)
	_panel.add_child(title)

	var hint := Label.new()
	hint.text = "R / ESC 关闭"
	hint.add_theme_font_size_override("font_size", 12)
	hint.add_theme_color_override("font_color", Color(0.8, 0.82, 0.86))
	hint.position = Vector2(28, 46)
	_panel.add_child(hint)

	_build_legend()

	_graph = Control.new()
	_graph.set_anchors_preset(Control.PRESET_FULL_RECT)
	_graph.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel.add_child(_graph)

func _build_legend() -> void:
	var box := VBoxContainer.new()
	box.position = Vector2(24, 80)
	box.add_theme_constant_override("separation", 4)
	_panel.add_child(box)
	for entry in LEGEND:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 6)
		var swatch := ColorRect.new()
		swatch.color = entry[1]
		swatch.custom_minimum_size = Vector2(18, 4)
		swatch.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		row.add_child(swatch)
		var lbl := Label.new()
		lbl.text = entry[0]
		lbl.add_theme_font_size_override("font_size", 12)
		lbl.add_theme_color_override("font_color", Color(0.85, 0.87, 0.9))
		row.add_child(lbl)
		box.add_child(row)

func set_skin_resolver(cb: Callable) -> void:
	_skin_of = cb

## 每 tick / snapshot 喂数据（可见时才重绘）
func update_web(chars: Array, rels: Array) -> void:
	_chars = chars
	_rels = rels
	if _panel.visible:
		_render()

func toggle() -> void:
	_panel.visible = not _panel.visible
	if _panel.visible:
		_render()

func is_open() -> bool:
	return _panel.visible

func close() -> void:
	_panel.visible = false

# ---------------- 渲染 ----------------

func _render() -> void:
	for ch in _graph.get_children():
		ch.queue_free()
	if _chars.is_empty():
		return
	var vp := _panel.get_viewport_rect().size
	var center := Vector2(vp.x * 0.5, vp.y * 0.52)
	var radius: float = minf(vp.x, vp.y) * 0.33
	var n := _chars.size()

	# 每个角色在圆环上的坐标 + id→index
	var pos := {}
	var idx := 0
	for c in _chars:
		var ang := -PI / 2.0 + float(idx) / float(n) * TAU
		pos[str(c.get("id", ""))] = center + Vector2(cos(ang), sin(ang)) * radius
		idx += 1

	# 先画连线（在节点下层）
	for r in _rels:
		var a := str(r.get("a", ""))
		var b := str(r.get("b", ""))
		if not pos.has(a) or not pos.has(b):
			continue
		var type := str(r.get("type", "stranger"))
		var level := int(r.get("level", 0))
		# 只画有意义的关系：非陌生人，或亲密/敌对到一定程度
		if type == "stranger" and abs(level) < 12:
			continue
		var line := Line2D.new()
		line.add_point(pos[a])
		line.add_point(pos[b])
		line.width = clampf(1.5 + abs(level) / 22.0, 1.5, 6.0)
		line.default_color = TYPE_COLOR.get(type, TYPE_COLOR["stranger"])
		line.default_color.a = 0.85
		line.antialiased = true
		_graph.add_child(line)
		# bond 身份（恋人/前任/宿敌…）在连线中点标个小字
		var bond := str(r.get("bond", ""))
		if bond != "":
			_add_bond_tag((pos[a] + pos[b]) * 0.5, bond)

	# 再画节点（头像 + 名字）
	for c in _chars:
		_add_node(pos[str(c.get("id", ""))], c)

func _add_node(p: Vector2, c: Dictionary) -> void:
	var face := TextureRect.new()
	face.custom_minimum_size = Vector2(38, 38)
	face.size = Vector2(38, 38)
	face.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	face.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	face.position = p - Vector2(19, 19)
	if _skin_of.is_valid():
		var fp: String = CHAR_DIR + str(_skin_of.call(str(c.get("id", "")))) + "/Faceset.png"
		if ResourceLoader.exists(fp):
			face.texture = load(fp)
	_graph.add_child(face)
	var nm := Label.new()
	nm.text = str(c.get("name", ""))
	nm.add_theme_font_size_override("font_size", 12)
	nm.add_theme_color_override("font_color", Color("f5f0e8"))
	nm.add_theme_color_override("font_outline_color", Color("14121f"))
	nm.add_theme_constant_override("outline_size", 4)
	_graph.add_child(nm)
	nm.reset_size()
	nm.position = p + Vector2(-nm.size.x / 2.0, 20)

func _add_bond_tag(p: Vector2, bond: String) -> void:
	var cn: String = {
		"partner": "恋人", "ex": "前任", "colleague": "同事",
		"roommate": "室友", "mentor": "师徒", "rival": "宿敌",
	}.get(bond, bond)
	var lbl := Label.new()
	lbl.text = cn
	lbl.add_theme_font_size_override("font_size", 11)
	lbl.add_theme_color_override("font_color", Color("ffe9a8"))
	lbl.add_theme_color_override("font_outline_color", Color("14121f"))
	lbl.add_theme_constant_override("outline_size", 3)
	_graph.add_child(lbl)
	lbl.reset_size()
	lbl.position = p - lbl.size / 2.0
