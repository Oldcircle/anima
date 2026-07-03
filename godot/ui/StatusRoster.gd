extends CanvasLayer
## JRPG 镇民状态名册（Tab 或「名册」按钮开关）：一眼看全镇 AI 的生存状态。
## 每行：像素头像 + 名字 + 当前动作 + 饿/困 迷你血条 + 最紧迫需求高亮标签。
## 数据来自每 tick 的 characters（needs / observableState / currentAction），零后端改动。

const CHAR_DIR := "res://assets/ninja_adventure/characters/"

# 需求 → 中文单字标签（低=差，0-100）
const NEED_CN := {
	"hunger": "饿", "energy": "困", "social": "寂",
	"hygiene": "脏", "fun": "闷", "bladder": "急",
}
# 各需求 [urgent 阈值, moderate 阈值]（与后端 need-definitions 对齐）
const NEED_THRESH := {
	"hunger": [15, 32], "energy": [15, 32], "social": [15, 30],
	"hygiene": [20, 32], "fun": [15, 32], "bladder": [15, 30],
}

var _panel: PanelContainer
var _list: VBoxContainer
var _last: Array = []
var _skin_of: Callable

func _ready() -> void:
	_panel = PanelContainer.new()
	_panel.position = Vector2(12, 118)
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.18, 0.92)
	sb.border_color = Color("f5f0e8")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3)
	sb.set_content_margin_all(10)
	_panel.add_theme_stylebox_override("panel", sb)

	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 6)
	_panel.add_child(vb)

	var title := Label.new()
	title.text = "◆ 镇民状态"
	title.add_theme_font_size_override("font_size", 14)
	title.add_theme_color_override("font_color", Color("ffd27a"))
	vb.add_child(title)

	var sep := HSeparator.new()
	vb.add_child(sep)

	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 7)
	_list.custom_minimum_size = Vector2(244, 0)
	vb.add_child(_list)

	add_child(_panel)
	_panel.visible = false

func set_skin_resolver(cb: Callable) -> void:
	_skin_of = cb

## 每 tick / snapshot 调用：喂最新角色数组（可见时才重绘）
func update_roster(chars: Array) -> void:
	_last = chars
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
	for ch in _list.get_children():
		ch.queue_free()
	if _last.is_empty():
		var empty := Label.new()
		empty.text = "（等待后端…）"
		empty.add_theme_font_size_override("font_size", 12)
		empty.add_theme_color_override("font_color", Color("8a93a0"))
		_list.add_child(empty)
		return
	for c in _last:
		_list.add_child(_build_row(c))

func _build_row(c: Dictionary) -> Control:
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 8)

	# 像素头像
	var face := TextureRect.new()
	face.custom_minimum_size = Vector2(30, 30)
	face.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	face.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	if _skin_of.is_valid():
		var fp: String = CHAR_DIR + str(_skin_of.call(str(c.get("id", "")))) + "/Faceset.png"
		if ResourceLoader.exists(fp):
			face.texture = load(fp)
	hb.add_child(face)

	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 2)
	vb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hb.add_child(vb)

	# 名字 + 当前动作 + 最紧迫需求标签
	var top := HBoxContainer.new()
	top.add_theme_constant_override("separation", 6)
	var nm := Label.new()
	nm.text = str(c.get("name", ""))
	nm.add_theme_font_size_override("font_size", 13)
	nm.add_theme_color_override("font_color", Color("f5f0e8"))
	top.add_child(nm)
	var act := _action_of(c)
	if act != "":
		var al := Label.new()
		al.text = act
		al.add_theme_font_size_override("font_size", 11)
		al.add_theme_color_override("font_color", Color("8fa0b0"))
		al.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		top.add_child(al)
	var alert := _worst_need(c.get("needs", null))
	if alert[0] != "":
		var tag := Label.new()
		tag.text = alert[0] + ("!" if alert[1] else "")
		tag.add_theme_font_size_override("font_size", 12)
		tag.add_theme_color_override("font_color",
			Color(0.95, 0.4, 0.38) if alert[1] else Color(0.97, 0.78, 0.35))
		top.add_child(tag)
	if c.get("gold") != null:
		var gold := Label.new()
		gold.text = "%d金" % int(c["gold"])
		gold.add_theme_font_size_override("font_size", 11)
		gold.add_theme_color_override("font_color", _finance_color(str(c.get("finance", ""))))
		top.add_child(gold)
	vb.add_child(top)

	# 饿 / 困 迷你血条（生存最关键两项）
	var needs = c.get("needs", null)
	if needs is Dictionary:
		var bars := HBoxContainer.new()
		bars.add_theme_constant_override("separation", 12)
		bars.add_child(_need_bar("饿", float(needs.get("hunger", 100))))
		bars.add_child(_need_bar("困", float(needs.get("energy", 100))))
		vb.add_child(bars)

	return hb

func _need_bar(label: String, v: float) -> Control:
	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 3)
	var l := Label.new()
	l.text = label
	l.add_theme_font_size_override("font_size", 11)
	l.add_theme_color_override("font_color", Color("b8c0cc"))
	box.add_child(l)
	var bar := Control.new()
	bar.custom_minimum_size = Vector2(48, 9)
	var bg := ColorRect.new()
	bg.color = Color(0, 0, 0, 0.45)
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bar.add_child(bg)
	var fill := ColorRect.new()
	fill.color = _need_color(v)
	fill.position = Vector2(1, 1)
	fill.size = Vector2(46.0 * clampf(v / 100.0, 0.0, 1.0), 7)
	fill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bar.add_child(fill)
	box.add_child(bar)
	return box

func _need_color(v: float) -> Color:
	if v >= 60.0:
		return Color(0.45, 0.82, 0.45)
	if v >= 30.0:
		return Color(0.95, 0.76, 0.32)
	return Color(0.92, 0.36, 0.34)

## 财务状态 → 金币数字颜色（后端 financeLabel 下发）
func _finance_color(finance: String) -> Color:
	match finance:
		"揭不开锅", "拮据":
			return Color(0.92, 0.36, 0.34)
		"手头紧":
			return Color(0.95, 0.76, 0.32)
		"宽裕", "宽松":
			return Color(0.55, 0.82, 0.5)
		_:
			return Color(0.9, 0.78, 0.4)   # 够用 = 金币色

func _action_of(c: Dictionary) -> String:
	var obs = c.get("observableState", null)
	if obs is Dictionary and str(obs.get("summary", "")) != "":
		return str(obs.get("summary", ""))
	var ca = c.get("currentAction", null)
	if ca is Dictionary:
		return str(ca.get("name", ""))
	return ""

## 返回 [中文标签, urgent?]；没有告警返回 ["", false]
func _worst_need(needs) -> Array:
	if not (needs is Dictionary):
		return ["", false]
	var best_label := ""
	var best_urgent := false
	var best_val := 999.0
	for k in needs:
		if not NEED_THRESH.has(k):
			continue
		var v := float(needs[k])
		var th: Array = NEED_THRESH[k]
		if v >= th[1]:
			continue
		var urgent: bool = v < th[0]
		if (urgent and not best_urgent) or (urgent == best_urgent and v < best_val):
			best_val = v
			best_label = NEED_CN[k]
			best_urgent = urgent
	return [best_label, best_urgent]
