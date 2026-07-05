extends CanvasLayer
## 生活记录（L 或「记录」按钮开关）：滚动的对话 / 行为 / 内心活动时间线。
##
## 补上前端最大的缺口——气泡和底部对话框都是瞬时的，看不到历史；而反思 / 流言 /
## 随机事件这些「内心与世界的活动」此前根本没被渲染。这里把每 tick 下发的
## events(对话/想法/动作) + reflections(睡前反思) + gossips + randomEvents + beats
## 全部累积成一条可回看的日式 RPG 事件日志，按类型上色。零后端改动。

const MAX_ENTRIES := 240
const CHAR_DIR := "res://assets/ninja_adventure/characters/"

# kind -> [图标, 颜色]
const KIND_STYLE := {
	"talk":       ["💬", Color("bfe3ff")],
	"thought":    ["💭", Color("cdbce8")],
	"action":     ["✦", Color("9fe0c4")],
	"reflection": ["🌙", Color("e0a6e8")],
	"gossip":     ["🗣", Color("f0cd8a")],
	"event":      ["⚡", Color("ffe08a")],
	"beat":       ["🎬", Color("ffd27a")],
	"system":     ["·", Color("9fd0ff")],
}

var _panel: PanelContainer
var _scroll: ScrollContainer
var _list: VBoxContainer
var _count := 0
var _skin_of: Callable
var _empty: Label

func _ready() -> void:
	_panel = PanelContainer.new()
	# 右侧、调速面板下方，纵向占大半屏
	_panel.anchor_left = 1.0
	_panel.anchor_right = 1.0
	_panel.anchor_bottom = 1.0
	_panel.offset_left = -366
	_panel.offset_right = -12
	_panel.offset_top = 54
	_panel.offset_bottom = -128
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.18, 0.9)
	sb.border_color = Color("f5f0e8")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3)
	sb.set_content_margin_all(10)
	_panel.add_theme_stylebox_override("panel", sb)

	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 6)
	_panel.add_child(vb)

	var title := Label.new()
	title.text = "◆ 生活记录"
	title.add_theme_font_size_override("font_size", 14)
	title.add_theme_color_override("font_color", Color("ffd27a"))
	vb.add_child(title)
	var hint := Label.new()
	hint.text = "对话 · 内心 · 行为 · 反思 · 流言"
	hint.add_theme_font_size_override("font_size", 10)
	hint.add_theme_color_override("font_color", Color(0.7, 0.75, 0.85, 0.75))
	vb.add_child(hint)
	vb.add_child(HSeparator.new())

	_scroll = ScrollContainer.new()
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_scroll.custom_minimum_size = Vector2(330, 0)
	vb.add_child(_scroll)

	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 5)
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_scroll.add_child(_list)

	_empty = Label.new()
	_empty.text = "（等待镇上有人开口 / 动念…）"
	_empty.add_theme_font_size_override("font_size", 12)
	_empty.add_theme_color_override("font_color", Color("8a93a0"))
	_list.add_child(_empty)

	add_child(_panel)
	_panel.visible = false

func set_skin_resolver(cb: Callable) -> void:
	_skin_of = cb

func toggle() -> void:
	_panel.visible = not _panel.visible
	if _panel.visible:
		_snap_to_bottom()

func is_open() -> bool:
	return _panel.visible

func close() -> void:
	_panel.visible = false

## 追加一条记录：kind 见 KIND_STYLE；who 为空则不显示名字前缀
func add_entry(kind: String, who: String, text: String, stamp: String = "", char_id: String = "") -> void:
	if text.strip_edges() == "":
		return
	if _empty and is_instance_valid(_empty):
		_empty.queue_free()
		_empty = null
	# 记录是否原本贴着底（贴底才自动跟随，用户往上翻看历史时不打扰）
	var at_bottom := _is_at_bottom()

	var style: Array = KIND_STYLE.get(kind, KIND_STYLE["system"])
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 5)

	# 小头像（有 who 且能解析皮肤时）
	if char_id != "" and _skin_of.is_valid():
		var fp: String = CHAR_DIR + str(_skin_of.call(char_id)) + "/Faceset.png"
		if ResourceLoader.exists(fp):
			var face := TextureRect.new()
			face.custom_minimum_size = Vector2(18, 18)
			face.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
			face.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
			face.texture = load(fp)
			row.add_child(face)

	var lbl := RichTextLabel.new()
	lbl.bbcode_enabled = true
	lbl.fit_content = true
	lbl.scroll_active = false
	lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lbl.custom_minimum_size = Vector2(300, 0)
	lbl.add_theme_font_size_override("normal_font_size", 12)
	lbl.add_theme_font_size_override("bold_font_size", 12)   # 否则 [b]名字[/b] 会用主题默认 16px



	var col: Color = style[1]
	var head := ""
	if stamp != "":
		head += "[color=#6f7a8a]%s[/color] " % stamp
	head += style[0] + " "
	if who != "":
		head += "[color=#%s][b]%s[/b][/color] " % [col.to_html(false), _esc(who)]
	lbl.text = "%s[color=#%s]%s[/color]" % [head, col.lerp(Color.WHITE, 0.15).to_html(false), _esc(text)]
	row.add_child(lbl)

	_list.add_child(row)
	_count += 1
	# 超额裁掉最老的
	while _count > MAX_ENTRIES and _list.get_child_count() > 0:
		var oldest := _list.get_child(0)
		_list.remove_child(oldest)
		oldest.queue_free()
		_count -= 1

	if _panel.visible and at_bottom:
		_snap_to_bottom()

func _esc(s: String) -> String:
	return s.replace("[", "［").replace("]", "］")   # 防 bbcode 注入

func _is_at_bottom() -> bool:
	var vs := _scroll.get_v_scroll_bar()
	if vs == null:
		return true
	return vs.value >= vs.max_value - vs.page - 8.0

func _snap_to_bottom() -> void:
	await get_tree().process_frame
	var vs := _scroll.get_v_scroll_bar()
	if vs:
		_scroll.scroll_vertical = int(vs.max_value)
