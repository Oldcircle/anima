extends CanvasLayer
## P2 — 点角色弹出的详情面板（JRPG 风：深蓝底白框 + 像素头像）。
## 数据来自后端 character_detail（get_character 的回执）。
## 形状：{ ...character, memories[], relationships[], impressions[] }

const CHAR_DIR := "res://assets/ninja_adventure/characters/"

var _panel: PanelContainer
var _face: TextureRect
var _label: RichTextLabel

func _ready() -> void:
	_panel = PanelContainer.new()
	_panel.anchor_left = 1.0
	_panel.anchor_right = 1.0
	_panel.offset_left = -320
	_panel.offset_right = -12
	_panel.offset_top = 12
	_panel.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	_panel.grow_vertical = Control.GROW_DIRECTION_END

	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.18, 0.94)
	sb.border_color = Color("f5f0e8")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3)
	sb.set_content_margin_all(12)
	_panel.add_theme_stylebox_override("panel", sb)

	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 6)
	_panel.add_child(vb)

	var top := HBoxContainer.new()
	top.add_theme_constant_override("separation", 8)
	vb.add_child(top)

	_face = TextureRect.new()
	_face.custom_minimum_size = Vector2(76, 76)
	_face.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_face.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	top.add_child(_face)

	var close := Button.new()
	close.text = "关闭"
	close.size_flags_horizontal = Control.SIZE_SHRINK_END | Control.SIZE_EXPAND
	close.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
	close.pressed.connect(func() -> void: _panel.visible = false)
	top.add_child(close)

	_label = RichTextLabel.new()
	_label.bbcode_enabled = true
	_label.fit_content = true
	_label.scroll_active = false
	_label.custom_minimum_size = Vector2(296, 0)
	_label.add_theme_color_override("default_color", Color("e8ebef"))
	_label.add_theme_font_size_override("normal_font_size", 12)
	_label.add_theme_font_size_override("bold_font_size", 12)
	vb.add_child(_label)

	add_child(_panel)
	_panel.visible = false

func show_detail(d: Dictionary, skin: String = "") -> void:
	var id := str(d.get("id", ""))
	if skin != "":
		var face_path := CHAR_DIR + skin + "/Faceset.png"
		_face.texture = load(face_path) if ResourceLoader.exists(face_path) else null
	var out := PackedStringArray()
	out.append("[b]%s[/b]  [color=#8a93a0](%s)[/color]" % [d.get("name", id), id])

	var needs = d.get("needs", null)
	if needs is Dictionary and not needs.is_empty():
		var parts := PackedStringArray()
		for k in needs:
			parts.append("%s %d" % [k, int(needs[k])])
		out.append("[color=#8a93a0]需求[/color] " + ", ".join(parts))

	var life = d.get("life", null)
	if life is Dictionary:
		if life.has("occupation") and life["occupation"]:
			out.append("[color=#8a93a0]职业[/color] %s" % life["occupation"])
		if life.has("currentGoal") and life["currentGoal"]:
			out.append("[color=#8a93a0]目标[/color] %s" % life["currentGoal"])
		if life.has("currentConcern") and life["currentConcern"]:
			out.append("[color=#8a93a0]心事[/color] %s" % life["currentConcern"])

	for m in d.get("moodlets", []):
		out.append("[color=#c9a227]情绪[/color] %s — %s" % [m.get("emotion", ""), m.get("reason", "")])

	var rels = d.get("relationships", null)
	if rels is Array and not rels.is_empty():
		out.append("[b]关系[/b]")
		for r in rels:
			var other = r.get("characterB", "") if str(r.get("characterA", "")) == id else r.get("characterA", "")
			out.append("  - %s: %s (%d)" % [other, r.get("type", ""), int(r.get("level", 0))])

	var mems = d.get("memories", null)
	if mems is Array and not mems.is_empty():
		out.append("[b]最近记忆[/b]")
		var start := maxi(0, mems.size() - 8)
		for i in range(start, mems.size()):
			out.append("  · %s" % mems[i].get("content", ""))

	var imps = d.get("impressions", null)
	if imps is Array and not imps.is_empty():
		out.append("[b]印象[/b]")
		for imp in imps:
			out.append("  %s: %s" % [imp.get("characterId", ""), imp.get("summary", "")])

	_label.text = "\n".join(out)
	_panel.visible = true
