extends CanvasLayer
## P4 — 叙事干预面板（JRPG 风）：塞纸条 / 流言 / 注入事件 / 推进导演。
## 走后端 HTTP（src/api/narrative-routes.ts），与 WS 同一个 3001 服务。
## N 键或右上角按钮开关；离线时可打开但发送禁用。

const MODES := [
	["note", "塞纸条", "让 TA 心里突然浮现一个念头…"],
	["rumor", "散布流言", "镇上开始流传一句话…"],
	["event", "注入事件", "让一件未解决的事发生…"],
	["nudge", "推进导演", "手动触发 LLM 导演做一次节奏检查"],
]

var base_url := "http://localhost:3001"

var _panel: PanelContainer
var _mode: OptionButton
var _char_row: HBoxContainer
var _char: OptionButton
var _text: TextEdit
var _hint_lbl: Label
var _send: Button
var _status: Label
var _http: HTTPRequest
var _chars: Array = []       # [[id, name], ...]
var _online := false
var _event_seq := 0

func _ready() -> void:
	layer = 5
	_http = HTTPRequest.new()
	_http.timeout = 15.0
	_http.request_completed.connect(_on_response)
	add_child(_http)

	_panel = PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.08, 0.18, 0.95)
	sb.border_color = Color("f5f0e8")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(3)
	sb.set_content_margin_all(12)
	_panel.add_theme_stylebox_override("panel", sb)
	# 靠左侧，不与右侧的详情面板抢位置
	_panel.offset_left = 12
	_panel.offset_right = 332
	_panel.offset_top = 56
	_panel.visible = false
	add_child(_panel)

	var vb := VBoxContainer.new()
	vb.add_theme_constant_override("separation", 8)
	_panel.add_child(vb)

	var title := Label.new()
	title.text = "叙事干预"
	title.add_theme_font_size_override("font_size", 16)
	title.add_theme_color_override("font_color", Color("ffd27a"))
	vb.add_child(title)

	_mode = OptionButton.new()
	for m in MODES:
		_mode.add_item(m[1])
	_mode.item_selected.connect(func(_i: int) -> void: _refresh_form())
	vb.add_child(_mode)

	_char_row = HBoxContainer.new()
	_char_row.add_theme_constant_override("separation", 6)
	vb.add_child(_char_row)
	var char_lbl := Label.new()
	char_lbl.text = "对象"
	char_lbl.add_theme_font_size_override("font_size", 12)
	_char_row.add_child(char_lbl)
	_char = OptionButton.new()
	_char.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_char_row.add_child(_char)

	_hint_lbl = Label.new()
	_hint_lbl.add_theme_font_size_override("font_size", 12)
	_hint_lbl.add_theme_color_override("font_color", Color(0.75, 0.78, 0.85))
	_hint_lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vb.add_child(_hint_lbl)

	_text = TextEdit.new()
	_text.custom_minimum_size = Vector2(0, 68)
	_text.add_theme_font_size_override("font_size", 14)
	_text.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	vb.add_child(_text)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	vb.add_child(row)
	_send = Button.new()
	_send.text = "发送"
	_send.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_send.pressed.connect(_on_send)
	row.add_child(_send)
	var close := Button.new()
	close.text = "关闭 (N)"
	close.pressed.connect(func() -> void: _panel.visible = false)
	row.add_child(close)

	_status = Label.new()
	_status.add_theme_font_size_override("font_size", 12)
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	vb.add_child(_status)

	_refresh_form()

func is_open() -> bool:
	return _panel.visible

func toggle() -> void:
	_panel.visible = not _panel.visible
	if _panel.visible:
		_refresh_form()

func close() -> void:
	_panel.visible = false

func set_online(online: bool) -> void:
	_online = online
	_refresh_form()

## chars = [[id, name], ...]（Main 在 snapshot/tick 时喂）
func set_characters(chars: Array) -> void:
	if chars == _chars:
		return
	_chars = chars.duplicate()
	var prev := _char.selected
	_char.clear()
	for c in _chars:
		_char.add_item(str(c[1]))
	if prev >= 0 and prev < _char.item_count:
		_char.select(prev)

func _mode_key() -> String:
	return MODES[_mode.selected][0]

func _refresh_form() -> void:
	var key := _mode_key()
	_hint_lbl.text = MODES[_mode.selected][2]
	_char_row.visible = key in ["note", "rumor"]
	_text.visible = key != "nudge"
	_send.disabled = not _online
	_status.text = "" if _online else "（未连接后端，仅预览）"

func _on_send() -> void:
	var key := _mode_key()
	var body := {}
	var path := ""
	var content := _text.text.strip_edges()
	match key:
		"note":
			if _char.selected < 0 or content == "":
				_status.text = "要选对象、写内容"
				return
			path = "/api/narrative/inject-observation"
			body = {"observerId": _chars[_char.selected][0], "summary": content}
		"rumor":
			if content == "":
				_status.text = "流言内容不能为空"
				return
			path = "/api/narrative/inject-rumor"
			body = {"content": content}
			if _char.selected >= 0:
				body["sourceCharId"] = _chars[_char.selected][0]
		"event":
			if content == "":
				_status.text = "事件描述不能为空"
				return
			_event_seq += 1
			path = "/api/narrative/inject-event"
			body = {"id": "player_evt_%d_%d" % [Time.get_unix_time_from_system(), _event_seq],
				"summary": content, "visibleTo": "*"}
		"nudge":
			path = "/api/narrative/nudge"
			body = {}
	_send.disabled = true
	_status.text = "发送中…"
	var err := _http.request(base_url + path,
		["Content-Type: application/json"], HTTPClient.METHOD_POST, JSON.stringify(body))
	if err != OK:
		_status.text = "请求失败 (err=%d)" % err
		_send.disabled = not _online

func _on_response(_result: int, code: int, _headers: PackedStringArray, resp: PackedByteArray) -> void:
	_send.disabled = not _online
	if code == 200:
		_status.text = "✓ 已生效（下个 tick 起作用）"
		if _mode_key() != "nudge":
			_text.text = ""
	else:
		var msg := resp.get_string_from_utf8().substr(0, 120)
		_status.text = "后端拒绝 (%d)：%s" % [code, msg]
